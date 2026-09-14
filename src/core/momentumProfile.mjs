const finite = (value, fallback = 0) => {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
};

const bool = (value) => typeof value === 'boolean' ? value : undefined;

export function normalizeMomentumSnapshot(snapshot = {}) {
  const raw = snapshot.raw ?? {};
  const token = snapshot.tokens ?? {};
  const buys30s = finite(snapshot.buys30s ?? snapshot.buys_30s);
  const sells30s = finite(snapshot.sells30s ?? snapshot.sells_30s);
  const buyVolume30sUsd = finite(snapshot.buyVolume30sUsd ?? snapshot.buy_volume_30s_usd);
  const sellVolume30sUsd = finite(snapshot.sellVolume30sUsd ?? snapshot.sell_volume_30s_usd);
  const uniqueBuyers30s = finite(snapshot.uniqueBuyers30s ?? snapshot.unique_buyers_30s);
  const buyerAcceleration = finite(snapshot.buyerAcceleration ?? snapshot.buyer_acceleration);
  const volumeAcceleration = finite(snapshot.volumeAcceleration ?? snapshot.volume_acceleration);
  const priceUsd = finite(snapshot.priceUsd ?? snapshot.price_usd);
  const liquidityUsd = finite(snapshot.liquidityUsd ?? snapshot.liquidity_usd);
  const marketCapUsd = finite(snapshot.marketCapUsd ?? snapshot.market_cap_usd);
  const volume5mUsd = finite(snapshot.volume5mUsd ?? raw.volume5mUsd);
  const priceChange5mPct = finite(snapshot.priceChange5mPct ?? raw.priceChange5mPct);
  const priceChange1hPct = finite(snapshot.priceChange1hPct ?? raw.priceChange1hPct);
  const entryScore = finite(snapshot.entryScore ?? snapshot.entry_score);
  const moonScore = finite(snapshot.moonScore ?? snapshot.moon_score);
  const riskScore = finite(snapshot.riskScore ?? snapshot.risk_score, 100);
  const top10HolderPct = finite(snapshot.top10HolderPct ?? snapshot.top10_holder_pct);
  const creatorPct = finite(snapshot.creatorPct ?? snapshot.creator_pct);
  const insiderPct = finite(snapshot.insiderPct ?? snapshot.insider_pct);
  const bundlerPct = finite(snapshot.bundlerPct ?? snapshot.bundler_pct);
  const listedAtRaw = snapshot.listedAt ?? token.listed_at ?? raw.listedAt;
  const listedAt = typeof listedAtRaw === 'number' ? listedAtRaw : Date.parse(listedAtRaw ?? '') || 0;
  const ageSec = listedAt > 0 ? Math.max(0, (Date.now() - listedAt) / 1000) : null;
  const honeypot = bool(snapshot.honeypot);
  const mintAuthorityDisabled = bool(snapshot.mintAuthorityDisabled ?? snapshot.mint_authority_disabled);
  const freezeAuthorityDisabled = bool(snapshot.freezeAuthorityDisabled ?? snapshot.freeze_authority_disabled);
  const marketDataVerified = snapshot.marketDataVerified === true || raw.marketDataVerified === true || (priceUsd > 0 && (buys30s + sells30s > 0 || volume5mUsd > 0));
  const securityVerified = snapshot.securityVerified === true || raw.securityVerified === true || (honeypot !== undefined && mintAuthorityDisabled !== undefined && freezeAuthorityDisabled !== undefined);

  return {
    address: String(snapshot.address ?? token.address ?? ''),
    symbol: String(snapshot.symbol ?? token.symbol ?? 'TOKEN'),
    name: String(snapshot.name ?? token.name ?? snapshot.symbol ?? token.symbol ?? 'Token'),
    source: String(snapshot.source ?? token.source ?? raw.source ?? 'solana'),
    imageUrl: snapshot.imageUrl ?? raw.imageUrl ?? null,
    buys30s,
    sells30s,
    buyVolume30sUsd,
    sellVolume30sUsd,
    uniqueBuyers30s,
    buyerAcceleration,
    volumeAcceleration,
    priceUsd,
    liquidityUsd,
    marketCapUsd,
    volume5mUsd,
    priceChange5mPct,
    priceChange1hPct,
    entryScore,
    moonScore,
    riskScore,
    top10HolderPct,
    creatorPct,
    insiderPct,
    bundlerPct,
    honeypot,
    mintAuthorityDisabled,
    freezeAuthorityDisabled,
    marketDataVerified,
    securityVerified,
    ageSec
  };
}

