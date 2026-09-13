import test from 'node:test';
import assert from 'node:assert/strict';
import { PaperTrader } from '../src/trading/paperTrader.mjs';

const scores = { entry: 90, moon: 90, risk: 10, blockers: [] };
const makeSnapshot = (priceUsd) => ({
  address: '11111111111111111111111111111111',
  symbol: 'TEST',
  priceUsd,
  observedAt: Date.now(),
  devSelling: false,
  honeypot: false,
  liquidityUsd: 50_000
});

test('manual paper sell supports partial then full exit with correct cash and realized pnl', () => {
  const trader = new PaperTrader({
    startingUsd: 1000,
    tradeSizeUsd: 25,
    maxOpen: 2,
    stopLossPct: 10,
    peakHunterStartPct: 200
  });

  const entry = trader.enterManual(makeSnapshot(1), scores, { mode: 'usd', value: 100 });
  assert.equal(entry.ok, true);
  assert.equal(trader.availableUsd, 900);

  const partial = trader.manualSell(makeSnapshot(1.2), 50);
  assert.equal(partial.ok, true);
  assert.equal(partial.closed, false);
  assert.equal(Number(partial.remainingUsdSize.toFixed(2)), 50);
  assert.equal(Number(partial.legPnlUsd.toFixed(2)), 10);
  assert.equal(Number(trader.availableUsd.toFixed(2)), 960);

  const full = trader.manualSell(makeSnapshot(1.4), 100);
  assert.equal(full.ok, true);
  assert.equal(full.closed, true);
  assert.equal(Number(full.legPnlUsd.toFixed(2)), 20);
  assert.equal(Number(full.position.realizedPnlUsd.toFixed(2)), 30);
  assert.equal(Number(full.position.pnlPct.toFixed(2)), 30);
  assert.equal(Number(trader.availableUsd.toFixed(2)), 1030);
  assert.equal(trader.openPositions.length, 0);
});

test('manual paper sell rejects when there is no open position', () => {
  const trader = new PaperTrader({
    startingUsd: 1000,
    tradeSizeUsd: 25,
    maxOpen: 2,
    stopLossPct: 10,
    peakHunterStartPct: 200
  });
  const result = trader.manualSell(makeSnapshot(1), 100);
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'no-open-position');
});
