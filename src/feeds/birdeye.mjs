export async function fetchNewListings(apiKey) {
  if (!apiKey) return [];
  const url = new URL('https://public-api.birdeye.so/defi/v2/tokens/new_listing');
  url.searchParams.set('limit', '20');
  url.searchParams.set('meme_platform_enabled', 'true');
  const r = await fetch(url, { headers: { 'X-API-KEY': apiKey, 'x-chain': 'solana' } });
  if (!r.ok) throw new Error(`Birdeye new listings HTTP ${r.status}`);
  const body = await r.json();
  const items = body?.data?.items ?? body?.data?.tokens ?? body?.data ?? [];
  if (!Array.isArray(items)) return [];
  const now = Date.now();
  return items.map(x => ({
    address: String(x.address ?? x.tokenAddress ?? ''), symbol: String(x.symbol ?? 'UNKNOWN'),
    name: String(x.name ?? x.symbol ?? 'Unknown'), observedAt: now,
    listedAt: Number(x.liquidityAddedAt ?? x.listedAt ?? Math.floor(now / 1000)) * 1000,
    priceUsd: Number(x.price ?? x.priceUsd ?? 0), liquidityUsd: Number(x.liquidity ?? x.liquidityUsd ?? 0)
  })).filter(x => x.address);
}
