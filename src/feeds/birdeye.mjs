const BASE_URL = 'https://public-api.birdeye.so';

const rawMaxRpm = Number(process.env.BIRDEYE_MAX_RPM ?? 50);
const MAX_RPM = Number.isFinite(rawMaxRpm) ? Math.max(1, Math.min(55, Math.floor(rawMaxRpm))) : 50;
const requestTimestamps = [];
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitForRateSlot() {
  while (true) {
    const now = Date.now();
    while (requestTimestamps.length && requestTimestamps[0] <= now - 60_000) requestTimestamps.shift();
    if (requestTimestamps.length < MAX_RPM) {
      requestTimestamps.push(now);
      return;
    }
    await sleep(Math.max(50, requestTimestamps[0] + 60_050 - now));
  }
}

const asNumber = (value, fallback = 0) => {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
};

const first = (obj, keys) => {
  for (const key of keys) {
    if (obj && obj[key] !== undefined && obj[key] !== null) return obj[key];
  }
  return undefined;
};

const imageUrl = (value) => {
  const raw = String(value ?? '').trim();
  if (!raw) return undefined;
  if (raw.startsWith('ipfs://')) return `https://ipfs.io/ipfs/${raw.slice(7)}`;
  if (/^https?:\/\//i.test(raw)) return raw;
  return undefined;
};

const asOptionalBool = (value) => {
  if (value === undefined || value === null || value === '') return undefined;
  if (typeof value === 'boolean') return value;
  if (typeof value === 'number') return value !== 0;
  const s = String(value).toLowerCase();
  if (['true', '1', 'yes', 'y'].includes(s)) return true;
  if (['false', '0', 'no', 'n'].includes(s)) return false;
  return undefined;
};

async function birdeyeGet(apiKey, path, params = {}, { timeoutMs = 8000 } = {}) {
  if (!apiKey) throw new Error('BIRDEYE_API_KEY is required for live data');
  const url = new URL(path, BASE_URL);
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== null && value !== '') url.searchParams.set(key, String(value));
  }

  await waitForRateSlot();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, {
      signal: controller.signal,
      headers: {
        'X-API-KEY': apiKey,
        'x-chain': 'solana',
        accept: 'application/json'
      }
    });
    if (!response.ok) {
      const retryAfter = response.headers.get('retry-after');
      const suffix = retryAfter ? ` retry-after=${retryAfter}s` : '';
      throw new Error(`Birdeye ${path} HTTP ${response.status}${suffix}`);
    }
    return response.json();
  } finally {
    clearTimeout(timer);
  }
}

export async function fetchNewListings(apiKey, { limit = 20 } = {}) {
  if (!apiKey) return [];
  const body = await birdeyeGet(apiKey, '/defi/v2/tokens/new_listing', {
    limit: Math.max(1, Math.min(20, limit)),
    meme_platform_enabled: true
  });
  const items = body?.data?.items ?? body?.data?.tokens ?? body?.data ?? [];
  if (!Array.isArray(items)) return [];

  const now = Date.now();
  return items.map((x) => {
    const listedSeconds = asNumber(first(x, ['liquidityAddedAt', 'listedAt', 'createdAt']), Math.floor(now / 1000));
    return {
      address: String(first(x, ['address', 'tokenAddress']) ?? ''),
      symbol: String(first(x, ['symbol']) ?? 'UNKNOWN'),
      name: String(first(x, ['name', 'symbol']) ?? 'Unknown'),
      source: String(first(x, ['source', 'platform']) ?? ''),
      imageUrl: imageUrl(first(x, ['logoURI', 'logoUri', 'logo_uri', 'logo', 'icon', 'image', 'imageUrl', 'image_url'])),
      observedAt: now,
      listedAt: listedSeconds > 1e12 ? listedSeconds : listedSeconds * 1000,
      priceUsd: asNumber(first(x, ['price', 'priceUsd'])),
      liquidityUsd: asNumber(first(x, ['liquidity', 'liquidityUsd']))
    };
  }).filter((x) => x.address);
}

export async function fetchTokenOverview(apiKey, address) {
  const body = await birdeyeGet(apiKey, '/defi/token_overview', { address });
  const d = body?.data ?? {};
  return {
    priceUsd: asNumber(first(d, ['price', 'priceUsd'])),
    liquidityUsd: asNumber(first(d, ['liquidity', 'liquidityUsd'])),
    marketCapUsd: asNumber(first(d, ['marketCap', 'marketCapUsd', 'mc'])),
    holderCount: asNumber(first(d, ['holder', 'holders', 'holderCount'])),
    uniqueWallets24h: asNumber(first(d, ['uniqueWallet24h', 'uniqueWallets24h', 'uniqueWallet24hChange'])),
    imageUrl: imageUrl(first(d, ['logoURI', 'logoUri', 'logo_uri', 'logo', 'icon', 'image', 'imageUrl', 'image_url']))
  };
}

