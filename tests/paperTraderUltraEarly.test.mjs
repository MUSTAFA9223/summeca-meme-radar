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

test('paper trader uses a small ultra-early position and exits quickly at +25%', () => {
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

  const result = trader.update(freshBurst({
    priceUsd: 1.25,
    observedAt: now + 10_000,
    buys30s: 9,
    sells30s: 2
  }), scores);

  assert.equal(result.closed?.status, 'closed');
  assert.match(result.closed?.exitReason ?? '', /quick take-profit/);
  assert.ok((result.closed?.pnlPct ?? 0) >= 24.9);

  try { fs.unlinkSync('paper-trades.jsonl'); } catch {}
});
