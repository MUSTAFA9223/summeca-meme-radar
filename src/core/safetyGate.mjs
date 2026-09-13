const text = (value) => String(value ?? '').toLowerCase();

const securityCritical = (blocker) => /honeypot|freeze authority active|mint authority active|developer is selling|top-10 concentration|insider concentration|bundler concentration/.test(text(blocker));

const isDexVenue = (source) => {
  const value = text(source);
  if (/pumpfun|pump_fun|bonding/.test(value)) return false;
  return /pumpswap|pump_amm|raydium|meteora|orca/.test(value)
    || (value.includes('dexscreener') && !value.includes('pump'));
};

export function evaluateSignalSafety(snapshot = {}, scores = {}) {
  const blockers = Array.isArray(scores.blockers) ? scores.blockers.map(String) : [];
  const reasons = [];
  const emergencyReasons = blockers.filter(securityCritical);
  const price = Number(snapshot.priceUsd ?? 0);
  const risk = Number(scores.risk ?? 100);
  const buys = Number(snapshot.buys30s ?? 0);
  const sells = Number(snapshot.sells30s ?? 0);
  const trades = buys + sells;
  const volume5m = Number(snapshot.volume5mUsd ?? 0);
  const liquidity = Number(snapshot.liquidityUsd ?? 0);
  const top10 = Number(snapshot.top10HolderPct ?? 0);
  const insider = Number(snapshot.insiderPct ?? 0);
  const bundler = Number(snapshot.bundlerPct ?? 0);
  const creator = Number(snapshot.creatorPct ?? snapshot.devPct ?? 0);
  let marketEmergency = false;

  // Fail closed: an automatic entry needs a real price, verified market data,
  // verified security data, and enough actual trading to prove the token is live.
  if (!(Number.isFinite(price) && price > 0)) reasons.push('price unavailable');
  if (snapshot.marketDataVerified !== true) reasons.push('market data not verified');
  if (snapshot.securityVerified !== true) reasons.push('security not verified');
  if (!(trades >= 5 || volume5m >= 1000)) reasons.push('insufficient verified trading activity');

  // Do not auto-enter a token that has only buys. At least one observed sell is
  // required so the radar has evidence that holders can exit the market.
  if (!(Number.isFinite(sells) && sells >= 1)) reasons.push('no verified sell observed');

  // When the provider exposes these controls, they must explicitly be safe.
  // Missing values remain fail-closed for automatic entry rather than being
  // interpreted as safe by default.
  if (snapshot.securityVerified === true) {
    if (snapshot.honeypot !== false) reasons.push('honeypot status not explicitly safe');
    if (snapshot.mintAuthorityDisabled !== true) reasons.push('mint authority not verified disabled');
    if (snapshot.freezeAuthorityDisabled !== true) reasons.push('freeze authority not verified disabled');
  }

  if (Number.isFinite(risk) && risk > 35) reasons.push(`risk score ${risk}/100`);
  for (const blocker of blockers.filter(securityCritical)) reasons.push(blocker);

  // Additional concentration safeguards. Zero means "not supplied" here, so it
  // is not treated as proof of safe distribution; known dangerous values block.
  if (top10 > 40) reasons.push(`top-10 concentration ${top10.toFixed(1)}%`);
  if (insider > 10) reasons.push(`insider concentration ${insider.toFixed(1)}%`);
  if (bundler > 12) reasons.push(`bundler concentration ${bundler.toFixed(1)}%`);
  if (creator > 8) reasons.push(`creator concentration ${creator.toFixed(1)}%`);
  if (snapshot.devSelling === true) reasons.push('developer is selling');

  // Once a token is on a conventional DEX/PumpSwap, very low liquidity is an
  // emergency signal. Pump.fun bonding-curve coins are excluded from the LP
  // rule because they trade against the curve before graduation.
  if (isDexVenue(snapshot.source) && Number.isFinite(liquidity) && liquidity < 5000) {
    const reason = `DEX liquidity critically low ($${Math.max(0, liquidity).toFixed(2)})`;
    reasons.push(reason);
    emergencyReasons.push(reason);
    marketEmergency = true;
  }

  return {
    ok: reasons.length === 0,
    reasons: [...new Set(reasons)],
    emergency: emergencyReasons.length > 0 && (snapshot.securityVerified === true || marketEmergency),
    emergencyReasons: [...new Set(emergencyReasons)]
  };
}