export function normalizeSecurity(raw) {
  const d = raw?.data ?? raw ?? {};
  const freezeable = asOptionalBool(first(d, ['freezeable', 'freezable', 'isFreezeable', 'freezeAuthorityEnabled']));
  const mintable = asOptionalBool(first(d, ['mintable', 'isMintable', 'mintAuthorityEnabled']));
  const honeypot = asOptionalBool(first(d, ['honeypot', 'isHoneypot', 'is_honeypot']));

  return {
    ...(honeypot !== undefined ? { honeypot } : {}),
    ...(freezeable !== undefined ? { freezeAuthorityDisabled: !freezeable } : {}),
    ...(mintable !== undefined ? { mintAuthorityDisabled: !mintable } : {}),
    top10HolderPct: asNumber(first(d, ['top10HolderPercent', 'top10HolderPct', 'top10HolderPercentage'])),
    creatorPct: asNumber(first(d, ['creatorPercentage', 'creatorPct', 'creatorPercent']))
  };
}

export async function fetchTokenSecurity(apiKey, address) {
  return normalizeSecurity(await birdeyeGet(apiKey, '/defi/token_security', { address }));
}

const txTimeMs = (tx) => {
  const value = asNumber(first(tx, ['blockUnixTime', 'block_unix_time', 'blockTime', 'timestamp', 'time']));
  if (!value) return 0;
  return value > 1e12 ? value : value * 1000;
};

const txSide = (tx) => String(first(tx, ['txType', 'tx_type', 'side', 'type', 'swapType']) ?? '').toLowerCase();
const txWallet = (tx) => String(first(tx, ['owner', 'wallet', 'trader', 'signer', 'sourceOwner', 'source_owner']) ?? '');
const txUsd = (tx) => asNumber(first(tx, ['volumeUSD', 'volumeUsd', 'volume_usd', 'amountUsd', 'amount_usd', 'valueUsd', 'value_usd']));

export function summarizeTrades(items, { nowMs = Date.now(), windowSeconds = 30 } = {}) {
  const windowMs = windowSeconds * 1000;
  const currentStart = nowMs - windowMs;
  const previousStart = nowMs - windowMs * 2;
  const current = { buys: 0, sells: 0, buyUsd: 0, sellUsd: 0, buyers: new Set(), volume: 0 };
  const previous = { buyers: new Set(), volume: 0 };

  for (const tx of Array.isArray(items) ? items : []) {
    const time = txTimeMs(tx);
    if (!time || time < previousStart || time > nowMs + 5000) continue;
    const side = txSide(tx);
    const usd = txUsd(tx);
    const wallet = txWallet(tx);
    const bucket = time >= currentStart ? current : previous;
    bucket.volume += usd;

    if (side.includes('buy')) {
      if (bucket === current) {
        current.buys += 1;
        current.buyUsd += usd;
      }
      if (wallet) bucket.buyers.add(wallet);
    } else if (side.includes('sell')) {
      if (bucket === current) {
        current.sells += 1;
        current.sellUsd += usd;
      }
    }
  }

  const buyerAcceleration = current.buyers.size / Math.max(1, previous.buyers.size);
  const volumeAcceleration = current.volume / Math.max(1, previous.volume);
  return {
    buys30s: current.buys,
    sells30s: current.sells,
    buyVolume30sUsd: current.buyUsd,
    sellVolume30sUsd: current.sellUsd,
    uniqueBuyers30s: current.buyers.size,
    buyerAcceleration,
    volumeAcceleration
  };
}

export async function fetchRecentTradeSummary(apiKey, address, { nowMs = Date.now(), windowSeconds = 30 } = {}) {
  const afterTime = Math.floor((nowMs - windowSeconds * 2 * 1000) / 1000);
  const body = await birdeyeGet(apiKey, '/defi/v3/token/txs', {
    address,
    limit: 100,
    tx_type: 'all',
    sort_by: 'block_unix_time',
    sort_type: 'desc',
    after_time: afterTime
  });
  const items = body?.data?.items ?? body?.data?.txs ?? body?.data ?? [];
  return summarizeTrades(items, { nowMs, windowSeconds });
}

export async function enrichTokenSnapshot(apiKey, base, { includeSecurity = true } = {}) {
  const jobs = [fetchTokenOverview(apiKey, base.address), fetchRecentTradeSummary(apiKey, base.address)];
  if (includeSecurity) jobs.push(fetchTokenSecurity(apiKey, base.address));
  const results = await Promise.allSettled(jobs);
  const overview = results[0]?.status === 'fulfilled' ? results[0].value : {};
  const flow = results[1]?.status === 'fulfilled' ? results[1].value : {};
  const security = includeSecurity && results[2]?.status === 'fulfilled' ? results[2].value : {};
  return { ...base, ...overview, ...flow, ...security, observedAt: Date.now() };
}
