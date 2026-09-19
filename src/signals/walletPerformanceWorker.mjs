import { env } from '../config/env.mjs';
import { AppSettings } from '../storage/appSettings.mjs';

const PERFORMANCE_KEY = 'wallet_performance_v2';
const OUTCOME_KEY = 'smart_signal_outcomes_v2';
const OUTCOME_CHECKPOINT_MINUTES = [1, 5, 15, 30, 60];
const OUTCOME_GRACE_MINUTES = 2;
const finite = (value, fallback = 0) => Number.isFinite(Number(value)) ? Number(value) : fallback;
const clamp = (value, min, max) => Math.max(min, Math.min(max, value));
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, Math.max(0, ms)));
const CHAIN = { arc: 'arc', solana: 'solana', sol: 'solana', bsc: 'bsc', bnb: 'bsc', robinhood: 'robinhood', rh: 'robinhood' };

class Store {
  constructor() {
    this.base = String(env.supabaseUrl || '').replace(/\/$/, '');
    this.key = String(env.supabaseSecretKey || '');
  }
  get enabled() { return Boolean(this.base && this.key); }
  async request(path, { method = 'GET', body, prefer } = {}) {
    if (!this.enabled) return null;
    const response = await fetch(`${this.base}/rest/v1/${path}`, {
      method,
      headers: {
        apikey: this.key, Authorization: `Bearer ${this.key}`, accept: 'application/json',
        ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
        ...(prefer ? { Prefer: prefer } : {})
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {})
    });
    if (!response.ok) throw new Error(`Supabase ${method} ${path} HTTP ${response.status}`);
    const text = await response.text().catch(() => '');
    return text ? JSON.parse(text) : null;
  }
  tokens() {
    return this.request('tokens?select=id,chain,address,symbol,initial_price_usd,highest_price_usd,status,last_seen_at&initial_price_usd=not.is.null&order=last_seen_at.desc&limit=120');
  }
  signals() {
    return this.request('signals?select=id,created_at,entry_score,risk_score,reason,token_id&order=created_at.desc&limit=400');
  }
  updateToken(id, body) {
    return this.request(`tokens?id=eq.${encodeURIComponent(id)}`, { method: 'PATCH', body, prefer: 'return=minimal' });
  }
}

async function marketPrice(chain, address) {
  const dex = CHAIN[String(chain || '').toLowerCase()];
  if (!dex || !address) return 0;
  const response = await fetch(`https://api.dexscreener.com/tokens/v1/${encodeURIComponent(dex)}/${encodeURIComponent(address)}`, { headers: { accept: 'application/json' } });
  if (!response.ok) return 0;
  const rows = await response.json().catch(() => []);
  const pairs = (Array.isArray(rows) ? rows : []).filter((r) => String(r?.chainId || '').toLowerCase() === dex);
  const pair = pairs.sort((a, b) => finite(b?.liquidity?.usd) - finite(a?.liquidity?.usd))[0] || rows?.[0];
  return finite(pair?.priceUsd);
}

function normalizeWalletAddress(chain, address) {
  const value = String(address || '').trim();
  return chain === 'solana' || chain === 'sol' ? value : value.toLowerCase();
}

function walletFromSignal(signal, chain) {
  const wallets = Array.isArray(signal?.reason?.wallets) ? signal.reason.wallets : [];
  return wallets.map((w) => {
    const network = String(w?.network || signal?.reason?.network || chain || '').toLowerCase();
    const address = normalizeWalletAddress(network, w?.address);
    return { network, address, label: String(w?.label || ''), paidUsd: finite(w?.paid_usd) };
  }).filter((w) => w.address);
}

export function outcomeCheckpointDue(ageMinutes, checkpointMinutes, {
  graceMinutes = OUTCOME_GRACE_MINUTES
} = {}) {
  const age = finite(ageMinutes, -1);
  const checkpoint = finite(checkpointMinutes, -1);
  const grace = Math.max(0.25, finite(graceMinutes, OUTCOME_GRACE_MINUTES));
  return age >= checkpoint && age <= checkpoint + grace;
}

export function measuredOutcomeRoi(outcome) {
  const checkpoints = outcome?.checkpoints && typeof outcome.checkpoints === 'object'
    ? Object.values(outcome.checkpoints)
    : [];
  const values = checkpoints.map((value) => Number(value)).filter(Number.isFinite);
  return values.length ? Math.max(...values) : null;
}

