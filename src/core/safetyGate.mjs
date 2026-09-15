import { ignoredLaunchPattern } from './launchPattern.mjs';

const text = (value) => String(value ?? '').toLowerCase();

const securityCritical = (blocker) => /honeypot|freeze authority active|mint authority active|developer is selling|top-10 concentration|insider concentration|bundler concentration|non-transferable|transfer fee|fake token|token-2022 risky|permanent delegate|transfer hook|default account state|pausable|confidential/.test(text(blocker));

const isDexVenue = (source) => {
  const value = text(source);
  if (/pumpfun|pump_fun|bonding/.test(value)) return false;
  return /pumpswap|pump_amm|raydium|meteora|orca/.test(value)
    || (value.includes('dexscreener') && !value.includes('pump'));
};

export function evaluateSignalSafety(snapshot = {}, scores = {}) {
  const blockers = Array.isArray(scores.blockers) ? scores.blockers.map(String) : [];
  const pendingReasons = [];
  const dangerReasons = blockers.filter(securityCritical);
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

  // Entry remains fail-closed, but incomplete evidence is distinct from a
  // confirmed danger. Pending safety must not silence momentum/performance tracking.
  if (!(Number.isFinite(price) && price > 0)) pendingReasons.push('price unavailable');
  if (snapshot.marketDataVerified !== true) pendingReasons.push('market data not verified');
  if (snapshot.securityVerified !== true) pendingReasons.push('security not verified');
  if (!(trades >= 5 || volume5m >= 1000)) pendingReasons.push('insufficient verified trading activity');
  if (!(Number.isFinite(sells) && sells >= 1)) pendingReasons.push('no verified sell observed');

  // A failed/unfinished direct mint inspection blocks entry, but by itself does
  // not prove the token is malicious. Keep observing it while the check retries.
  if (snapshot.onchainSecurityVerified === false) pendingReasons.push('on-chain mint security not verified');

  if (snapshot.securityVerified === true) {
    if (snapshot.honeypot === true) dangerReasons.push('honeypot flag');

    if (snapshot.mintAuthorityDisabled === false) dangerReasons.push('mint authority active');
    else if (snapshot.mintAuthorityDisabled !== true) pendingReasons.push('mint authority not verified disabled');

    if (snapshot.freezeAuthorityDisabled === false) dangerReasons.push('freeze authority active');
    else if (snapshot.freezeAuthorityDisabled !== true) pendingReasons.push('freeze authority not verified disabled');

    if (snapshot.fakeToken === true) dangerReasons.push('fake token flag');
    if (snapshot.nonTransferable === true) dangerReasons.push('non-transferable token');
    if (snapshot.isToken2022 === true && snapshot.transferFeeEnable === true) dangerReasons.push('Token-2022 transfer fee enabled');
  }

  if (snapshot.isToken2022 === true) {
    if (snapshot.token2022ExtensionsVerified !== true) pendingReasons.push('Token-2022 extensions not verified');
    for (const extension of Array.isArray(snapshot.token2022UnsafeExtensions) ? snapshot.token2022UnsafeExtensions : []) {
      dangerReasons.push(`Token-2022 risky extension: ${extension}`);
    }
  }

  if (Number.isFinite(risk) && risk > 35) pendingReasons.push(`risk score ${risk}/100`);

  if (top10 > 40) dangerReasons.push(`top-10 concentration ${top10.toFixed(1)}%`);
  if (insider > 10) dangerReasons.push(`insider concentration ${insider.toFixed(1)}%`);
  if (bundler > 12) dangerReasons.push(`bundler concentration ${bundler.toFixed(1)}%`);
  if (creator > 8) dangerReasons.push(`creator concentration ${creator.toFixed(1)}%`);
  if (snapshot.devSelling === true) dangerReasons.push('developer is selling');

  // Conventional DEX liquidity below this level is an explicit market danger.
  // Pump.fun bonding-curve launches remain exempt before graduation.
  if (isDexVenue(snapshot.source) && Number.isFinite(liquidity) && liquidity < 5000) {
    dangerReasons.push(`DEX liquidity critically low ($${Math.max(0, liquidity).toFixed(2)})`);
  }

  const ignored = ignoredLaunchPattern(snapshot);
  const uniqueDangerReasons = [...new Set(dangerReasons)];
  const uniquePendingReasons = [...new Set(pendingReasons)].filter((reason) => !uniqueDangerReasons.includes(reason));
  const status = ignored.ignored
    ? 'ignored'
    : uniqueDangerReasons.length > 0
      ? 'dangerous'
      : uniquePendingReasons.length > 0
        ? 'unknown'
        : 'safe';
  const reasons = ignored.ignored
    ? [...ignored.reasons, ...uniqueDangerReasons, ...uniquePendingReasons]
    : [...uniqueDangerReasons, ...uniquePendingReasons];

  return {
    // `ok` intentionally remains the strict execution gate used by live trading.
    ok: status === 'safe',
    entryAllowed: status === 'safe',
    // Unknown means “keep watching, do not execute”. Ignored launch patterns are
    // intentionally excluded from alerts/tracking so vertical one-way noise does
    // not crowd the radar.
    trackingAllowed: status !== 'dangerous' && status !== 'ignored',
    status,
    reasons,
    pendingReasons: uniquePendingReasons,
    dangerReasons: uniqueDangerReasons,
    ignoredReasons: ignored.reasons,
    emergency: status === 'dangerous',
    emergencyReasons: uniqueDangerReasons
  };
}
