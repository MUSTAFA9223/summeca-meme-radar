import { env } from '../config/env.mjs';
import { HardeningStore } from '../storage/hardeningStore.mjs';
import { TradingTerminal, isTerminalAddress } from './tradingTerminal.mjs';
import { runLiveConfigSmoke } from '../trading/liveConfigSmoke.mjs';

const store = new HardeningStore();
const SOLANA_PUBLIC_RPC = 'https://api.mainnet-beta.solana.com';
const finite = (value, fallback = 0) => Number.isFinite(Number(value)) ? Number(value) : fallback;
const clamp = (value, min, max) => Math.max(min, Math.min(max, finite(value, min)));
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export function finalGuardLimits() {
  return {
    killSwitch: String(process.env.MANUAL_EXECUTION_KILL_SWITCH ?? 'false').toLowerCase() === 'true',
    maxTradesPerDay: Math.round(clamp(process.env.MANUAL_MAX_TRADES_PER_DAY ?? 6, 1, 25)),
    maxDailyBuySol: clamp(process.env.MANUAL_MAX_DAILY_BUY_SOL ?? 0.10, 0.005, 5),
    minLiquidityUsd: clamp(process.env.MANUAL_MIN_LIQUIDITY_USD ?? 8_000, 1_000, 250_000),
    maxMove5mPct: clamp(process.env.MANUAL_MAX_5M_MOVE_PCT ?? 50, 5, 250),
    maxTopUserPct: clamp(process.env.MANUAL_MAX_TOP_USER_PCT ?? 12, 2, 40),
    maxTop5Pct: clamp(process.env.MANUAL_MAX_TOP5_PCT ?? 35, 10, 80),
    maxTop10Pct: clamp(process.env.MANUAL_MAX_TOP10_PCT ?? 50, 15, 95),
    smokeOnStart: String(process.env.LIVE_READONLY_SMOKE_ON_START ?? 'false').toLowerCase() === 'true'
  };
}

async function fetchJson(url, options = {}, timeoutMs = 7_000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, { ...options, signal: controller.signal });
    const text = await response.text().catch(() => '');
    let body = null;
    try { body = text ? JSON.parse(text) : null; } catch { body = text; }
    if (!response.ok) throw new Error(body?.errorMessage ?? body?.error ?? `HTTP ${response.status}`);
    return body;
  } finally {
    clearTimeout(timer);
  }
}

async function solanaRpc(method, params = []) {
  const endpoints = [
    env.heliusApiKey ? `https://mainnet.helius-rpc.com/?api-key=${encodeURIComponent(env.heliusApiKey)}` : '',
    SOLANA_PUBLIC_RPC
  ].filter(Boolean);
  let lastError = null;
  for (let attempt = 0; attempt < endpoints.length; attempt += 1) {
    try {
      const body = await fetchJson(endpoints[attempt], {
        method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: `final-${Date.now()}-${attempt}`, method, params })
      });
      if (body?.error) throw new Error(body.error.message || `RPC ${body.error.code}`);
      return body?.result;
    } catch (error) {
      lastError = error;
      await sleep(150 * (attempt + 1));
    }
  }
  throw lastError || new Error(`Solana RPC ${method} failed`);
}

async function marketSnapshot(address) {
  const rows = await fetchJson(`https://api.dexscreener.com/tokens/v1/solana/${encodeURIComponent(address)}`, {
    headers: { accept: 'application/json' }
  }, 6_000);
  const pair = (Array.isArray(rows) ? rows : [])
    .sort((a, b) => finite(b?.liquidity?.usd) - finite(a?.liquidity?.usd))[0];
  if (!pair) return null;
  return {
    liquidityUsd: finite(pair?.liquidity?.usd),
    marketCapUsd: finite(pair?.marketCap, finite(pair?.fdv)),
    buys5m: finite(pair?.txns?.m5?.buys),
    sells5m: finite(pair?.txns?.m5?.sells),
    move5mPct: finite(pair?.priceChange?.m5),
    volume5mUsd: finite(pair?.volume?.m5)
  };
}

