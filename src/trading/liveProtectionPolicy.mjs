const finite = (value, fallback = 0) => {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
};

const clamp = (value, min, max) => Math.max(min, Math.min(max, finite(value, min)));

export function protectionSettings(source = process.env) {
  const stopLossPct = clamp(source.LIVE_PROTECTION_STOP_LOSS_PCT ?? source.LIVE_STOP_LOSS_PCT ?? 10, 2, 40);
  const trailStartPct = clamp(source.LIVE_PROTECTION_TRAIL_START_PCT ?? 12, 1, 500);
  const trailPct = clamp(source.LIVE_PROTECTION_TRAIL_PCT ?? 8, 1, 50);
  const tightTrailStartPct = clamp(source.LIVE_PROTECTION_TIGHT_TRAIL_START_PCT ?? 35, trailStartPct, 1000);
  const tightTrailPct = clamp(source.LIVE_PROTECTION_TIGHT_TRAIL_PCT ?? 5, 0.5, trailPct);
  const profitLockTriggerPct = clamp(source.LIVE_PROTECTION_PROFIT_LOCK_TRIGGER_PCT ?? source.LIVE_PROFIT_LOCK_TRIGGER_PCT ?? 30, 2, 1000);
  const profitLockFloorPct = clamp(source.LIVE_PROTECTION_PROFIT_LOCK_FLOOR_PCT ?? source.LIVE_PROFIT_LOCK_FLOOR_PCT ?? 20, 0, 900);

  return {
    pollMs: Math.round(clamp(source.LIVE_PROTECTION_POLL_MS ?? 1500, 750, 30_000)),
    marketRefreshMs: Math.round(clamp(source.LIVE_PROTECTION_MARKET_REFRESH_MS ?? 3000, 1000, 30_000)),
    quoteRefreshMs: Math.round(clamp(source.LIVE_PROTECTION_QUOTE_REFRESH_MS ?? 3000, 1000, 30_000)),
    securityRefreshMs: Math.round(clamp(source.LIVE_PROTECTION_SECURITY_REFRESH_MS ?? 20_000, 5000, 300_000)),
    uncertaintyGraceMs: Math.round(clamp(source.LIVE_PROTECTION_UNCERTAINTY_GRACE_MS ?? 12_000, 3000, 120_000)),
    riskSignalMaxAgeMs: Math.round(clamp(source.LIVE_PROTECTION_RISK_SIGNAL_MAX_AGE_MS ?? 120_000, 15_000, 900_000)),
    stopLossPct,
    trailStartPct,
    trailPct,
    tightTrailStartPct,
    tightTrailPct,
    profitLockTriggerPct,
    profitLockFloorPct: Math.min(profitLockFloorPct, Math.max(0, profitLockTriggerPct - 0.1)),
    minLiquidityUsd: clamp(source.LIVE_PROTECTION_MIN_LIQUIDITY_USD ?? 2000, 100, 250_000),
    liquidityCollapseRatio: clamp(source.LIVE_PROTECTION_LIQUIDITY_COLLAPSE_RATIO ?? 0.25, 0.02, 0.95),
    sellabilityFailures: Math.round(clamp(source.LIVE_PROTECTION_SELLABILITY_FAILURES ?? 2, 1, 8)),
    quoteSlippageBps: Math.round(clamp(source.LIVE_PROTECTION_QUOTE_SLIPPAGE_BPS ?? 700, 50, 5000))
  };
}

export function initialProtectionState(entryPriceUsd, settings = protectionSettings()) {
  const entry = finite(entryPriceUsd, 0);
  return {
    entryPriceUsd: entry > 0 ? entry : null,
    highestPriceUsd: entry > 0 ? entry : null,
    highWaterPnlPct: 0,
    currentStop: -Math.abs(settings.stopLossPct),
    stopReason: 'initial-stop'
  };
}

export function advanceProtectionState({
  entryPriceUsd,
  currentPriceUsd,
  routePnlPct,
  previousHighestPriceUsd,
  previousHighWaterPnlPct,
  previousCurrentStop
}, settings = protectionSettings()) {
  const entry = finite(entryPriceUsd, 0);
  const current = finite(currentPriceUsd, 0);
  const priorHigh = finite(previousHighWaterPnlPct, 0);
  const priorStop = Number.isFinite(Number(previousCurrentStop))
    ? Number(previousCurrentStop)
    : -Math.abs(settings.stopLossPct);

  let pnlPct = Number.isFinite(Number(routePnlPct)) ? Number(routePnlPct) : null;
  if (entry > 0 && current > 0) pnlPct = (current / entry - 1) * 100;
  if (!Number.isFinite(pnlPct)) return {
    measurable: false,
    pnlPct: null,
    highestPriceUsd: finite(previousHighestPriceUsd, 0) || null,
    highWaterPnlPct: priorHigh,
    currentStop: priorStop,
    stopReason: 'price-unavailable',
    triggered: false
  };

  const highestPriceUsd = Math.max(finite(previousHighestPriceUsd, 0), current > 0 ? current : 0) || null;
  const highWaterPnlPct = Math.max(priorHigh, pnlPct);

  const candidates = [
    { value: -Math.abs(settings.stopLossPct), reason: 'initial-stop' }
  ];
  if (highWaterPnlPct >= settings.trailStartPct) {
    candidates.push({ value: highWaterPnlPct - settings.trailPct, reason: `trailing-${settings.trailPct}%` });
  }
  if (highWaterPnlPct >= settings.profitLockTriggerPct) {
    candidates.push({ value: settings.profitLockFloorPct, reason: `profit-lock+${settings.profitLockFloorPct}%` });
  }
  if (highWaterPnlPct >= settings.tightTrailStartPct) {
    candidates.push({ value: highWaterPnlPct - settings.tightTrailPct, reason: `tight-trailing-${settings.tightTrailPct}%` });
  }

  let chosen = { value: priorStop, reason: 'previous-stop' };
  for (const candidate of candidates) {
    if (candidate.value > chosen.value) chosen = candidate;
  }
  const currentStop = Math.max(priorStop, chosen.value);
  const stopReason = currentStop > priorStop ? chosen.reason : 'hold-stop';

  return {
    measurable: true,
    pnlPct,
    highestPriceUsd,
    highWaterPnlPct,
    currentStop,
    stopReason,
    triggered: pnlPct <= currentStop
  };
}

export function liquidityEmergency({ currentLiquidityUsd, entryLiquidityUsd }, settings = protectionSettings()) {
  const current = finite(currentLiquidityUsd, NaN);
  if (!Number.isFinite(current) || current < 0) return { emergency: false, thresholdUsd: null };
  const entry = finite(entryLiquidityUsd, 0);
  const relativeFloor = entry > 0 ? entry * settings.liquidityCollapseRatio : 0;
  const thresholdUsd = Math.max(settings.minLiquidityUsd, relativeFloor);
  return {
    emergency: current < thresholdUsd,
    thresholdUsd
  };
}
