const PUMP_FRONTEND = 'https://frontend-api-v3.pump.fun';
const SOLANA_ADDRESS = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, Math.max(0, ms)));
const finite = (value, fallback = null) => Number.isFinite(Number(value)) ? Number(value) : fallback;
const positive = (value, fallback = null) => {
  const n = finite(value, null);
  return n != null && n > 0 ? n : fallback;
};

const coinCache = new Map();
const tradeFlowCache = new Map();
let tradeFlowDisabledUntil = 0;
let tradeFlowWarningAt = 0;
let solPriceCache = { value: null, at: 0 };
let tail = Promise.resolve();
let nextAt = 0;
let backoffUntil = 0;
let lastWarningAt = 0;

const minGapMs = () => Math.max(250, Math.min(2_000, finite(process.env.PUMP_NATIVE_MIN_GAP_MS, 450)));
const cacheMs = () => Math.max(2_000, Math.min(30_000, finite(process.env.PUMP_NATIVE_CACHE_MS, 8_000)));
const timeoutMs = () => Math.max(1_500, Math.min(10_000, finite(process.env.PUMP_NATIVE_TIMEOUT_MS, 4_000)));
const flowCacheMs = () => Math.max(1_500, Math.min(15_000, finite(process.env.PUMP_NATIVE_FLOW_CACHE_MS, 5_000)));
const flowAuthCooldownMs = () => Math.max(15_000, Math.min(300_000, finite(process.env.PUMP_NATIVE_FLOW_AUTH_COOLDOWN_MS, 60_000)));

function createdAtMs(value) {
  const n = finite(value, null);
  if (n == null || n <= 0) return null;
  return n < 10_000_000_000 ? Math.round(n * 1_000) : Math.round(n);
}

async function queuedJson(path) {
  const task = tail.then(async () => {
    const now = Date.now();
    const waitMs = Math.max(0, nextAt - now, backoffUntil - now);
    if (waitMs) await sleep(waitMs);
    nextAt = Date.now() + minGapMs();

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs());
    try {
      const response = await fetch(`${PUMP_FRONTEND}${path}`, {
        signal: controller.signal,
        headers: {
          accept: 'application/json',
          'user-agent': 'SUMMECA-Meme-Radar/0.41'
        }
      });
      if (response.status === 404) return null;
      if (response.status === 429) {
        backoffUntil = Date.now() + 15_000;
        throw new Error(`Pump.fun ${path} HTTP 429`);
      }
      if (!response.ok) throw new Error(`Pump.fun ${path} HTTP ${response.status}`);
      return response.json().catch(() => null);
    } finally {
      clearTimeout(timer);
    }
  });
  tail = task.catch(() => undefined);
  return task;
}

async function fetchSolPriceUsd() {
  const now = Date.now();
  if (positive(solPriceCache.value) && now - solPriceCache.at < 15_000) return solPriceCache.value;
  try {
    const body = await queuedJson('/sol-price');
    const value = positive(body?.solPrice ?? body?.price ?? body?.usd);
    if (value) solPriceCache = { value, at: Date.now() };
    return value;
  } catch (error) {
    return positive(solPriceCache.value);
  }
}

function tradeTimeMs(trade = {}) {
  return createdAtMs(trade.timestamp ?? trade.created_timestamp ?? trade.createdTimestamp ?? trade.time);
}

function tradeIsBuy(trade = {}) {
  const value = trade.is_buy ?? trade.isBuy ?? trade.buy;
  if (typeof value === 'boolean') return value;
  const side = String(trade.side ?? trade.type ?? '').toLowerCase();
  if (side === 'buy') return true;
  if (side === 'sell') return false;
  return null;
}

function tradeSolAmount(trade = {}) {
  const raw = positive(trade.sol_amount ?? trade.solAmount ?? trade.sol);
  if (!raw) return null;
  return raw > 10_000 ? raw / 1_000_000_000 : raw;
}

function tradeTokenAmount(trade = {}) {
  const raw = positive(trade.token_amount ?? trade.tokenAmount ?? trade.tokens);
  if (!raw) return null;
  return raw > 1_000_000 ? raw / 1_000_000 : raw;
}

