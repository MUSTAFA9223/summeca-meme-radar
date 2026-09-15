import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import { isRisingMomentum, ultraEarlyMomentumProfile } from '../src/core/momentumProfile.mjs';
import { PaperTrader } from '../src/trading/paperTrader.mjs';

const now = Date.now();
const address = '11111111111111111111111111111111';
const scores = { entry: 72, moon: 86, risk: 20, blockers: [] };

const freshBurst = (overrides = {}) => ({
  address,
  symbol: 'BURST',
  priceUsd: 1,
  listedAt: now - 30_000,
  observedAt: now,
  liquidityUsd: 8_000,
  buys30s: 6,
  sells30s: 1,
  buyVolume30sUsd: 320,
  sellVolume30sUsd: 35,
  volume5mUsd: 900,
  priceChange5mPct: 4,
  buyerAcceleration: 1.5,
  volumeAcceleration: 1.4,
  marketDataVerified: true,
  ...overrides
});

test('ultra-early profile detects a fresh verified momentum burst', () => {
  const snapshot = freshBurst();
  const profile = ultraEarlyMomentumProfile(snapshot, scores);
  assert.equal(profile.eligible, true);
  assert.equal(isRisingMomentum(snapshot), true);
  assert.ok(profile.ageSec <= 90);
  assert.ok(profile.ratio >= 2);
});

test('paper trader lets ultra-early winners run and exits on return to entry', () => {
  const trader = new PaperTrader({
    startingUsd: 1000,
    tradeSizeUsd: 100,
    maxOpen: 2,
    stopLossPct: 10,
    peakHunterStartPct: 200
  });

  const entry = trader.maybeEnter(freshBurst(), scores, 82);
  assert.ok(entry);
  assert.equal(entry.strategy, 'ultra-early-momentum');
  assert.equal(entry.usdSize, 35);

  const at25 = trader.update(freshBurst({
    priceUsd: 1.25,
    observedAt: now + 10_000,
    buys30s: 9,
    sells30s: 2
  }), scores);
  assert.equal(at25.closed, undefined);
  assert.ok((at25.pnlPct ?? 0) >= 24.9);

  const at80AfterLongHold = trader.update(freshBurst({
    priceUsd: 1.8,
    observedAt: now + 90_000,
    buys30s: 4,
    sells30s: 5,
    buyerAcceleration: 0.5
  }), scores);
  assert.equal(at80AfterLongHold.closed, undefined);
  assert.ok((at80AfterLongHold.pnlPct ?? 0) >= 79.9);

  const backToEntry = trader.update(freshBurst({
    priceUsd: 1,
    observedAt: now + 95_000,
    buys30s: 2,
    sells30s: 7,
    buyerAcceleration: 0.3
  }), scores);
  assert.equal(backToEntry.closed?.status, 'closed');
  assert.match(backToEntry.closed?.exitReason ?? '', /return to entry/);

  try { fs.unlinkSync('paper-trades.jsonl'); } catch {}
});

test('ultra-early strategy still keeps an emergency hard stop for immediate failure', () => {
  const trader = new PaperTrader({
    startingUsd: 1000,
    tradeSizeUsd: 100,
    maxOpen: 2,
    stopLossPct: 10,
    peakHunterStartPct: 200
  });

  const entry = trader.maybeEnter(freshBurst(), scores, 82);
  assert.ok(entry);

  const result = trader.update(freshBurst({
    priceUsd: 0.94,
    observedAt: now + 5_000,
    buys30s: 1,
    sells30s: 5
  }), scores);

  assert.equal(result.closed?.status, 'closed');
  assert.match(result.closed?.exitReason ?? '', /hard stop-loss/);

  try { fs.unlinkSync('paper-trades.jsonl'); } catch {}
});
