import test from 'node:test';
import assert from 'node:assert/strict';
import { PaperTrader } from '../src/trading/paperTrader.mjs';

const baseScores = { entry: 75, moon: 75, risk: 20, blockers: [], reasons: [] };
const baseTime = Date.now();

function makeTrader() {
  return new PaperTrader({
    startingUsd: 1000,
    tradeSizeUsd: 100,
    maxOpen: 2,
    stopLossPct: 22,
    peakHunterStartPct: 200,
    probeMaxHoldMs: 60_000
  });
}

function snapshot(observedAt, priceUsd = 0.001) {
  return {
    address: '11111111111111111111111111111111',
    symbol: 'TEST',
    observedAt,
    priceUsd,
    buys5m: 10,
    sells5m: 5
  };
}

test('provider-pending paper probe exits after configured max hold', () => {
  const trader = makeTrader();
  const opened = trader.enterQualified(snapshot(baseTime), baseScores, {
    strategy: 'solana-ultra-probe',
    sizeMultiplier: 0.15
  });
  assert.equal(opened.ok, true);

  const result = trader.update(snapshot(baseTime + 61_000), baseScores);
  assert.ok(result.closed);
  assert.match(result.closed.exitReason, /paper probe max-hold/);
  assert.equal(trader.openPositions.length, 0);
});

test('promoted probe is no longer subject to probe max hold', () => {
  const trader = makeTrader();
  const opened = trader.enterQualified(snapshot(baseTime), baseScores, {
    strategy: 'solana-ultra-probe',
    sizeMultiplier: 0.15
  });
  assert.equal(opened.ok, true);

  const promoted = trader.promoteLifecycle(snapshot(baseTime).address, 'solana-ultra-qualified');
  assert.equal(promoted.ok, true);
  assert.equal(promoted.changed, true);
  assert.equal(promoted.position.strategy, 'solana-ultra-probe');
  assert.equal(promoted.position.lifecycleStrategy, 'solana-ultra-qualified');
  assert.equal(promoted.position.sizing.promotedTo, 'solana-ultra-qualified');

  const result = trader.update(snapshot(baseTime + 61_000), baseScores);
  assert.equal(result.closed, undefined);
  assert.equal(trader.openPositions.length, 1);
});
