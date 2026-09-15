const num = (value, fallback = 0) => {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
};

export function ignoredLaunchPattern(snapshot = {}) {
  const raw = snapshot.raw ?? {};
  const token = snapshot.tokens ?? {};
  const listedAtRaw = snapshot.listedAt ?? snapshot.listed_at ?? token.listed_at ?? raw.listedAt;
  const listedAt = typeof listedAtRaw === 'number' ? listedAtRaw : Date.parse(listedAtRaw ?? '') || 0;
  const ageSec = listedAt > 0 ? Math.max(0, (Date.now() - listedAt) / 1000) : null;
  const fresh = ageSec == null || ageSec <= 15 * 60;

  const buys = num(snapshot.buys30s ?? snapshot.buys_30s);
  const sells = num(snapshot.sells30s ?? snapshot.sells_30s);
  const ratio = buys / Math.max(1, sells);
  const marketCap = num(snapshot.marketCapUsd ?? snapshot.market_cap_usd);
  const liquidity = num(snapshot.liquidityUsd ?? snapshot.liquidity_usd);
  const volume5m = num(snapshot.volume5mUsd ?? raw.volume5mUsd);
  const price5m = num(snapshot.priceChange5mPct ?? raw.priceChange5mPct);
  const price1h = num(snapshot.priceChange1hPct ?? raw.priceChange1hPct);
  const top10 = num(snapshot.top10HolderPct ?? snapshot.top10_holder_pct);
  const insider = num(snapshot.insiderPct ?? snapshot.insider_pct);
  const bundler = num(snapshot.bundlerPct ?? snapshot.bundler_pct);
  const creator = num(snapshot.creatorPct ?? snapshot.creator_pct ?? snapshot.devPct);
  const peakChange = Math.max(price5m, price1h);

  const knownConcentration = top10 > 40 || insider > 10 || bundler > 12 || creator > 8;
  const stretchedValuation = liquidity > 0 && marketCap >= 500_000 && marketCap / liquidity >= 25;
  const dominantBuyFlow = buys >= 4 && (sells < 1 || ratio >= 6);
  const heavyBuyFlow = buys >= 6 && ratio >= 3;
  const highVolume = volume5m >= 15_000;

  // These filters intentionally reject already-vertical launch patterns. They are
  // not a scam verdict; they simply keep WOFI-style, one-way, already-exploded
  // launches out of alerts/tracking so the radar focuses on earlier opportunities.
  const oneWayVertical = fresh
    && peakChange >= 1_200
    && volume5m >= 10_000
    && buys >= 4
    && sells < 1;
  const extremeVertical = fresh
    && peakChange >= 5_000
    && volume5m >= 20_000
    && buys >= 4;
  const lateVertical = fresh
    && peakChange >= 750
    && highVolume
    && heavyBuyFlow;
  const freshStretchedDominance = fresh
    && peakChange >= 300
    && dominantBuyFlow
    && stretchedValuation;

  const reasons = [];
  if (knownConcentration) reasons.push('concentrated insider/holder launch');
  if (oneWayVertical) reasons.push(`one-way vertical spike ${peakChange.toFixed(0)}% with no verified sell`);
  if (extremeVertical) reasons.push(`extreme vertical spike ${peakChange.toFixed(0)}% after launch`);
  if (lateVertical) reasons.push(`already-exploded launch ${peakChange.toFixed(0)}% with heavy buy dominance`);
  if (freshStretchedDominance) reasons.push('fresh stretched valuation with extreme buy dominance');

  return {
    ignored: reasons.length > 0,
    reasons: [...new Set(reasons)],
    ageSec,
    peakChange,
    ratio
  };
}
