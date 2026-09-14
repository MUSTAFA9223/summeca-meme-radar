const API = 'https://api.dexscreener.com';
const GECKO_API = 'https://api.geckoterminal.com/api/v2';
const GECKO_MIN_INTERVAL_MS = 7_000;
const GECKO_CACHE_MS = 60_000;
let lastGeckoAt = 0;
const geckoCache = new Map();

const num = (value, fallback = 0) => {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
};

const normalizeImage = (value) => {
  const raw = String(value ?? '').trim();
  if (!raw) return undefined;
  if (raw.startsWith('ipfs://')) return `https://ipfs.io/ipfs/${raw.slice(7)}`;
  return /^https?:\/\//i.test(raw) ? raw : undefined;
};

const tokenSide = (pair, address) => {
  if (pair?.baseToken?.address === address) return pair.baseToken;
  if (pair?.quoteToken?.address === address) return pair.quoteToken;
  return pair?.baseToken ?? {};
};

const pairScore = (pair) => num(pair?.liquidity?.usd) * 1000 + num(pair?.volume?.m5);

const bestPair = (pairs, address) => (Array.isArray(pairs) ? pairs : [])
  .filter((pair) => pair?.chainId === 'solana' && (pair?.baseToken?.address === address || pair?.quoteToken?.address === address))
  .sort((a, b) => pairScore(b) - pairScore(a))[0];

const snapshotFromPair = (base, pair) => {
  if (!pair) return {};
  const address = String(base?.address ?? '').trim();
  const now = Date.now();
  const pairCreatedAt = num(pair.pairCreatedAt, 0);
  const baseListedAt = num(base?.listedAt, 0);
  const listedAt = baseListedAt > 0 ? baseListedAt : (pairCreatedAt > 0 ? pairCreatedAt : now);
  const ageSec = Math.max(1, (now - listedAt) / 1000);
  const observedWindowSec = Math.max(30, Math.min(300, ageSec));
  const windows30 = Math.max(1, observedWindowSec / 30);

  const tx5 = pair?.txns?.m5 ?? {};
  const tx1h = pair?.txns?.h1 ?? {};
  const buys5 = num(tx5.buys);
  const sells5 = num(tx5.sells);
  const trades5 = buys5 + sells5;
  const trades1h = num(tx1h.buys) + num(tx1h.sells);
  const buys30s = buys5 / windows30;
  const sells30s = sells5 / windows30;

  const volume5mUsd = num(pair?.volume?.m5);
  const volume1hUsd = num(pair?.volume?.h1);
  const volume30sUsd = volume5mUsd / windows30;
  const buyShare = buys5 / Math.max(1, trades5);
  const sellShare = sells5 / Math.max(1, trades5);

  const previousTrade5mAvg = Math.max(1, (trades1h - trades5) / 11);
  const previousVolume5mAvg = Math.max(1, (volume1hUsd - volume5mUsd) / 11);
  const hasHistory = ageSec >= 360;
  const token = tokenSide(pair, address);

  return {
    name: token?.name ? String(token.name) : base?.name,
    symbol: token?.symbol ? String(token.symbol) : base?.symbol,
    source: pair.dexId ? `dexscreener:${pair.dexId}` : (base?.source ?? 'dexscreener'),
    imageUrl: normalizeImage(pair?.info?.imageUrl) ?? base?.imageUrl,
    priceUsd: num(pair.priceUsd, num(base?.priceUsd)),
    liquidityUsd: num(pair?.liquidity?.usd, num(base?.liquidityUsd)),
    marketCapUsd: num(pair.marketCap, num(base?.marketCapUsd)),
    buys30s,
    sells30s,
    buyVolume30sUsd: volume30sUsd * buyShare,
    sellVolume30sUsd: volume30sUsd * sellShare,
    volume5mUsd,
    priceChange5mPct: num(pair?.priceChange?.m5),
    priceChange1hPct: num(pair?.priceChange?.h1),
    buyerAcceleration: hasHistory ? trades5 / previousTrade5mAvg : 0,
    volumeAcceleration: hasHistory ? volume5mUsd / previousVolume5mAvg : 0,
    dexPairAddress: pair.pairAddress ? String(pair.pairAddress) : undefined,
    observedAt: now,
    listedAt
  };
};

const relationshipMatches = (relationship, address) => {
  const id = String(relationship?.data?.id ?? '');
  return id === address || id.endsWith(`_${address}`);
};