function holderProfile(supplyResult, largestResult) {
  const supply = finite(supplyResult?.value?.amount);
  const rows = Array.isArray(largestResult?.value) ? largestResult.value : [];
  if (!(supply > 0) || !rows.length) return null;
  const shares = rows
    .map((row) => finite(row?.amount) / supply * 100)
    .filter((pct) => pct > 0 && Number.isFinite(pct))
    .sort((a, b) => b - a);
  if (!shares.length) return null;
  // Pump.fun / bonding-curve or pool custody can dominate the largest token account.
  // Exclude one obvious custody account, then evaluate user concentration.
  const custodyExcluded = shares[0] >= 20;
  const users = custodyExcluded ? shares.slice(1) : shares;
  return {
    custodyExcluded,
    observedAccounts: users.length,
    topUserPct: users[0] || 0,
    top5Pct: users.slice(0, 5).reduce((sum, pct) => sum + pct, 0),
    top10Pct: users.slice(0, 10).reduce((sum, pct) => sum + pct, 0)
  };
}

export function evaluateFinalSafety({ market, profile, mintAuthority, freezeAuthority }, limits = finalGuardLimits()) {
  const reasons = [];
  if (!market) reasons.push('market-unavailable');
  else {
    if (market.liquidityUsd < limits.minLiquidityUsd) reasons.push('liquidity-below-live-floor');
    if (market.sells5m < 1) reasons.push('no-real-sell-observed');
    if (market.buys5m >= 10 && market.sells5m === 0) reasons.push('one-way-buy-pattern');
    if (market.move5mPct > limits.maxMove5mPct) reasons.push('5m-move-too-extended');
  }
  if (mintAuthority) reasons.push('mint-authority-active');
  if (freezeAuthority) reasons.push('freeze-authority-active');
  if (!profile) reasons.push('holder-profile-unavailable');
  else {
    if (profile.observedAccounts < 4) reasons.push('too-few-holder-accounts');
    if (profile.topUserPct > limits.maxTopUserPct) reasons.push('top-user-concentration');
    if (profile.top5Pct > limits.maxTop5Pct) reasons.push('top5-concentration');
    if (profile.top10Pct > limits.maxTop10Pct) reasons.push('top10-concentration');
  }
  return { ok: reasons.length === 0, reasons };
}

async function executionSafety(address) {
  if (!isTerminalAddress('sol', address)) return { ok: false, reasons: ['invalid-solana-address'] };
  const [marketResult, supplyResult, largestResult, mintResult] = await Promise.allSettled([
    marketSnapshot(address),
    solanaRpc('getTokenSupply', [address, { commitment: 'processed' }]),
    solanaRpc('getTokenLargestAccounts', [address, { commitment: 'processed' }]),
    solanaRpc('getAccountInfo', [address, { encoding: 'jsonParsed', commitment: 'processed' }])
  ]);
  const market = marketResult.status === 'fulfilled' ? marketResult.value : null;
  const profile = supplyResult.status === 'fulfilled' && largestResult.status === 'fulfilled'
    ? holderProfile(supplyResult.value, largestResult.value)
    : null;
  const mintInfo = mintResult.status === 'fulfilled' ? mintResult.value?.value?.data?.parsed?.info : null;
  if (!mintInfo) {
    return evaluateFinalSafety({ market, profile, mintAuthority: 'unknown', freezeAuthority: 'unknown' });
  }
  return evaluateFinalSafety({
    market,
    profile,
    mintAuthority: mintInfo.mintAuthority ?? null,
    freezeAuthority: mintInfo.freezeAuthority ?? null
  });
}

function utcDayStartIso() {
  const now = new Date();
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate())).toISOString();
}

async function dailyUsage() {
  if (!store.enabled) return { trades: Number.POSITIVE_INFINITY, buySol: Number.POSITIVE_INFINITY };
  const rows = await store.request(`execution_audit?select=side,amount_native,status,created_at&status=eq.succeeded&created_at=gte.${encodeURIComponent(utcDayStartIso())}&limit=100`)
    .catch(() => null);
  if (!Array.isArray(rows)) return { trades: Number.POSITIVE_INFINITY, buySol: Number.POSITIVE_INFINITY };
  return {
    trades: rows.length,
    buySol: rows.filter((row) => row.side === 'buy').reduce((sum, row) => sum + finite(row.amount_native), 0)
  };
}

