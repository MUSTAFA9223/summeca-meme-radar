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
  const priceChange5m = nz(s.priceChange5mPct);
  const volume5m = nz(s.volume5mUsd);
  const earlyBondingCurve = Boolean(s.directCreate)
    && ageSec <= 300
    && nz(s.priceUsd) > 0
    && volume5m > 0;

  let risk = 20;
  if (s.honeypot) { risk += 80; blockers.push('honeypot flag'); }
  if (s.freezeAuthorityDisabled === false) { risk += 30; blockers.push('freeze authority active'); }
  if (s.mintAuthorityDisabled === false) { risk += 20; blockers.push('mint authority active'); }
  if (nz(s.top10HolderPct) > 45) { risk += 25; blockers.push('top-10 concentration >45%'); }
  if (nz(s.insiderPct) > 12) { risk += 25; blockers.push('insider concentration >12%'); }
  if (nz(s.bundlerPct) > 15) { risk += 20; blockers.push('bundler concentration >15%'); }
  if (s.devSelling) { risk += 35; blockers.push('developer is selling'); }
  // Pump.fun coins trade on a bonding curve before graduation; conventional LP
  // liquidity may be zero there, so do not reject a live early curve solely for that.
  if (s.liquidityUsd < 5000 && !earlyBondingCurve) { risk += 25; blockers.push('very low liquidity'); }
  risk = clamp(risk);

  let entry = 0;
  if (ageSec <= 60) { entry += 15; reasons.push('very fresh listing'); }
  else if (ageSec <= 300) entry += 8;
  if (earlyBondingCurve) { entry += 10; reasons.push('active Pump.fun bonding curve'); }
  if (s.liquidityUsd >= 10_000) { entry += 12; reasons.push('usable early liquidity'); }
  if (s.liquidityUsd >= 30_000) entry += 6;
  if (buySell >= 2) { entry += 15; reasons.push(`buy/sell count ${buySell.toFixed(1)}x`); }
  if (buySell >= 4) entry += 8;
  if (volumeRatio >= 2) { entry += 14; reasons.push(`buy/sell volume ${volumeRatio.toFixed(1)}x`); }
  if (nz(s.buyerAcceleration) >= 1.5) { entry += 12; reasons.push('buyer velocity accelerating'); }
  if (nz(s.volumeAcceleration) >= 1.5) { entry += 10; reasons.push('volume accelerating'); }
  if (nz(s.liquidityChangePct) > 5) { entry += 6; reasons.push('liquidity rising'); }
  if (nz(s.uniqueBuyers30s) >= 25) entry += 7;
  if (priceChange5m >= 5) { entry += 8; reasons.push(`price rising ${priceChange5m.toFixed(1)}%/5m`); }
  if (priceChange5m >= 15) entry += 8;
  if (volume5m >= 5_000) { entry += 6; reasons.push('strong fresh trading volume'); }
  if (volume5m >= 20_000) entry += 6;
  if (priceChange5m <= -10) entry -= 12;
  entry -= Math.round(risk * 0.38);
  entry = clamp(entry);

  // High-confidence quality gate for live discovery. This deliberately favors
  // precision over recall: weak, unverified, one-sided, illiquid, or already
  // overextended launches can still be tracked internally, but their entry score
  // is capped below the default approved-signal threshold (82).
  const explicitLiveEvidence = typeof s.marketDataVerified === 'boolean'
    || typeof s.securityVerified === 'boolean';
  const qualityGateReasons = [];
  if (explicitLiveEvidence) {
    const isEvm = String(s.address ?? '').startsWith('0x') || String(s.networkType ?? '') === 'evm';
    const top10 = nz(s.top10HolderPct);
    const insider = nz(s.insiderPct);
    const bundler = nz(s.bundlerPct);
    const creator = nz(s.creatorPct ?? s.devPct);
    const uniqueBuyers = nz(s.uniqueBuyers30s);
    const verifiedUniqueBuyers = s.uniqueBuyersVerified === true;
    const liquidityPass = nz(s.liquidityUsd) >= 8_000
      || (earlyBondingCurve && volume5m >= 8_000 && buyVol >= 500);
    const activityPass = (buys >= 5 && sells >= 1 && buySell >= 1.6)
      || (buys >= 8 && sells >= 1 && buySell >= 1.35 && volume5m >= 12_000);
    const volumePass = volume5m >= 3_000 || buyVol >= 750;
    const freshPass = ageSec <= 240;
    const pricePass = priceChange5m >= -2 && priceChange5m <= 80;

    if (s.marketDataVerified !== true) qualityGateReasons.push('market data not verified');
    if (s.securityVerified !== true) qualityGateReasons.push('security not verified');
    if (!isEvm && s.onchainSecurityVerified === false) qualityGateReasons.push('on-chain mint security not verified');
    if (!isEvm && s.mintAuthorityDisabled !== true) qualityGateReasons.push('mint authority not verified disabled');
    if (!isEvm && s.freezeAuthorityDisabled !== true) qualityGateReasons.push('freeze authority not verified disabled');
    if (s.isToken2022 === true && s.token2022ExtensionsVerified !== true) qualityGateReasons.push('Token-2022 extensions not verified');
    if (Array.isArray(s.token2022UnsafeExtensions) && s.token2022UnsafeExtensions.length) qualityGateReasons.push('unsafe Token-2022 extension');
    if (!liquidityPass) qualityGateReasons.push('insufficient real liquidity/curve depth');
    if (!activityPass) qualityGateReasons.push('buy flow not confirmed by real sells');
    if (!volumePass) qualityGateReasons.push('insufficient fresh volume');
    if (!freshPass) qualityGateReasons.push('entry no longer early');
    if (!pricePass) qualityGateReasons.push(priceChange5m > 80 ? 'move already overextended' : 'price momentum is negative');
    if (verifiedUniqueBuyers && uniqueBuyers < 4) qualityGateReasons.push('too few unique buyers');
    if (top10 > 35) qualityGateReasons.push('top-10 concentration too high');
    if (insider > 8) qualityGateReasons.push('insider concentration too high');
    if (bundler > 10) qualityGateReasons.push('bundler concentration too high');
    if (creator > 6) qualityGateReasons.push('creator concentration too high');
    if (risk > 30) qualityGateReasons.push('risk score above high-confidence limit');

    if (qualityGateReasons.length) entry = Math.min(entry, 79);
  }

  let moon = entry * 0.45;
  if (earlyBondingCurve && priceChange5m >= 5) moon += 6;
  if (nz(s.buyerAcceleration) >= 2) moon += 15;
  if (nz(s.volumeAcceleration) >= 2) moon += 12;
  if (buySell >= 4) moon += 10;
  if (volumeRatio >= 4) moon += 8;
  if (priceChange5m >= 10) moon += 10;
  if (priceChange5m >= 25) moon += 8;
  if (volume5m >= 20_000) moon += 6;
  if (nz(s.top10HolderPct) > 0 && nz(s.top10HolderPct) <= 25) moon += 8;
  // Missing holder/creator fields normalize to zero. Do not award a safety bonus
  // for missing evidence; only reward an actually observed low percentage.
  if (nz(s.insiderPct) > 0 && nz(s.insiderPct) <= 5) moon += 5;
  const creatorPct = nz(s.creatorPct ?? s.devPct);
  if (creatorPct > 0 && creatorPct <= 3 && !s.devSelling) moon += 5;
  moon -= Math.round(risk * 0.28);
  moon = clamp(moon);

  return {
    entry,
    moon,
    risk,
    reasons,
    blockers,
    qualityGatePassed: qualityGateReasons.length === 0,
    qualityGateReasons
  };
}
