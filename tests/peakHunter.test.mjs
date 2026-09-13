import test from 'node:test';
import assert from 'node:assert/strict';
import { peakExitDecision } from '../src/core/peakHunter.mjs';

const snapshot = {
  buys30s: 10,
  sells30s: 2,
  buyerAcceleration: 1.5
};
const scores = { moon: 90, blockers: [] };

const decide = (overrides = {}) => peakExitDecision({
  snapshot,
  scores,
  pnlPct: 0,
  highWaterPnlPct: 0,
  stopLossPct: 10,
  peakHunterStartPct: 200,
  ...overrides
});

test('exits at the configured 10% initial paper stop', () => {
  const decision = decide({ pnlPct: -10.1, highWaterPnlPct: 0 });
  assert.equal(decision.exit, true);
  assert.equal(decision.reason, 'paper stop-loss');
});

test('does not profit-lock before the trade reaches +30%', () => {
  const decision = decide({ pnlPct: 19, highWaterPnlPct: 29.9 });
  assert.equal(decision.exit, false);
});

test('locks profit after +30% high-water mark when return falls to +20%', () => {
  const decision = decide({ pnlPct: 20, highWaterPnlPct: 35 });
  assert.equal(decision.exit, true);
  assert.equal(decision.reason, 'profit lock target +20%');
  assert.equal(decision.profitLockFloorPct, 20);
});

test('keeps the trade open above the +20% profit-lock floor', () => {
  const decision = decide({ pnlPct: 24, highWaterPnlPct: 35 });
  assert.equal(decision.exit, false);
});
