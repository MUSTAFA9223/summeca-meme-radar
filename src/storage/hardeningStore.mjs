import { env } from '../config/env.mjs';

const isoNow = () => new Date().toISOString();

export class HardeningStore {
  constructor(url = env.supabaseUrl, secretKey = env.supabaseSecretKey) {
    this.url = String(url ?? '').replace(/\/$/, '');
    this.secretKey = String(secretKey ?? '');
  }

  get enabled() {
    return Boolean(this.url && this.secretKey);
  }

  async request(path, { method = 'GET', body, prefer } = {}) {
    if (!this.enabled) throw new Error('Hardening store is not configured');
    const response = await fetch(`${this.url}/rest/v1/${path}`, {
      method,
      headers: {
        apikey: this.secretKey,
        Authorization: `Bearer ${this.secretKey}`,
        accept: 'application/json',
        ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
        ...(prefer ? { Prefer: prefer } : {})
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {})
    });
    const text = await response.text().catch(() => '');
    if (!response.ok) {
      throw new Error(`Supabase hardening ${method} ${path} HTTP ${response.status}${text ? `: ${text.slice(0, 180)}` : ''}`);
    }
    return text ? JSON.parse(text) : null;
  }

  async loadCheckpoint(key) {
    if (!this.enabled) return null;
    const rows = await this.request(`runtime_checkpoints?select=value,updated_at&key=eq.${encodeURIComponent(key)}&limit=1`);
    return Array.isArray(rows) && rows[0] ? rows[0] : null;
  }

  async saveCheckpoint(key, value) {
    if (!this.enabled) return false;
    await this.request('runtime_checkpoints?on_conflict=key', {
      method: 'POST',
      prefer: 'resolution=merge-duplicates,return=minimal',
      body: { key, value, updated_at: isoNow() }
    });
    return true;
  }

  async createAudit(row) {
    const rows = await this.request('execution_audit', {
      method: 'POST',
      prefer: 'return=representation',
      body: { ...row, created_at: row.created_at || isoNow(), updated_at: isoNow() }
    });
    return Array.isArray(rows) ? rows[0] ?? null : null;
  }

  async getAudit(requestId) {
    const rows = await this.request(`execution_audit?select=*&request_id=eq.${encodeURIComponent(requestId)}&limit=1`);
    return Array.isArray(rows) ? rows[0] ?? null : null;
  }

  async findActiveIntent(network, tokenAddress, side, sinceIso) {
    const path = [
      'execution_audit?select=*',
      `network=eq.${encodeURIComponent(network)}`,
      `token_address=eq.${encodeURIComponent(tokenAddress)}`,
      `side=eq.${encodeURIComponent(side)}`,
      'status=in.(prepared,awaiting_confirm,confirmed,broadcasting)',
      `created_at=gte.${encodeURIComponent(sinceIso)}`,
      'order=created_at.desc',
      'limit=1'
    ].join('&');
    const rows = await this.request(path);
    return Array.isArray(rows) ? rows[0] ?? null : null;
  }

  async transitionAudit(requestId, expectedStatus, nextStatus, patch = {}) {
    const rows = await this.request(`execution_audit?request_id=eq.${encodeURIComponent(requestId)}&status=eq.${encodeURIComponent(expectedStatus)}`, {
      method: 'PATCH',
      prefer: 'return=representation',
      body: { ...patch, status: nextStatus, updated_at: isoNow() }
    });
    return Array.isArray(rows) ? rows[0] ?? null : null;
  }

  async updateAudit(requestId, patch = {}) {
    const rows = await this.request(`execution_audit?request_id=eq.${encodeURIComponent(requestId)}`, {
      method: 'PATCH',
      prefer: 'return=representation',
      body: { ...patch, updated_at: isoNow() }
    });
    return Array.isArray(rows) ? rows[0] ?? null : null;
  }

  async recentAudits(limit = 8) {
    const safeLimit = Math.max(1, Math.min(20, Number(limit) || 8));
    const rows = await this.request(`execution_audit?select=request_id,created_at,network,token_address,side,amount_native,amount_usd,status,tx_hash,error&order=created_at.desc&limit=${safeLimit}`);
    return Array.isArray(rows) ? rows : [];
  }

  async upsertSolanaToken(address, metadata = {}) {
    const rows = await this.request('tokens?on_conflict=address', {
      method: 'POST',
      prefer: 'resolution=merge-duplicates,return=representation',
      body: {
        chain: 'solana',
        address: String(address),
        symbol: metadata.symbol || null,
        name: metadata.name || metadata.symbol || null,
        source: metadata.source || 'manual-confirm-terminal',
        last_seen_at: isoNow(),
        initial_price_usd: metadata.priceUsd || null,
        highest_price_usd: metadata.priceUsd || null,
        status: 'tracking'
      }
    });
    return Array.isArray(rows) ? rows[0] ?? null : null;
  }

