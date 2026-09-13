const clamp = (n) => Math.max(0, Math.min(100, Math.round(n)));
const nz = (n) => Number.isFinite(n) ? n : 0;

export function scoreToken(s) {
  const reasons = [];
  const blockers = [];
  const ageSec = Math.max(0, (s.observedAt - s.listedAt) / 1000);
  const buys = nz(s.buys30s);
  const sells = nz(s.sells30s);
  const buySell = buys / Math.max(1, sells);
  const buyVol = nz(s.buyVolume30sUsd);
  const sellVol = nz(s.sellVolume30sUsd);
  const volumeRatio = buyVol / Math.max(1, sellVol);

  let risk = 20;
  if (s.honeypot) { risk += 80; blockers.push('honeypot flag'); }
  if (s.freezeAuthorityDisabled === false) { risk += 30; blockers.push('freeze authority active'); }
  if (s.mintAuthorityDisabled === false) { risk += 20; blockers.push('mint authority active'); }
  if (nz(s.top10HolderPct) > 45) { risk += 25; blockers.push('top-10 concentration >45%'); }
  if (nz(s.insiderPct) > 12) { risk += 25; blockers.push('insider concentration >12%'); }
  if (nz(s.bundlerPct) > 15) { risk += 20; blockers.push('bundler concentration >15%'); }
  if (s.devSelling) { risk += 35; blockers.push('developer is selling'); }
  if (s.liquidityUsd < 5000) { risk += 25; blockers.push('very low liquidity'); }
  risk = clamp(risk);

  let entry = 0;
  if (ageSec <= 60) { entry += 15; reasons.push('very fresh listing'); }
  else if (ageSec <= 300) entry += 8;
  if (s.liquidityUsd >= 10_000) { entry += 12; reasons.push('usable early liquidity'); }
  if (s.liquidityUsd >= 30_000) entry += 6;
  if (buySell >= 2) { entry += 15; reasons.push(`buy/sell count ${buySell.toFixed(1)}x`); }
  if (buySell >= 4) entry += 8;
  if (volumeRatio >= 2) { entry += 14; reasons.push(`buy/sell volume ${volumeRatio.toFixed(1)}x`); }
  if (nz(s.buyerAcceleration) >= 1.5) { entry += 12; reasons.push('buyer velocity accelerating'); }
  if (nz(s.volumeAcceleration) >= 1.5) { entry += 10; reasons.push('volume accelerating'); }
  if (nz(s.liquidityChangePct) > 5) { entry += 6; reasons.push('liquidity rising'); }
  if (nz(s.uniqueBuyers30s) >= 25) entry += 7;
  entry -= Math.round(risk * 0.38);
  entry = clamp(entry);

  let moon = entry * 0.45;
  if (nz(s.buyerAcceleration) >= 2) moon += 15;
  if (nz(s.volumeAcceleration) >= 2) moon += 12;
  if (buySell >= 4) moon += 10;
  if (volumeRatio >= 4) moon += 8;
  if (nz(s.top10HolderPct) > 0 && nz(s.top10HolderPct) <= 25) moon += 8;
  if (nz(s.insiderPct) <= 5) moon += 5;
  if (nz(s.devPct) <= 3 && !s.devSelling) moon += 5;
  moon -= Math.round(risk * 0.28);
  moon = clamp(moon);

  return { entry, moon, risk, reasons, blockers };
}