export function summarizePumpTradeFlow(trades = [], {
  nowMs = Date.now(),
  windowMs = 5 * 60_000,
  solPriceUsd = null
} = {}) {
  const recent = [];
  let buys5m = 0;
  let sells5m = 0;
  let volume5mUsd = 0;

  for (const trade of Array.isArray(trades) ? trades : []) {
    const at = tradeTimeMs(trade);
    if (!at || at < nowMs - windowMs || at > nowMs + 5_000) continue;
    const isBuy = tradeIsBuy(trade);
    if (isBuy == null) continue;

    const sol = tradeSolAmount(trade);
    const tokens = tradeTokenAmount(trade);
    const usd = sol && positive(solPriceUsd) ? sol * Number(solPriceUsd) : 0;
    const priceUsd = sol && tokens && positive(solPriceUsd)
      ? (sol * Number(solPriceUsd)) / tokens
      : null;

    if (isBuy) buys5m += 1;
    else sells5m += 1;
    volume5mUsd += usd;
    recent.push({ at, priceUsd });
  }

  recent.sort((a, b) => a.at - b.at);
  const priced = recent.filter((row) => positive(row.priceUsd));
  const firstPrice = priced[0]?.priceUsd ?? null;
  const lastPrice = priced.at(-1)?.priceUsd ?? null;
  const priceChange5mPct = firstPrice && lastPrice && priced.length >= 2
    ? ((lastPrice / firstPrice) - 1) * 100
    : null;

  return {
    buys5m,
    sells5m,
    volume5mUsd,
    priceChange5mPct,
    tradeCount5m: recent.length,
    hasFlow: recent.length >= 2 && (buys5m + sells5m) >= 2 && Number.isFinite(priceChange5mPct)
  };
}

async function fetchPumpNativeTradeFlow(mint, solPriceUsd) {
  const address = String(mint ?? '').trim();
  if (!SOLANA_ADDRESS.test(address)) return null;
  const now = Date.now();
  const cached = tradeFlowCache.get(address);
  if (cached && now - cached.at < flowCacheMs()) return cached.value;
  if (tradeFlowDisabledUntil > now) return cached?.value ?? null;

  try {
    const body = await queuedJson(`/trades/all/${encodeURIComponent(address)}?limit=100&offset=0&minimumSize=0`);
    const rows = Array.isArray(body)
      ? body
      : (body?.trades ?? body?.data?.trades ?? body?.data ?? []);
    if (!Array.isArray(rows)) return null;
    const flow = summarizePumpTradeFlow(rows, { nowMs: Date.now(), solPriceUsd });
    tradeFlowCache.set(address, { value: flow, at: Date.now() });
    return flow;
  } catch (error) {
    const message = String(error?.message ?? error);
    if (/HTTP (401|403)/.test(message)) tradeFlowDisabledUntil = Date.now() + flowAuthCooldownMs();
    if (Date.now() - tradeFlowWarningAt >= 30_000) {
      tradeFlowWarningAt = Date.now();
      console.warn(`[pump-native:flow] ${message}; continuing without native trade flow`);
    }
    return cached?.value ?? null;
  }
}

export function normalizePumpCoinMarket(coin, solPriceUsd = null) {
  if (!coin || typeof coin !== 'object') return null;
  const mint = String(coin.mint ?? coin.address ?? '').trim();
  if (!SOLANA_ADDRESS.test(mint)) return null;

  const marketCapUsd = positive(coin.usd_market_cap ?? coin.usdMarketCap ?? coin.market_cap_usd, 0) ?? 0;
  const totalSupplyRaw = positive(coin.total_supply ?? coin.totalSupply);
  const supplyTokens = totalSupplyRaw ? totalSupplyRaw / 1_000_000 : null;
  const priceFromMarketCap = marketCapUsd > 0 && supplyTokens > 0 ? marketCapUsd / supplyTokens : null;

  const virtualSol = positive(coin.virtual_sol_reserves ?? coin.virtualSolReserves);
  const virtualTokens = positive(coin.virtual_token_reserves ?? coin.virtualTokenReserves);
  const reservePriceSol = virtualSol && virtualTokens
    ? (virtualSol / 1_000_000_000) / (virtualTokens / 1_000_000)
    : null;
  const reservePriceUsd = reservePriceSol && positive(solPriceUsd)
    ? reservePriceSol * Number(solPriceUsd)
    : null;

  const priceUsd = positive(priceFromMarketCap, positive(reservePriceUsd, 0)) ?? 0;
  const createdAt = createdAtMs(coin.created_timestamp ?? coin.createdTimestamp);
  const lastTradeAt = createdAtMs(coin.last_trade_timestamp ?? coin.lastTradeTimestamp);

  return {
    mint,
    symbol: String(coin.symbol ?? 'TOKEN').trim() || 'TOKEN',
    name: String(coin.name ?? '').trim(),
    priceUsd,
    liquidityUsd: 0,
    marketCapUsd,
    buys5m: 0,
    sells5m: 0,
    volume5mUsd: 0,
    priceChange5mPct: 0,
    pairCreatedAt: createdAt ?? 0,
    url: `https://pump.fun/coin/${encodeURIComponent(mint)}`,
    dexId: 'pumpfun',
    source: 'pump-native',
    hasFlow: false,
    creator: String(coin.creator ?? '').trim() || null,
    complete: coin.complete === true,
    bondingCurve: String(coin.bonding_curve ?? coin.bondingCurve ?? '').trim() || null,
    associatedBondingCurve: String(coin.associated_bonding_curve ?? coin.associatedBondingCurve ?? '').trim() || null,
    lastTradeAt,
    replyCount: finite(coin.reply_count ?? coin.replyCount, null),
    virtualSolReserves: virtualSol,
    virtualTokenReserves: virtualTokens,
    totalSupplyRaw,
    solPriceUsd: positive(solPriceUsd)
  };
}

