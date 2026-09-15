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

test('paper trader lets ultra-early winners run and exits on confirmed real decline from peak', () => {
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

  const at100 = trader.update(freshBurst({
    priceUsd: 2,
    observedAt: now + 20_000,
    buys30s: 14,
    sells30s: 3,
    buyVolume30sUsd: 1600,
    sellVolume30sUsd: 180,
    buyerAcceleration: 1.8
  }), scores);
  assert.equal(at100.closed, undefined);
  assert.ok((at100.pnlPct ?? 0) >= 99.9);

  // A small/noisy pullback while buyers still dominate must not trigger a sale.
  const noisyDip = trader.update(freshBurst({
    priceUsd: 1.91,
    observedAt: now + 25_000,
    buys30s: 12,
    sells30s: 4,
    buyVolume30sUsd: 1100,
    sellVolume30sUsd: 250,
    buyerAcceleration: 1.25
  }), scores);
  assert.equal(noisyDip.closed, undefined);

  // First meaningful weakening observation arms the reversal confirmation.
  const firstDecline = trader.update(freshBurst({
    priceUsd: 1.84,
    observedAt: now + 30_000,
    buys30s: 4,
    sells30s: 8,
    buyVolume30sUsd: 220,
    sellVolume30sUsd: 620,
    buyerAcceleration: 0.55
  }), scores);
  assert.equal(firstDecline.closed, undefined);

  // A second weak snapshot confirms a real decline; sell well above entry.
  const confirmedDecline = trader.update(freshBurst({
    priceUsd: 1.82,
    observedAt: now + 35_000,
    buys30s: 3,
    sells30s: 9,
    buyVolume30sUsd: 180,
    sellVolume30sUsd: 700,
    buyerAcceleration: 0.45
  }), scores);
  assert.equal(confirmedDecline.closed?.status, 'closed');
  assert.match(confirmedDecline.closed?.exitReason ?? '', /confirmed real decline/);
  assert.ok((confirmedDecline.closed?.pnlPct ?? 0) >= 81.9);

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
