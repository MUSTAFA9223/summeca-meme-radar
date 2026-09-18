export function peakExitDecision({
  snapshot: s,
  scores,
  pnlPct,
  highWaterPnlPct,
  stopLossPct,
  peakHunterStartPct,
  profitLockTriggerPct = 30,
  profitLockFloorPct = 20
}) {
  if (scores.blockers.some(b => /honeypot|developer is selling|very low liquidity|freeze authority/.test(b))) {
    return { exit: true, reason: `emergency-risk: ${scores.blockers.join(', ')}` };
  }

  // Initial capital protection. Production is still PAPER ONLY; the configured
  // stop is intentionally evaluated before any profit-management logic.
  if (pnlPct <= -Math.abs(stopLossPct)) {
    return { exit: true, reason: 'paper stop-loss' };
  }

  // Once a trade has proved itself by reaching the trigger, protect a minimum
  // profit target. With discrete market snapshots this is a target, not a fill
  // guarantee: a fast gap can be observed below the configured floor.
  const lockTrigger = Math.max(0, Number(profitLockTriggerPct) || 0);
  const lockFloor = Math.max(0, Number(profitLockFloorPct) || 0);
  if (lockTrigger > lockFloor && highWaterPnlPct >= lockTrigger && pnlPct <= lockFloor) {
    return {
      exit: true,
      reason: `profit lock target +${lockFloor}%`,
      profitLockFloorPct: lockFloor,
      highWaterPnlPct
    };
  }

  if (pnlPct < peakHunterStartPct) return { exit: false };

  const trail = scores.moon >= 92 ? 38 : scores.moon >= 84 ? 28 : scores.moon >= 72 ? 20 : 13;
  const drawdown = highWaterPnlPct - pnlPct;
  const buys = Number.isFinite(Number(s.buys30s)) ? Number(s.buys30s) : Number(s.buys5m ?? 0);
  const sells = Number.isFinite(Number(s.sells30s)) ? Number(s.sells30s) : Number(s.sells5m ?? 0);
  const buySell = buys / Math.max(1, sells);
  const momentumBreaking = scores.moon < 70 || buySell < 1.15 || (s.buyerAcceleration ?? 1) < 0.8;

  if (momentumBreaking && drawdown >= Math.min(trail, 16)) {
    return { exit: true, reason: 'momentum reversal after peak', trailingDrawdownPct: drawdown };
  }
  if (drawdown >= trail) {
    return { exit: true, reason: `adaptive trailing exit (${trail}%)`, trailingDrawdownPct: drawdown };
  }
  return { exit: false, trailingDrawdownPct: drawdown };
}