function signalOutcomeKey(signal) {
  return String(signal?.id || `${signal?.token_id || ''}:${signal?.created_at || ''}`);
}

export function summarizeWalletPerformance(signals, tokenById, now = Date.now(), outcomes = {}) {
  const map = new Map();
  const seenWalletToken = new Set();
  for (const signal of signals) {
    const token = tokenById.get(String(signal?.token_id || ''));
    if (!token) continue;
    const chain = String(token.chain || signal?.reason?.network || '').toLowerCase();
    const detectedEntry = finite(signal?.reason?.detected_price_usd);
    const entry = detectedEntry > 0 ? detectedEntry : finite(token.initial_price_usd);
    const high = finite(token.highest_price_usd, entry);
    if (!(entry > 0 && high > 0)) continue;
    const signalAtMs = Date.parse(String(signal?.created_at || '')) || 0;
    const ageMs = signalAtMs > 0 ? Math.max(0, finite(now) - signalAtMs) : Number.POSITIVE_INFINITY;
    const outcome = outcomes?.[signalOutcomeKey(signal)] || null;
    const measuredRoi = measuredOutcomeRoi(outcome);
    const legacyPeakRoi = (high / entry - 1) * 100;
    const peakRoi = measuredRoi == null ? legacyPeakRoi : measuredRoi;
    const hasMeasuredRecentOutcome = measuredRoi != null;
    const isSmartSignal = String(signal?.reason?.origin || '') === 'auto-smart-wallet-discovery';

    for (const w of walletFromSignal(signal, chain)) {
      const key = `${w.network || chain}:${w.address}`;
      const evidenceKey = `${key}:${String(signal?.token_id || token.address || '')}`;
      if (seenWalletToken.has(evidenceKey)) continue;
      seenWalletToken.add(evidenceKey);

      const row = map.get(key) || {
        key, network: w.network || chain, address: w.address, label: w.label,
        samples: 0, peakRoiSum: 0, hit25: 0, hit50: 0, hit100: 0,
        samples24h: 0, peakRoiSum24h: 0, hit50_24h: 0,
        samples7d: 0, peakRoiSum7d: 0, hit50_7d: 0,
        paidUsd: 0, entryScoreSum: 0, riskSum: 0,
        lastSignalAtMs: 0, lastSignalAt: null, lastTokenAddress: '', lastTokenSymbol: '',
        lastDetectedPriceUsd: 0, lastTxHash: ''
      };
      row.label ||= w.label;
      row.samples += 1;
      row.peakRoiSum += peakRoi;
      row.hit25 += peakRoi >= 25 ? 1 : 0;
      row.hit50 += peakRoi >= 50 ? 1 : 0;
      row.hit100 += peakRoi >= 100 ? 1 : 0;
      // Recent smart-wallet ranking is based on measured post-entry checkpoints
      // only. This avoids crediting a wallet for a token high that happened
      // before the wallet's detected entry.
      const recentOutcomeEligible = !isSmartSignal || hasMeasuredRecentOutcome;
      if (ageMs <= 24 * 60 * 60_000 && recentOutcomeEligible) {
        row.samples24h += 1;
        row.peakRoiSum24h += peakRoi;
        row.hit50_24h += peakRoi >= 50 ? 1 : 0;
      }
      if (ageMs <= 7 * 24 * 60 * 60_000 && recentOutcomeEligible) {
        row.samples7d += 1;
        row.peakRoiSum7d += peakRoi;
        row.hit50_7d += peakRoi >= 50 ? 1 : 0;
      }
      row.paidUsd += w.paidUsd;
      row.entryScoreSum += finite(signal.entry_score);
      row.riskSum += finite(signal.risk_score);
      if (signalAtMs >= finite(row.lastSignalAtMs)) {
        row.lastSignalAtMs = signalAtMs;
        row.lastSignalAt = signal?.created_at || null;
        row.lastTokenAddress = String(token?.address || '');
        row.lastTokenSymbol = String(token?.symbol || 'TOKEN');
        row.lastDetectedPriceUsd = entry;
        row.lastTxHash = String(signal?.reason?.tx || '');
      }
      map.set(key, row);
    }
  }

  return [...map.values()].map((row) => {
    const avgPeakRoi = row.samples ? row.peakRoiSum / row.samples : 0;
    const hit25Rate = row.samples ? row.hit25 / row.samples * 100 : 0;
    const hit50Rate = row.samples ? row.hit50 / row.samples * 100 : 0;
    const hit100Rate = row.samples ? row.hit100 / row.samples * 100 : 0;
    const avgEntryScore = row.samples ? row.entryScoreSum / row.samples : 0;
    const avgRisk = row.samples ? row.riskSum / row.samples : 50;
    const avgPeakRoi24h = row.samples24h ? row.peakRoiSum24h / row.samples24h : 0;
    const avgPeakRoi7d = row.samples7d ? row.peakRoiSum7d / row.samples7d : 0;
    const hit50Rate24h = row.samples24h ? row.hit50_24h / row.samples24h * 100 : 0;
    const hit50Rate7d = row.samples7d ? row.hit50_7d / row.samples7d * 100 : 0;
    const recentScore24h = row.samples24h ? clamp(Math.round(
      Math.min(35, row.samples24h * 8) + Math.min(40, hit50Rate24h * 0.4) + Math.min(25, Math.max(0, avgPeakRoi24h) * 0.08)
    ), 0, 100) : 0;
    const recentScore7d = row.samples7d ? clamp(Math.round(
      Math.min(30, row.samples7d * 5) + Math.min(40, hit50Rate7d * 0.4) + Math.min(30, Math.max(0, avgPeakRoi7d) * 0.08)
    ), 0, 100) : 0;
    const performanceScore = clamp(Math.round(
      Math.min(20, row.samples * 3) + Math.min(25, hit25Rate * 0.25) + Math.min(20, hit50Rate * 0.25)
      + Math.min(15, hit100Rate * 0.2) + Math.min(10, Math.max(0, avgPeakRoi) * 0.05)
      + avgEntryScore * 0.15 - avgRisk * 0.08
      + (row.samples24h ? (recentScore24h - 50) * 0.12 : 0)
    ), 0, 100);
    return {
      ...row, avgPeakRoi, hit25Rate, hit50Rate, hit100Rate, avgEntryScore, avgRisk, performanceScore,
      avgPeakRoi24h, avgPeakRoi7d, hit50Rate24h, hit50Rate7d, recentScore24h, recentScore7d
    };
  }).sort((a, b) =>
    finite(b.recentScore24h) - finite(a.recentScore24h)
    || finite(b.recentScore7d) - finite(a.recentScore7d)
    || b.performanceScore - a.performanceScore
    || b.samples - a.samples
  );
}

