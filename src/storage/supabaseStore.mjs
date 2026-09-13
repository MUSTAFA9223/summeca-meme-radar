const iso = (value) => {
  if (!value) return null;
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
};

const finite = (value) => Number.isFinite(Number(value)) ? Number(value) : null;

export class SupabaseStore {
  #tradeIds = new Map();

  constructor(url, secretKey) {
    this.url = String(url ?? '').replace(/\/$/, '');
    this.secretKey = secretKey ?? '';
  }

  get enabled() {
    return Boolean(this.url && this.secretKey);
  }

  async #request(path, { method = 'GET', body, prefer, headers = {} } = {}) {
    if (!this.enabled) throw new Error('Supabase store is not configured');
    const response = await fetch(`${this.url}/rest/v1/${path}`, {
      method,
      headers: {
        apikey: this.secretKey,
        accept: 'application/json',
        ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
        ...(prefer ? { Prefer: prefer } : {}),
        ...headers
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {})
    });
    if (!response.ok) {
      const text = await response.text().catch(() => '');
      throw new Error(`Supabase ${method} ${path} HTTP ${response.status}${text ? `: ${text.slice(0, 240)}` : ''}`);
    }
    if (response.status === 204) return null;
    const text = await response.text();
    return text ? JSON.parse(text) : null;
  }

  async ensureToken(snapshot) {
    const address = String(snapshot.address ?? '');
    if (!address) throw new Error('Token address is required');

    await this.#request('tokens?on_conflict=address', {
      method: 'POST',
      prefer: 'resolution=ignore-duplicates,return=minimal',
      body: {
        address,
        symbol: snapshot.symbol ?? null,
        name: snapshot.name ?? null,
        source: snapshot.source ?? null,
        listed_at: iso(snapshot.listedAt),
        first_seen_at: iso(snapshot.observedAt) ?? new Date().toISOString(),
        last_seen_at: iso(snapshot.observedAt) ?? new Date().toISOString(),
        initial_price_usd: finite(snapshot.priceUsd),
        initial_liquidity_usd: finite(snapshot.liquidityUsd)
      }
    });

    await this.#request(`tokens?address=eq.${encodeURIComponent(address)}`, {
      method: 'PATCH',
      prefer: 'return=minimal',
      body: {
        symbol: snapshot.symbol ?? null,
        name: snapshot.name ?? null,
        source: snapshot.source ?? null,
        last_seen_at: iso(snapshot.observedAt) ?? new Date().toISOString()
      }
    });

    const rows = await this.#request(`tokens?select=id,address&address=eq.${encodeURIComponent(address)}&limit=1`);
    const token = Array.isArray(rows) ? rows[0] : null;
    if (!token?.id) throw new Error(`Token row not found after upsert: ${address}`);
    return token.id;
  }

  async saveSnapshot(snapshot, scores) {
    if (!this.enabled) return null;
    const tokenId = await this.ensureToken(snapshot);
    const rows = await this.#request('snapshots', {
      method: 'POST',
      prefer: 'return=representation',
      body: {
        token_id: tokenId,
        observed_at: iso(snapshot.observedAt) ?? new Date().toISOString(),
        price_usd: finite(snapshot.priceUsd),
        liquidity_usd: finite(snapshot.liquidityUsd),
        market_cap_usd: finite(snapshot.marketCapUsd),
        holder_count: finite(snapshot.holderCount),
        buys_30s: finite(snapshot.buys30s),
        sells_30s: finite(snapshot.sells30s),
        buy_volume_30s_usd: finite(snapshot.buyVolume30sUsd),
        sell_volume_30s_usd: finite(snapshot.sellVolume30sUsd),
        unique_buyers_30s: finite(snapshot.uniqueBuyers30s),
        buyer_acceleration: finite(snapshot.buyerAcceleration),
        volume_acceleration: finite(snapshot.volumeAcceleration),
        top10_holder_pct: finite(snapshot.top10HolderPct),
        creator_pct: finite(snapshot.creatorPct),
        honeypot: typeof snapshot.honeypot === 'boolean' ? snapshot.honeypot : null,
        mint_authority_disabled: typeof snapshot.mintAuthorityDisabled === 'boolean' ? snapshot.mintAuthorityDisabled : null,
        freeze_authority_disabled: typeof snapshot.freezeAuthorityDisabled === 'boolean' ? snapshot.freezeAuthorityDisabled : null,
        entry_score: finite(scores?.entry),
        moon_score: finite(scores?.moon),
        risk_score: finite(scores?.risk),
        raw: {
          source: snapshot.source ?? null,
          blockers: scores?.blockers ?? []
        }
      }
    });
    return { tokenId, snapshotId: Array.isArray(rows) ? rows[0]?.id ?? null : null };
  }

  async saveSignal({ tokenId, snapshotId = null, type, scores, reason = {} }) {
    if (!this.enabled || !tokenId) return null;
    return this.#request('signals', {
      method: 'POST',
      prefer: 'return=minimal',
      body: {
        token_id: tokenId,
        snapshot_id: snapshotId,
        signal_type: type,
        entry_score: finite(scores?.entry),
        moon_score: finite(scores?.moon),
        risk_score: finite(scores?.risk),
        reason
      }
    });
  }

  async openPaperTrade(snapshot, scores, position, tokenId) {
    if (!this.enabled || !position || !tokenId) return null;
    const rows = await this.#request('paper_trades', {
      method: 'POST',
      prefer: 'return=representation',
      body: {
        token_id: tokenId,
        status: 'open',
        opened_at: iso(position.entryAt) ?? new Date().toISOString(),
        entry_price_usd: finite(position.entryPriceUsd),
        size_usd: finite(position.usdSize),
        quantity: finite(position.quantity),
        peak_pnl_pct: finite(position.highWaterPnlPct) ?? 0,
        highest_price_usd: finite(position.highWaterPriceUsd),
        entry_score: finite(scores?.entry),
        moon_score: finite(scores?.moon),
        risk_score: finite(scores?.risk),
        metadata: { symbol: snapshot.symbol ?? null }
      }
    });
    const id = Array.isArray(rows) ? rows[0]?.id : null;
    if (id) this.#tradeIds.set(snapshot.address, id);
    return id;
  }

  async closePaperTrade(snapshot, scores, position) {
    if (!this.enabled || !position) return null;
    const id = this.#tradeIds.get(snapshot.address);
    if (!id) return null;
    const pnlUsd = finite(position.usdSize) != null && finite(position.pnlPct) != null
      ? Number(position.usdSize) * Number(position.pnlPct) / 100
      : null;
    await this.#request(`paper_trades?id=eq.${encodeURIComponent(id)}`, {
      method: 'PATCH',
      prefer: 'return=minimal',
      body: {
        status: 'closed',
        closed_at: iso(position.exitAt) ?? new Date().toISOString(),
        exit_price_usd: finite(position.exitPriceUsd),
        pnl_pct: finite(position.pnlPct),
        pnl_usd: pnlUsd,
        peak_pnl_pct: finite(position.highWaterPnlPct),
        highest_price_usd: finite(position.highWaterPriceUsd),
        peak_observed_at: iso(snapshot.observedAt),
        exit_reason: position.exitReason ?? null,
        moon_score: finite(scores?.moon),
        risk_score: finite(scores?.risk)
      }
    });
    this.#tradeIds.delete(snapshot.address);
    return id;
  }
}
