const API = 'https://api.dexscreener.com';

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

export async function fetchDexScreenerSnapshot(base, { timeoutMs = 5000 } = {}) {
  const address = String(base?.address ?? '').trim();
  if (!address) return {};

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(`${API}/token-pairs/v1/solana/${encodeURIComponent(address)}`, {
      signal: controller.signal,
      headers: { accept: 'application/json' }
    });
    if (!response.ok) throw new Error(`DexScreener HTTP ${response.status}`);
    const payload = await response.json();
    return snapshotFromPair(base, bestPair(payload, address));
  } finally {
    clearTimeout(timer);
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
