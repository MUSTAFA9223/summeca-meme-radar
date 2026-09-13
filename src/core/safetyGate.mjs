const text = (value) => String(value ?? '').toLowerCase();

const securityCritical = (blocker) => /honeypot|freeze authority active|mint authority active|developer is selling|top-10 concentration|insider concentration|bundler concentration/.test(text(blocker));

const isDexVenue = (source) => /pumpswap|pump_amm|raydium|meteora|orca|dexscreener/.test(text(source));

export function evaluateSignalSafety(snapshot = {}, scores = {}) {
  const blockers = Array.isArray(scores.blockers) ? scores.blockers.map(String) : [];
  const reasons = [];
  const emergencyReasons = blockers.filter(securityCritical);
  const price = Number(snapshot.priceUsd ?? 0);
  const risk = Number(scores.risk ?? 100);
  const trades = Number(snapshot.buys30s ?? 0) + Number(snapshot.sells30s ?? 0);
  const volume5m = Number(snapshot.volume5mUsd ?? 0);
  const liquidity = Number(snapshot.liquidityUsd ?? 0);

  if (!(Number.isFinite(price) && price > 0)) reasons.push('price unavailable');
  if (snapshot.marketDataVerified !== true) reasons.push('market data not verified');
  if (snapshot.securityVerified !== true) reasons.push('security not verified');
  if (!(trades > 0 || volume5m > 0)) reasons.push('no verified trading activity');
  if (Number.isFinite(risk) && risk > 40) reasons.push(`risk score ${risk}/100`);
  for (const blocker of blockers.filter(securityCritical)) reasons.push(blocker);

  // Once a token is on a DEX/PumpSwap, near-zero liquidity is an emergency signal.
  // Pump.fun bonding-curve creates are handled separately and are not rejected solely
  // because they do not expose traditional LP liquidity yet.
  if (isDexVenue(snapshot.source) && Number.isFinite(liquidity) && liquidity > 0 && liquidity < 1000) {
    const reason = `DEX liquidity critically low ($${liquidity.toFixed(2)})`;
    reasons.push(reason);
    emergencyReasons.push(reason);
  }

  return {
    ok: reasons.length === 0,
    reasons: [...new Set(reasons)],
    emergency: snapshot.securityVerified === true && emergencyReasons.length > 0,
    emergencyReasons: [...new Set(emergencyReasons)]
  };
}
