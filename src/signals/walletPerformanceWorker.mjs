import { env } from '../config/env.mjs';
import { AppSettings } from '../storage/appSettings.mjs';

const PERFORMANCE_KEY = 'wallet_performance_v2';
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
    return this.request('signals?select=created_at,entry_score,risk_score,reason,token_id&order=created_at.desc&limit=400');
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

export function summarizeWalletPerformance(signals, tokenById) {
  const map = new Map();
  for (const signal of signals) {
    const token = tokenById.get(String(signal?.token_id || ''));
    if (!token) continue;
    const chain = String(token.chain || signal?.reason?.network || '').toLowerCase();
    const entry = finite(token.initial_price_usd);
    const high = finite(token.highest_price_usd, entry);
    if (!(entry > 0 && high > 0)) continue;
    const peakRoi = (high / entry - 1) * 100;
    for (const w of walletFromSignal(signal, chain)) {
      const key = `${w.network || chain}:${w.address}`;
      const row = map.get(key) || { key, network: w.network || chain, address: w.address, label: w.label, samples: 0, peakRoiSum: 0, hit25: 0, hit50: 0, hit100: 0, paidUsd: 0, entryScoreSum: 0, riskSum: 0 };
      row.label ||= w.label;
      row.samples += 1;
      row.peakRoiSum += peakRoi;
      row.hit25 += peakRoi >= 25 ? 1 : 0;
      row.hit50 += peakRoi >= 50 ? 1 : 0;
      row.hit100 += peakRoi >= 100 ? 1 : 0;
      row.paidUsd += w.paidUsd;
      row.entryScoreSum += finite(signal.entry_score);
      row.riskSum += finite(signal.risk_score);
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
    const performanceScore = clamp(Math.round(
      Math.min(20, row.samples * 3) + Math.min(25, hit25Rate * 0.25) + Math.min(20, hit50Rate * 0.25) +
      Math.min(15, hit100Rate * 0.2) + Math.min(10, Math.max(0, avgPeakRoi) * 0.05) + avgEntryScore * 0.15 - avgRisk * 0.08
    ), 0, 100);
    return { ...row, avgPeakRoi, hit25Rate, hit50Rate, hit100Rate, avgEntryScore, avgRisk, performanceScore };
  }).sort((a, b) => b.performanceScore - a.performanceScore || b.samples - a.samples);
}

export class WalletPerformanceWorker {
  constructor() {
    this.store = new Store();
    this.settings = new AppSettings(env.supabaseUrl, env.supabaseSecretKey);
    this.running = false;
    this.cursor = 0;
    this.intervalMs = Math.max(30_000, finite(process.env.WALLET_PERFORMANCE_INTERVAL_MS, 60_000));
  }
  async cycle() {
    if (this.running || !this.store.enabled) return;
    this.running = true;
    try {
      const tokens = await this.store.tokens().catch(() => []);
      const candidates = (Array.isArray(tokens) ? tokens : []).filter((t) => t?.address && t?.chain);
      if (candidates.length) {
        const batchSize = Math.min(12, candidates.length);
        for (let i = 0; i < batchSize; i += 1) {
          const token = candidates[(this.cursor + i) % candidates.length];
          const price = await marketPrice(token.chain, token.address).catch(() => 0);
          if (price > 0) {
            const high = Math.max(finite(token.highest_price_usd), price);
            if (high > finite(token.highest_price_usd)) {
              token.highest_price_usd = high;
              await this.store.updateToken(token.id, { highest_price_usd: high, last_seen_at: new Date().toISOString() }).catch(() => {});
            }
          }
          await sleep(120);
        }
        this.cursor = (this.cursor + batchSize) % candidates.length;
      }
      const signals = await this.store.signals().catch(() => []);
      const tokenById = new Map((Array.isArray(tokens) ? tokens : []).map((t) => [String(t.id), t]));
      const performance = summarizeWalletPerformance(Array.isArray(signals) ? signals : [], tokenById);
      if (this.settings.enabled) await this.settings.set(PERFORMANCE_KEY, JSON.stringify({ updatedAt: new Date().toISOString(), wallets: performance.slice(0, 100) })).catch(() => {});
      console.log(`[wallet-performance] tokens=${candidates.length} signals=${Array.isArray(signals) ? signals.length : 0} wallets=${performance.length}`);
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
