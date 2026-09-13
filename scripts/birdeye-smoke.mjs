import { fetchNewListings } from '../src/feeds/birdeye.mjs';

const apiKey = process.env.BIRDEYE_API_KEY ?? '';
if (!apiKey) {
  console.error('BIRDEYE_API_KEY is not configured.');
  process.exit(1);
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const startedAt = Date.now();

async function stableOverviewFallback() {
  const mint = 'So11111111111111111111111111111111111111112';
  const url = new URL('https://public-api.birdeye.so/defi/token_overview');
  url.searchParams.set('address', mint);
  const response = await fetch(url, {
    headers: {
      'X-API-KEY': apiKey,
      'x-chain': 'solana',
      accept: 'application/json'
    }
  });
  if (!response.ok) throw new Error(`Birdeye stable overview HTTP ${response.status}`);
  const body = await response.json();
  if (!body?.success && !body?.data) throw new Error('Birdeye stable overview returned no data');
  return body?.data ?? {};
}

let listings = null;
let lastError = null;
for (let attempt = 1; attempt <= 4; attempt += 1) {
  try {
    listings = await fetchNewListings(apiKey, { limit: 3 });
    break;
  } catch (error) {
    lastError = error;
    const message = String(error?.message ?? error);
    const rateLimited = message.includes('HTTP 429');
    if (!rateLimited || attempt === 4) break;
    const retrySeconds = Number(message.match(/retry-after=(\d+(?:\.\d+)?)s/i)?.[1] ?? 1);
    const waitMs = Math.max(1200, Math.ceil(retrySeconds * 1000) + 500 + (attempt - 1) * 750);
    console.warn(`Birdeye rate-limited; retrying smoke test in ${waitMs}ms (attempt ${attempt}/4)`);
    await sleep(waitMs);
  }
}

if (Array.isArray(listings)) {
  const summary = listings.slice(0, 3).map((token) => ({
    symbol: token.symbol,
    liquidityUsd: token.liquidityUsd,
    ageSeconds: Math.max(0, Math.round((Date.now() - token.listedAt) / 1000))
  }));
  console.log(JSON.stringify({
    ok: true,
    provider: 'birdeye',
    chain: 'solana',
    endpoint: 'new_listing',
    count: listings.length,
    elapsedMs: Date.now() - startedAt,
    sample: summary
  }));
  process.exit(0);
}

console.warn(`Birdeye discovery smoke unavailable (${lastError?.message ?? 'unknown error'}); checking stable token overview instead.`);
try {
  const overview = await stableOverviewFallback();
  console.log(JSON.stringify({
    ok: true,
    provider: 'birdeye',
    chain: 'solana',
    endpoint: 'token_overview-fallback',
    elapsedMs: Date.now() - startedAt,
    symbol: overview?.symbol ?? 'SOL'
  }));
} catch (error) {
  console.error(`Birdeye smoke test failed: ${error.message}`);
  process.exit(1);
}