const ignoredLaunchPattern = (snapshot = {}) => {
  const s = normalizeMomentumSnapshot(snapshot);
  const fresh = s.ageSec != null && s.ageSec <= 15 * 60;
  const peakChange = Math.max(s.priceChange5mPct, s.priceChange1hPct);
  const ratio = s.buys30s / Math.max(1, s.sells30s);
  const dominantBuyFlow = s.buys30s >= 8 && (s.sells30s < 1 || ratio >= 8);
  const oversized = s.marketCapUsd >= 1_000_000;
  const stretchedValuation = s.liquidityUsd > 0 && s.marketCapUsd / s.liquidityUsd >= 25;
  const knownConcentration = s.top10HolderPct > 40 || s.insiderPct > 10 || s.bundlerPct > 12 || s.creatorPct > 8;
  const freshVerticalDominance = fresh && dominantBuyFlow && oversized && peakChange >= 1000;
  const freshStretchedDominance = fresh && dominantBuyFlow && oversized && stretchedValuation && peakChange >= 300;
  const reasons = [];
  if (knownConcentration) reasons.push('concentrated insider/holder launch');
  if (freshVerticalDominance) reasons.push(`fresh vertical spike ${peakChange.toFixed(0)}% with extreme buy dominance`);
  if (freshStretchedDominance) reasons.push('fresh stretched valuation with extreme buy dominance');
  return { ignored: reasons.length > 0, reasons, normalized: s };
};

export function isRisingMomentum(snapshot = {}) {
  const ignored = ignoredLaunchPattern(snapshot);
  if (ignored.ignored) return false;
  const s = ignored.normalized;
  const ratio = s.buys30s / Math.max(1, s.sells30s);
  return s.priceChange5mPct >= 5
    || (ratio >= 1.8 && s.buys30s >= 4 && (s.volume5mUsd >= 1000 || s.buyVolume30sUsd >= 250))
    || (ratio >= 3 && s.buys30s >= 6)
    || (s.buyerAcceleration >= 1.5 && s.volumeAcceleration >= 1.5 && ratio >= 1.25);
}

export function persistedSafety(snapshot = {}) {
  const ignored = ignoredLaunchPattern(snapshot);
  const s = ignored.normalized;
  const pendingReasons = [];
  const dangerReasons = [];
  const trades = s.buys30s + s.sells30s;

  if (!(s.priceUsd > 0)) pendingReasons.push('price unavailable');
  if (!s.marketDataVerified) pendingReasons.push('market data not verified');
  if (!s.securityVerified) pendingReasons.push('security not verified');

  // Missing provider fields are pending evidence, not proof of a scam.
  if (s.honeypot === true) dangerReasons.push('honeypot flag');
  if (s.mintAuthorityDisabled === false) dangerReasons.push('mint authority active');
  else if (s.securityVerified && s.mintAuthorityDisabled !== true) pendingReasons.push('mint authority not verified disabled');
  if (s.freezeAuthorityDisabled === false) dangerReasons.push('freeze authority active');
  else if (s.securityVerified && s.freezeAuthorityDisabled !== true) pendingReasons.push('freeze authority not verified disabled');

  if (!(trades >= 5 || s.volume5mUsd >= 1000)) pendingReasons.push('insufficient verified trading activity');
  if (s.sells30s < 1) pendingReasons.push('no verified sell observed');
  if (s.riskScore > 35) pendingReasons.push(`risk ${Math.round(s.riskScore)}/100`);
  if (s.top10HolderPct > 40) dangerReasons.push('top-10 concentration');
  if (s.insiderPct > 10) dangerReasons.push('insider concentration');
  if (s.bundlerPct > 12) dangerReasons.push('bundler concentration');
  if (s.creatorPct > 8) dangerReasons.push('creator concentration');

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
    ok: status === 'safe',
    entryAllowed: status === 'safe',
    trackingAllowed: status !== 'dangerous' && status !== 'ignored',
    status,
    reasons,
    pendingReasons: uniquePendingReasons,
    dangerReasons: uniqueDangerReasons,
    ignoredReasons: ignored.reasons,
    normalized: s
  };
}

