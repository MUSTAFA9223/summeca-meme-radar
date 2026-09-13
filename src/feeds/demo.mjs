export function demoSnapshots() {
  const now = Date.now();
  return [{ address: 'DEMO111111111111111111111111111111111111111', symbol: 'MOONDEMO', name: 'Moon Demo',
    observedAt: now, listedAt: now - 38_000, priceUsd: 0.0000184, liquidityUsd: 42_000, holders: 280,
    top10HolderPct: 19, buys30s: 164, sells30s: 24, buyVolume30sUsd: 18_400, sellVolume30sUsd: 2_900,
    uniqueBuyers30s: 107, uniqueSellers30s: 19, buyerAcceleration: 2.4, volumeAcceleration: 2.1,
    liquidityChangePct: 12, sniperPct: 3, bundlerPct: 2.5, insiderPct: 1.8, devPct: 1.4,
    devSelling: false, mintAuthorityDisabled: true, freezeAuthorityDisabled: true, honeypot: false }];
}
