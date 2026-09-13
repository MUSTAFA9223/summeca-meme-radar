import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import { PaperTrader } from '../src/trading/paperTrader.mjs';

const scores = { entry: 90, moon: 90, risk: 20, blockers: [] };
const snap = (address, symbol = 'TEST') => ({
  address,
  symbol,
  priceUsd: 1,
  observedAt: Date.now(),
  buys30s: 10,
  sells30s: 2,
  buyerAcceleration: 2
});

test('manual paper entries support percent and fixed USD sizing', () => {
  const trader = new PaperTrader({
    startingUsd: 1000,
    tradeSizeUsd: 100,
    maxOpen: 4,
    stopLossPct: 10,
    peakHunterStartPct: 200
  });

  const first = trader.enterManual(snap('11111111111111111111111111111111', 'P20'), scores, { mode: 'percent', value: 20 });
  assert.equal(first.ok, true);
  assert.equal(first.position.usdSize, 200);
  assert.equal(trader.availableUsd, 800);

  const second = trader.enterManual(snap('22222222222222222222222222222222', 'D50'), scores, { mode: 'usd', value: 50 });
  assert.equal(second.ok, true);
  assert.equal(second.position.usdSize, 50);
  assert.equal(trader.availableUsd, 750);

  const third = trader.enterManual(snap('33333333333333333333333333333333', 'P100'), scores, { mode: 'percent', value: 100 });
  assert.equal(third.ok, true);
  assert.equal(third.position.usdSize, 750);
  assert.equal(trader.availableUsd, 0);

  const fourth = trader.enterManual(snap('44444444444444444444444444444444', 'NONE'), scores, { mode: 'usd', value: 10 });
  assert.equal(fourth.ok, false);
  assert.equal(fourth.reason, 'no-paper-cash');

  try { fs.unlinkSync('paper-trades.jsonl'); } catch {}
});
