const PUMP_FRONTEND = 'https://frontend-api-v3.pump.fun';
const SOLANA_ADDRESS = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, Math.max(0, ms)));
const finite = (value, fallback = null) => Number.isFinite(Number(value)) ? Number(value) : fallback;
const positive = (value, fallback = null) => {
  const n = finite(value, null);
  return n != null && n > 0 ? n : fallback;
};

const coinCache = new Map();
let solPriceCache = { value: null, at: 0 };
let tail = Promise.resolve();
let nextAt = 0;
let backoffUntil = 0;
let lastWarningAt = 0;

const minGapMs = () => Math.max(250, Math.min(2_000, finite(process.env.PUMP_NATIVE_MIN_GAP_MS, 450)));
const cacheMs = () => Math.max(2_000, Math.min(30_000, finite(process.env.PUMP_NATIVE_CACHE_MS, 8_000)));
const timeoutMs = () => Math.max(1_500, Math.min(10_000, finite(process.env.PUMP_NATIVE_TIMEOUT_MS, 4_000)));

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
          'user-agent': 'SUMMECA-Meme-Radar/0.36'
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

export async function fetchPumpNativeMarket(mint) {
  const address = String(mint ?? '').trim();
  if (!SOLANA_ADDRESS.test(address)) return null;

  const prior = coinCache.get(address);
  const now = Date.now();
  if (prior && now - prior.at < cacheMs()) return prior.value;

  try {
    const coin = await queuedJson(`/coins-v2/${encodeURIComponent(address)}`);
    if (!coin) return null;
    const solPriceUsd = await fetchSolPriceUsd();
    const market = normalizePumpCoinMarket(coin, solPriceUsd);
    if (market) coinCache.set(address, { value: market, at: Date.now() });
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

export async function fetchPumpNativeMarkets(mints, { limit = 4 } = {}) {
  const unique = [...new Set((Array.isArray(mints) ? mints : []).map(String).filter((mint) => SOLANA_ADDRESS.test(mint)))];
  const safeLimit = Math.max(1, Math.min(8, Number(limit) || 4));
  const selected = unique.slice(0, safeLimit);
  const rows = [];
  for (const mint of selected) {
    const market = await fetchPumpNativeMarket(mint);
    if (market) rows.push(market);
  }
  return rows;
}