async function blockRequest(requestId, reason, payload = {}) {
  const row = await store.transitionAudit(requestId, 'awaiting_confirm', 'blocked', {
    error: String(reason).slice(0, 300),
    payload: { final_guard: payload, blockedAt: new Date().toISOString() }
  }).catch(() => null);
  return Boolean(row);
}

async function finalConfirmGuard(requestId) {
  if (!store.enabled) return { ok: false, text: '🔒 Execution store غير متاح؛ التداول الحقيقي موقوف.' };
  const row = await store.getAudit(requestId).catch(() => null);
  if (!row || row.status !== 'awaiting_confirm') return { ok: true };
  if (row.network !== 'sol') return { ok: true };

  const limits = finalGuardLimits();
  if (limits.killSwitch) {
    await blockRequest(requestId, 'MANUAL_EXECUTION_KILL_SWITCH=true');
    return { ok: false, text: '🛑 KILL SWITCH مفعل. تم حظر Request قبل التوقيع.' };
  }

  const usage = await dailyUsage();
  if (usage.trades >= limits.maxTradesPerDay) {
    await blockRequest(requestId, 'daily trade count cap reached', usage);
    return { ok: false, text: `🛑 تم الوصول إلى الحد اليومي: ${limits.maxTradesPerDay} صفقات حقيقية.` };
  }
  if (row.side === 'buy' && usage.buySol + finite(row.amount_native) > limits.maxDailyBuySol + 1e-12) {
    await blockRequest(requestId, 'daily SOL buy cap reached', usage);
    return { ok: false, text: `🛑 الصفقة تتجاوز حد الشراء اليومي ${limits.maxDailyBuySol.toFixed(4)} SOL.` };
  }

  const safety = await executionSafety(row.token_address).catch((error) => ({ ok: false, reasons: [`safety-rpc-error:${String(error?.message ?? error).slice(0, 80)}`] }));
  if (!safety.ok) {
    await blockRequest(requestId, `final safety failed: ${safety.reasons.join(',')}`, { reasons: safety.reasons });
    return {
      ok: false,
      text: ['⛔ FINAL LIVE SAFETY BLOCK', '', 'تم إيقاف الصفقة قبل التوقيع.', `الأسباب: ${safety.reasons.join(' • ')}`, '', 'أنشئ Preview جديدًا فقط إذا تغيّرت حالة العقد/السوق.'].join('\n')
    };
  }
  return { ok: true };
}

let installed = false;
export function installPhase7FinalGuard() {
  if (installed) return;
  installed = true;
  const previousHandle = TradingTerminal.prototype.handle;
  TradingTerminal.prototype.handle = async function(data) {
    const value = String(data ?? '');
    if (value.startsWith('p6:c:')) {
      const requestId = value.slice('p6:c:'.length);
      const guard = await finalConfirmGuard(requestId);
      if (!guard.ok) return { handled: true, text: guard.text, keyboard: [[{ text: '📜 Audit', callback_data: 'p6:a' }]] };
    }
    return previousHandle.call(this, data);
  };

  const limits = finalGuardLimits();
  console.log(`SUMMECA PHASE 7 FINAL GUARD: killSwitch=${limits.killSwitch} dailyTrades<=${limits.maxTradesPerDay} dailyBuy<=${limits.maxDailyBuySol}SOL minLiq=$${limits.minLiquidityUsd}`);

  if (limits.smokeOnStart) {
    setTimeout(async () => {
      if (env.liveTradingEnabled) {
        console.warn('[live-readonly-smoke] skipped because LIVE_TRADING_ENABLED=true; /livecheck requires the live gate OFF');
        return;
      }
      try {
        await runLiveConfigSmoke(env);
        console.log('[live-readonly-smoke] PASSED — wallet/auth/balance/Jupiter quote verified; signed=false sent=false');
      } catch (error) {
        console.error(`[live-readonly-smoke] FAILED — ${String(error?.message ?? error).slice(0, 220)}`);
      }
    }, 5_000).unref?.();
  }
}
