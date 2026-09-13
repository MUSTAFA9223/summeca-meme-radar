import { fetchNewListings } from '../src/feeds/birdeye.mjs';

const apiKey = process.env.BIRDEYE_API_KEY ?? '';
if (!apiKey) {
  console.error('BIRDEYE_API_KEY is not configured.');
  process.exit(1);
}

const startedAt = Date.now();
try {
  const listings = await fetchNewListings(apiKey, { limit: 3 });
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
} catch (error) {
  console.error(`Birdeye smoke test failed: ${error.message}`);
  process.exit(1);
}
