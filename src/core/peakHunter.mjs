export function peakExitDecision({ snapshot: s, scores, pnlPct, highWaterPnlPct, stopLossPct, peakHunterStartPct }) {
  if (scores.blockers.some(b => /honeypot|developer is selling|very low liquidity|freeze authority/.test(b))) {
    return { exit: true, reason: `emergency-risk: ${scores.blockers.join(', ')}` };
  }
  if (pnlPct <= -Math.abs(stopLossPct)) return { exit: true, reason: 'paper stop-loss' };
  if (pnlPct < peakHunterStartPct) return { exit: false };

  const trail = scores.moon >= 92 ? 38 : scores.moon >= 84 ? 28 : scores.moon >= 72 ? 20 : 13;
  const drawdown = highWaterPnlPct - pnlPct;
  const buySell = (s.buys30s ?? 0) / Math.max(1, s.sells30s ?? 0);
  const momentumBreaking = scores.moon < 70 || buySell < 1.15 || (s.buyerAcceleration ?? 1) < 0.8;

  if (momentumBreaking && drawdown >= Math.min(trail, 16)) {
    return { exit: true, reason: 'momentum reversal after peak', trailingDrawdownPct: drawdown };
  }
  if (drawdown >= trail) {
    return { exit: true, reason: `adaptive trailing exit (${trail}%)`, trailingDrawdownPct: drawdown };
  }
  return { exit: false, trailingDrawdownPct: drawdown };
}