export async function fetchPumpNativeMarket(mint, { includeFlow = false } = {}) {
  const address = String(mint ?? '').trim();
  if (!SOLANA_ADDRESS.test(address)) return null;

  const prior = coinCache.get(address);
  const now = Date.now();
  if (prior && now - prior.at < cacheMs()) {
    if (!includeFlow || prior.value?.hasFlow) return prior.value;
    const solPriceUsd = positive(prior.value?.solPriceUsd) ?? await fetchSolPriceUsd();
    const flow = await fetchPumpNativeTradeFlow(address, solPriceUsd);
    if (!flow?.hasFlow) return prior.value;
    const enriched = {
      ...prior.value,
      buys5m: flow.buys5m,
      sells5m: flow.sells5m,
      volume5mUsd: flow.volume5mUsd,
      priceChange5mPct: flow.priceChange5mPct,
      tradeCount5m: flow.tradeCount5m,
      hasFlow: true,
      flowSource: 'pump-native-trades'
    };
    coinCache.set(address, { value: enriched, at: prior.at });
    return enriched;
  }

  try {
    const coin = await queuedJson(`/coins-v2/${encodeURIComponent(address)}`);
    if (!coin) return null;
    const solPriceUsd = await fetchSolPriceUsd();
    const market = normalizePumpCoinMarket(coin, solPriceUsd);
    if (!market) return null;
    if (includeFlow) {
      const flow = await fetchPumpNativeTradeFlow(address, solPriceUsd);
      if (flow?.hasFlow) {
        market.buys5m = flow.buys5m;
        market.sells5m = flow.sells5m;
        market.volume5mUsd = flow.volume5mUsd;
        market.priceChange5mPct = flow.priceChange5mPct;
        market.tradeCount5m = flow.tradeCount5m;
        market.hasFlow = true;
        market.flowSource = 'pump-native-trades';
      }
    }
    coinCache.set(address, { value: market, at: Date.now() });
    return market;
  } catch (error) {
    const stamp = Date.now();
    if (stamp - lastWarningAt > 15_000) {
      lastWarningAt = stamp;
      console.warn(`[pump-native] ${error?.message ?? error}`);
    }
    return prior?.value ?? null;
  }
}

export async function fetchPumpNativeMarkets(mints, { limit = 4, flowLimit = 0 } = {}) {
  const unique = [...new Set((Array.isArray(mints) ? mints : []).map(String).filter((mint) => SOLANA_ADDRESS.test(mint)))];
  const safeLimit = Math.max(1, Math.min(8, Number(limit) || 4));
  const selected = unique.slice(0, safeLimit);
  const rows = [];
  const safeFlowLimit = Math.max(0, Math.min(safeLimit, Number(flowLimit) || 0));
  for (let index = 0; index < selected.length; index += 1) {
    const mint = selected[index];
    const market = await fetchPumpNativeMarket(mint, { includeFlow: index < safeFlowLimit });
    if (market) rows.push(market);
  }
  return rows;
}