  async insertLiveTrade(row) {
    const rows = await this.request('live_trades', {
      method: 'POST',
      prefer: 'return=representation',
      body: row
    });
    return Array.isArray(rows) ? rows[0] ?? null : null;
  }

  async findOpenLiveTrades(tokenId, walletAddress = '') {
    const parts = [
      'live_trades?select=*',
      `token_id=eq.${encodeURIComponent(tokenId)}`
    ];
    if (walletAddress) parts.push(`wallet_address=eq.${encodeURIComponent(walletAddress)}`);
    parts.push('status=in.(pending,open)', 'order=opened_at.asc');
    const rows = await this.request(parts.join('&'));
    return Array.isArray(rows) ? rows : [];
  }

  async openLiveTradesForProtection(walletAddress = '') {
    const parts = [
      'live_trades?select=*,tokens(address,symbol,name,source,listed_at)'
    ];
    if (walletAddress) parts.push(`wallet_address=eq.${encodeURIComponent(walletAddress)}`);
    parts.push('status=in.(open,closing)', 'order=opened_at.asc');
    const rows = await this.request(parts.join('&'));
    return Array.isArray(rows) ? rows : [];
  }

  async claimLiveTradeForSell(id, requestId, reason) {
    const rows = await this.request(
      `live_trades?id=eq.${encodeURIComponent(id)}&status=eq.open&sell_lock_request_id=is.null`,
      {
        method: 'PATCH',
        prefer: 'return=representation',
        body: {
          status: 'closing',
          sell_lock_request_id: String(requestId),
          sell_broadcast_at: null,
          exit_reason: String(reason ?? 'protection-exit'),
          updated_at: isoNow()
        }
      }
    );
    return Array.isArray(rows) ? rows[0] ?? null : null;
  }

  async releaseLiveTradeSell(id, requestId, patch = {}) {
    const rows = await this.request(
      `live_trades?id=eq.${encodeURIComponent(id)}&status=eq.closing&sell_lock_request_id=eq.${encodeURIComponent(requestId)}`,
      {
        method: 'PATCH',
        prefer: 'return=representation',
        body: {
          ...patch,
          status: 'open',
          sell_lock_request_id: null,
          sell_broadcast_at: null,
          updated_at: isoNow()
        }
      }
    );
    return Array.isArray(rows) ? rows[0] ?? null : null;
  }

  async latestRiskSignal(tokenId, sinceIso) {
    const path = [
      'signals?select=id,created_at,reason',
      `token_id=eq.${encodeURIComponent(tokenId)}`,
      'signal_type=eq.risk_reject',
      `created_at=gte.${encodeURIComponent(sinceIso)}`,
      'order=created_at.desc',
      'limit=1'
    ].join('&');
    const rows = await this.request(path);
    return Array.isArray(rows) ? rows[0] ?? null : null;
  }

  async appendAuditEvent(requestId, event) {
    const row = await this.getAudit(requestId);
    if (!row) return null;
    const prior = Array.isArray(row.payload?.events) ? row.payload.events : [];
    const events = [...prior.slice(-29), { at: isoNow(), ...event }];
    return this.updateAudit(requestId, { payload: { ...(row.payload || {}), events } });
  }

  async findLiveTradeByEntryTx(entryTx, walletAddress) {
    const path = [
      'live_trades?select=*',
      `entry_tx=eq.${encodeURIComponent(entryTx)}`,
      `wallet_address=eq.${encodeURIComponent(walletAddress)}`,
      'limit=1'
    ].join('&');
    const rows = await this.request(path);
    return Array.isArray(rows) ? rows[0] ?? null : null;
  }

  async recentSucceededManualBuys(sinceIso, limit = 50) {
    const safeLimit = Math.max(1, Math.min(100, Number(limit) || 50));
    const path = [
      'execution_audit?select=*',
      'network=eq.sol',
      'side=eq.buy',
      'status=eq.succeeded',
      `created_at=gte.${encodeURIComponent(sinceIso)}`,
      'order=created_at.desc',
      `limit=${safeLimit}`
    ].join('&');
    const rows = await this.request(path);
    return Array.isArray(rows) ? rows : [];
  }

  async updateLiveTrade(id, patch = {}) {
    const rows = await this.request(`live_trades?id=eq.${encodeURIComponent(id)}`, {
      method: 'PATCH',
      prefer: 'return=representation',
      body: { ...patch, updated_at: isoNow() }
    });
    return Array.isArray(rows) ? rows[0] ?? null : null;
  }
}
