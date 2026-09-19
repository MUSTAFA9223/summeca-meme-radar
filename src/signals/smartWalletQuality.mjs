const finite = (value, fallback = 0) => Number.isFinite(Number(value)) ? Number(value) : fallback;
const clamp = (value, min, max) => Math.max(min, Math.min(max, value));

export function classifySmartEntry({
  observedAtMs = Date.now(),
  pairCreatedAt = 0,
  movePct = 0,
  lateMovePct = 180,
  earlyWindowMs = 60_000,
  lateAgeMs = 5 * 60_000
} = {}) {
  const observed = finite(observedAtMs, Date.now());
  const pairAt = finite(pairCreatedAt);
  const ageMs = pairAt > 0 && observed >= pairAt ? observed - pairAt : null;
  const move = finite(movePct);
  const late = move >= finite(lateMovePct, 180) || (ageMs != null && ageMs > finite(lateAgeMs, 300_000));
  const early = !late && ageMs != null && ageMs <= finite(earlyWindowMs, 60_000);
  return {
    ageMs,
    timing: late ? 'late' : early ? 'early' : 'normal',
    late,
    early,
    riskLabel: late ? 'HIGH_RISK_LATE' : early ? 'EARLY' : 'NORMAL'
  };
}

export function dynamicSmartWalletScore(wallet = {}, performance = null, {
  recentWeight = 0.55,
  discoveryWeight = 0.45,
  now = Date.now()
} = {}) {
  const discoveryScore = clamp(finite(wallet?.score), 0, 100);
  if (!performance || !(finite(performance?.samples) > 0)) return discoveryScore;

  const perfScore = clamp(finite(performance?.performanceScore), 0, 100);
  const samples24h = Math.max(0, finite(performance?.samples24h));
  const samples7d = Math.max(0, finite(performance?.samples7d));
  const hit50Rate24h = clamp(finite(performance?.hit50Rate24h), 0, 100);
  const lastSignalMs = Date.parse(String(performance?.lastSignalAt || '')) || 0;
  const staleDays = lastSignalMs > 0 ? Math.max(0, (finite(now) - lastSignalMs) / 86_400_000) : 30;

  let recentAdjustment = 0;
  if (samples24h >= 2) recentAdjustment += hit50Rate24h >= 50 ? 6 : -6;
  else if (samples7d >= 3) recentAdjustment += finite(performance?.hit50Rate7d) >= 40 ? 3 : -3;
  if (staleDays > 7) recentAdjustment -= 5;

  return clamp(Math.round(
    discoveryScore * clamp(discoveryWeight, 0, 1)
    + perfScore * clamp(recentWeight, 0, 1)
    + recentAdjustment
  ), 0, 100);
}

export function smartClusterScore(entries = [], market = {}) {
  const unique = new Map();
  for (const row of Array.isArray(entries) ? entries : []) {
    const address = String(row?.walletAddress || row?.address || '').trim();
    if (!address) continue;
    const prior = unique.get(address);
    if (!prior || finite(row?.observedAtMs) < finite(prior?.observedAtMs)) unique.set(address, row);
  }
  const rows = [...unique.values()];
  const avgWallet = rows.length
    ? rows.reduce((sum, row) => sum + finite(row?.dynamicScore, row?.walletScore), 0) / rows.length
    : 0;
  const countBoost = rows.length >= 4 ? 22 : rows.length === 3 ? 16 : rows.length === 2 ? 10 : 0;
  const buys = finite(market?.buys5m);
  const sells = finite(market?.sells5m);
  const ratio = buys / Math.max(1, sells);
  let flow = 0;
  if (finite(market?.liquidityUsd) >= 8_000) flow += 6;
  if (finite(market?.volume5mUsd) >= 1_500) flow += 5;
  if (buys >= 10 && sells >= 2) flow += 4;
  if (ratio >= 1.5 && ratio <= 8) flow += 5;
  const latePenalty = finite(market?.priceChange5mPct) >= 180 ? 20 : finite(market?.priceChange5mPct) >= 100 ? 8 : 0;
  return clamp(Math.round(avgWallet * 0.7 + countBoost + flow - latePenalty), 0, 100);
}

export function mergeSmartCluster(existing, entry, {
  now = Date.now(),
  windowMs = 120_000
} = {}) {
  const current = existing && typeof existing === 'object' ? { ...existing } : null;
  const at = finite(entry?.observedAtMs, finite(now));
  const expired = !current || finite(now) - finite(current.lastAt, current.firstAt) > finite(windowMs, 120_000);
  const base = expired ? {
    firstAt: at,
    lastAt: at,
    lastNotifiedCount: 0,
    entries: []
  } : {
    ...current,
    entries: Array.isArray(current.entries) ? [...current.entries] : []
  };

  const address = String(entry?.walletAddress || entry?.address || '').trim();
  const txHash = String(entry?.txHash || '').trim();
  const duplicate = base.entries.some((row) => String(row?.walletAddress || row?.address || '').trim() === address);
  const coordinated = Boolean(
    txHash
    && base.entries.some((row) => String(row?.txHash || '').trim() === txHash)
  );
  if (!duplicate && !coordinated && address) base.entries.push({ ...entry, observedAtMs: at });
  base.lastAt = Math.max(finite(base.lastAt), at);
  base.entries = base.entries
    .filter((row) => finite(now) - finite(row?.observedAtMs, now) <= finite(windowMs, 120_000))
    .sort((a, b) => finite(a?.observedAtMs) - finite(b?.observedAtMs));

  const uniqueWallets = base.entries.length;
  const shouldNotify = uniqueWallets >= 2
    && (finite(base.lastNotifiedCount) === 0 || uniqueWallets >= finite(base.lastNotifiedCount) + 2);

  return { ...base, uniqueWallets, duplicate, coordinated, shouldNotify };
}

export function shouldSuppressWalletToken(lastAt, {
  now = Date.now(),
  ttlMs = 10 * 60_000
} = {}) {
  const at = finite(lastAt);
  return at > 0 && finite(now) - at < finite(ttlMs, 600_000);
}