const snapshotFromGeckoPool = (base, pool) => {
  const attributes = pool?.attributes ?? {};
  const address = String(base?.address ?? '').trim();
  if (!address) return {};
  const isBase = relationshipMatches(pool?.relationships?.base_token, address);
  const isQuote = relationshipMatches(pool?.relationships?.quote_token, address);
  if (!isBase && !isQuote) return {};

  const now = Date.now();
  const created = Date.parse(attributes.pool_created_at ?? '') || 0;
  const listedAt = num(base?.listedAt, 0) || created || now;
  const ageSec = Math.max(1, (now - listedAt) / 1000);
  const observedWindowSec = Math.max(30, Math.min(300, ageSec));
  const windows30 = Math.max(1, observedWindowSec / 30);
  const tx5 = attributes.transactions?.m5 ?? {};
  const tx1h = attributes.transactions?.h1 ?? {};
  const buys5 = num(tx5.buys);
  const sells5 = num(tx5.sells);
  const trades5 = buys5 + sells5;
  const trades1h = num(tx1h.buys) + num(tx1h.sells);
  const volume5mUsd = num(attributes.volume_usd?.m5, num(attributes.volume_usd?.h1) / 12);
  const volume1hUsd = num(attributes.volume_usd?.h1);
  const volume30sUsd = volume5mUsd / windows30;
  const buyShare = buys5 / Math.max(1, trades5);
  const sellShare = sells5 / Math.max(1, trades5);
  const previousTrade5mAvg = Math.max(1, (trades1h - trades5) / 11);
  const previousVolume5mAvg = Math.max(1, (volume1hUsd - volume5mUsd) / 11);
  const priceUsd = isBase ? num(attributes.base_token_price_usd) : num(attributes.quote_token_price_usd);

  return {
    source: `geckoterminal:${String(pool?.relationships?.dex?.data?.id ?? 'solana')}`,
    priceUsd: priceUsd || num(base?.priceUsd),
    liquidityUsd: num(attributes.reserve_in_usd, num(base?.liquidityUsd)),
    marketCapUsd: num(attributes.market_cap_usd, num(attributes.fdv_usd, num(base?.marketCapUsd))),
    buys30s: buys5 / windows30,
    sells30s: sells5 / windows30,
    buyVolume30sUsd: volume30sUsd * buyShare,
    sellVolume30sUsd: volume30sUsd * sellShare,
    volume5mUsd,
    priceChange5mPct: num(attributes.price_change_percentage?.m5),
    priceChange1hPct: num(attributes.price_change_percentage?.h1),
    buyerAcceleration: ageSec >= 360 ? trades5 / previousTrade5mAvg : 0,
    volumeAcceleration: ageSec >= 360 ? volume5mUsd / previousVolume5mAvg : 0,
    dexPairAddress: attributes.address ? String(attributes.address) : undefined,
    observedAt: now,
    listedAt
  };
};

async function fetchGeckoFallback(base, { timeoutMs = 6500 } = {}) {
  const address = String(base?.address ?? '').trim();
  if (!address) return {};
  const cached = geckoCache.get(address);
  if (cached && Date.now() - cached.at < GECKO_CACHE_MS) return cached.snapshot;

  const waitMs = GECKO_MIN_INTERVAL_MS - (Date.now() - lastGeckoAt);
  if (waitMs > 0) return {};
  lastGeckoAt = Date.now();

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(`${GECKO_API}/networks/solana/tokens/${encodeURIComponent(address)}/pools?page=1`, {
      signal: controller.signal,
      headers: { accept: 'application/json;version=20230203' }
    });
    if (!response.ok) throw new Error(`GeckoTerminal HTTP ${response.status}`);
    const body = await response.json();
    const pools = Array.isArray(body?.data) ? body.data : [];
    const candidates = pools
      .map((pool) => ({ pool, snapshot: snapshotFromGeckoPool(base, pool) }))
      .filter((item) => Object.keys(item.snapshot).length)
      .sort((a, b) => num(b.snapshot.liquidityUsd) - num(a.snapshot.liquidityUsd));
    const snapshot = candidates[0]?.snapshot ?? {};
    geckoCache.set(address, { at: Date.now(), snapshot });
    if (Object.keys(snapshot).length) console.log(`[market:fallback] GeckoTerminal mint=${address.slice(0, 8)}… price=${snapshot.priceUsd || 0} liq=${Math.round(snapshot.liquidityUsd || 0)}`);
    return snapshot;
  } finally {
    clearTimeout(timer);
  }
}

export async function fetchDexScreenerSnapshot(base, { timeoutMs = 5000 } = {}) {
  const address = String(base?.address ?? '').trim();
  if (!address) return {};

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    try {
      const response = await fetch(`${API}/token-pairs/v1/solana/${encodeURIComponent(address)}`, {
        signal: controller.signal,
        headers: { accept: 'application/json' }
      });
      if (!response.ok) throw new Error(`DexScreener HTTP ${response.status}`);
      const payload = await response.json();
      const snapshot = snapshotFromPair(base, bestPair(payload, address));
      if (Object.keys(snapshot).length && (num(snapshot.priceUsd) > 0 || num(snapshot.volume5mUsd) > 0)) return snapshot;
    } catch (error) {
      if (error?.name === 'AbortError') throw error;
      console.warn('[dexscreener:single]', address, error.message);
    }
  } finally {
    clearTimeout(timer);
  }

  try {
    return await fetchGeckoFallback(base, { timeoutMs: Math.max(5000, timeoutMs) });
  } catch (error) {
    console.warn('[geckoterminal]', address, error.message);
    return {};
  }
}

export async function fetchDexScreenerSnapshots(bases, { timeoutMs = 5000 } = {}) {
  const unique = new Map();
  for (const base of Array.isArray(bases) ? bases : []) {
    const address = String(base?.address ?? '').trim();
    if (address && !unique.has(address)) unique.set(address, base);
    if (unique.size >= 30) break;
  }
  if (!unique.size) return new Map();

  const addresses = [...unique.keys()];
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(`${API}/tokens/v1/solana/${addresses.map(encodeURIComponent).join(',')}`, {
      signal: controller.signal,
      headers: { accept: 'application/json' }
    });
    if (!response.ok) throw new Error(`DexScreener batch HTTP ${response.status}`);
    const pairs = await response.json();
    const out = new Map();
    for (const [address, base] of unique) {
      const snapshot = snapshotFromPair(base, bestPair(pairs, address));
      if (Object.keys(snapshot).length) out.set(address, snapshot);
    }
    return out;
  } finally {
    clearTimeout(timer);
  }
}