export function momentumScore(snapshot = {}) {
  const ignored = ignoredLaunchPattern(snapshot);
  if (ignored.ignored) return 0;
  const s = ignored.normalized;
  const ratio = s.buys30s / Math.max(1, s.sells30s);
  let score = 0;
  score += Math.max(-12, Math.min(24, s.priceChange5mPct * 0.8));
  score += Math.min(20, ratio * 6);
  score += Math.min(16, s.buys30s * 2);
  score += Math.min(10, s.uniqueBuyers30s * 1.5);
  score += Math.min(12, Math.log10(Math.max(1, s.volume5mUsd + s.buyVolume30sUsd)) * 3);
  score += Math.min(10, Math.max(0, s.buyerAcceleration - 1) * 6 + Math.max(0, s.volumeAcceleration - 1) * 4);
  score += Math.min(8, Math.max(0, s.entryScore - 70) * 0.4);
  score -= Math.max(0, s.riskScore - 20) * 0.35;
  if (s.sells30s <= 0) score -= 10;
  if (s.priceChange5mPct > 120) score -= 12;
  return Math.max(0, Math.min(100, Math.round(score)));
}

export function entryQuality(snapshot = {}) {
  const s = normalizeMomentumSnapshot(snapshot);
  const safety = persistedSafety(snapshot);
  const momentum = momentumScore(snapshot);
  if (safety.status === 'ignored') {
    return { key: 'ignored', ar: '🚫 نمط إطلاق مشبوه — متجاهل', en: '🚫 Suspicious launch pattern — ignored', momentum, reasons: safety.reasons };
  }
  if (safety.status === 'dangerous') {
    return { key: 'blocked', ar: '⛔ خطر مؤكد — متابعة فقط', en: '⛔ Confirmed risk — tracking only', momentum, reasons: safety.reasons };
  }
  if (safety.status === 'unknown') {
    return { key: 'pending', ar: '⚠️ الأمان قيد التحقق — متابعة فقط', en: '⚠️ Safety pending — tracking only', momentum, reasons: safety.reasons };
  }
  const late = s.priceChange5mPct >= 70 || (s.ageSec != null && s.ageSec > 600);
  if (late) return { key: 'late', ar: '⚠️ الدخول متأخر', en: '⚠️ Entry late', momentum, reasons: [] };
  if (momentum >= 82 && s.entryScore >= 85 && (s.ageSec == null || s.ageSec <= 240)) {
    return { key: 'excellent', ar: '🎯 دخول مبكر ممتاز', en: '🎯 Excellent early entry', momentum, reasons: [] };
  }
  if (momentum >= 65 && s.entryScore >= 78) return { key: 'good', ar: '🟢 دخول جيد', en: '🟢 Good entry', momentum, reasons: [] };
  return { key: 'watch', ar: '👀 مراقبة', en: '👀 Watch', momentum, reasons: [] };
}

export function ageLabel(snapshot = {}, language = 'ar') {
  const s = normalizeMomentumSnapshot(snapshot);
  if (s.ageSec == null) return '—';
  const sec = Math.round(s.ageSec);
  if (sec < 60) return language === 'en' ? `${sec}s` : `${sec}ث`;
  const min = Math.round(sec / 60);
  if (min < 60) return language === 'en' ? `${min}m` : `${min}د`;
  const hours = (min / 60).toFixed(1);
  return language === 'en' ? `${hours}h` : `${hours}س`;
}