export class WalletPerformanceWorker {
  constructor() {
    this.store = new Store();
    this.settings = new AppSettings(env.supabaseUrl, env.supabaseSecretKey);
    this.running = false;
    this.cursor = 0;
    this.intervalMs = Math.max(30_000, finite(process.env.WALLET_PERFORMANCE_INTERVAL_MS, 30_000));
  }
  async cycle() {
    if (this.running || !this.store.enabled) return;
    this.running = true;
    try {
      const [tokens, signals] = await Promise.all([
        this.store.tokens().catch(() => []),
        this.store.signals().catch(() => [])
      ]);
      const tokenRows = Array.isArray(tokens) ? tokens : [];
      const signalRows = Array.isArray(signals) ? signals : [];
      const tokenById = new Map(tokenRows.map((t) => [String(t.id), t]));
      const candidates = tokenRows.filter((t) => t?.address && t?.chain);
      const now = Date.now();

      const recentTokenIds = [...new Set(
        signalRows
          .filter((row) => now - (Date.parse(String(row?.created_at || '')) || 0) <= 65 * 60_000)
          .map((row) => String(row?.token_id || ''))
          .filter(Boolean)
      )];
      const prioritized = [];
      for (const id of recentTokenIds) {
        const token = tokenById.get(id);
        if (token && !prioritized.includes(token)) prioritized.push(token);
        if (prioritized.length >= 12) break;
      }
      const targetBatch = Math.min(18, candidates.length);
      for (let i = 0; prioritized.length < targetBatch && i < candidates.length; i += 1) {
        const token = candidates[(this.cursor + i) % candidates.length];
        if (!prioritized.includes(token)) prioritized.push(token);
      }

      const priceByTokenId = new Map();
      for (const token of prioritized) {
        const price = await marketPrice(token.chain, token.address).catch(() => 0);
        if (price > 0) {
          priceByTokenId.set(String(token.id), price);
          const high = Math.max(finite(token.highest_price_usd), price);
          if (high > finite(token.highest_price_usd)) {
            token.highest_price_usd = high;
            await this.store.updateToken(token.id, { highest_price_usd: high, last_seen_at: new Date().toISOString() }).catch(() => {});
          }
        }
        await sleep(100);
      }
      if (candidates.length) this.cursor = (this.cursor + Math.max(1, targetBatch)) % candidates.length;

      let outcomes = {};
      if (this.settings.enabled) {
        const raw = await this.settings.get(OUTCOME_KEY).catch(() => null);
        try { outcomes = raw ? JSON.parse(String(raw)) : {}; } catch { outcomes = {}; }
      }
      if (!outcomes || typeof outcomes !== 'object' || Array.isArray(outcomes)) outcomes = {};
      let outcomeUpdates = 0;

      for (const signal of signalRows) {
        const token = tokenById.get(String(signal?.token_id || ''));
        const price = priceByTokenId.get(String(signal?.token_id || ''));
        const signalAt = Date.parse(String(signal?.created_at || '')) || 0;
        const detectedEntry = finite(signal?.reason?.detected_price_usd);
        const entry = detectedEntry > 0 ? detectedEntry : finite(token?.initial_price_usd);
        if (!(signalAt > 0 && entry > 0 && price > 0)) continue;
        const ageMin = Math.max(0, (now - signalAt) / 60_000);
        const key = signalOutcomeKey(signal);
        const row = outcomes[key] && typeof outcomes[key] === 'object' ? outcomes[key] : {
          signalId: signal?.id || null,
          tokenId: signal?.token_id || null,
          entryAt: signal?.created_at || null,
          entryPriceUsd: entry,
          checkpoints: {},
          sampledAt: {}
        };
        row.checkpoints ||= {};
        row.sampledAt ||= {};
        for (const minute of OUTCOME_CHECKPOINT_MINUTES) {
          const cp = String(minute);
          if (row.checkpoints[cp] == null && outcomeCheckpointDue(ageMin, minute)) {
            row.checkpoints[cp] = Number(((price / entry - 1) * 100).toFixed(2));
            row.sampledAt[cp] = {
              at: new Date(now).toISOString(),
              ageMinutes: Number(ageMin.toFixed(2))
            };
            outcomeUpdates += 1;
          }
        }
        row.lastPriceUsd = price;
        row.updatedAt = new Date().toISOString();
        outcomes[key] = row;
      }

      const performance = summarizeWalletPerformance(signalRows, tokenById, now, outcomes);
      if (this.settings.enabled) {
        await this.settings.set(PERFORMANCE_KEY, JSON.stringify({
          updatedAt: new Date().toISOString(),
          wallets: performance.slice(0, 100)
        })).catch(() => {});
        const trimmed = Object.fromEntries(
          Object.entries(outcomes)
            .sort((a, b) => Date.parse(String(b[1]?.updatedAt || b[1]?.entryAt || '')) - Date.parse(String(a[1]?.updatedAt || a[1]?.entryAt || '')))
            .slice(0, 300)
        );
        await this.settings.set(OUTCOME_KEY, JSON.stringify(trimmed)).catch(() => {});
      }
      console.log(`[wallet-performance] tokens=${candidates.length} signals=${signalRows.length} wallets=${performance.length} outcomes+=${outcomeUpdates}`);
    } catch (error) {
      console.warn('[wallet-performance]', String(error?.message ?? error));
    } finally { this.running = false; }
  }
  async start() {
    if (!this.store.enabled) {
      console.warn('[wallet-performance] disabled — Supabase not configured');
      return false;
    }
    await this.cycle();
    setInterval(() => void this.cycle(), this.intervalMs).unref?.();
    console.log(`SUMMECA WALLET PERFORMANCE: peak-outcome tracker interval=${this.intervalMs}ms`);
    return true;
  }
}

let singleton = null;
export async function startWalletPerformanceWorker() {
  if (!singleton) singleton = new WalletPerformanceWorker();
  return singleton.start();
}
