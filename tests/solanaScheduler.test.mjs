import test from 'node:test';
import assert from 'node:assert/strict';
import { advanceSolanaEarlyConfirmation, isSolanaBreakoutEligible, isSolanaEarlyAlertEligible, isSolanaPaperProbeEligible, selectSolanaMarketCandidates, solanaProfileRetryDelayMs } from '../src/signals/solanaUltraEarlyWorker.mjs';

test('fresh initial-buy candidates outrank restored backlog', () => {
  const now = 1_000_000;
  const entries = [];
  for (let i = 0; i < 60; i += 1) {
    entries.push([`old-${i}`, {
      createdAt: now - 7 * 60_000 - i,
      lastMarketAt: 0,
      initialBuy: i % 3 === 0
    }]);
  }
  entries.push(['fresh-a', { createdAt: now - 5_000, lastMarketAt: 0, initialBuy: true }]);
  entries.push(['fresh-b', { createdAt: now - 10_000, lastMarketAt: 0, initialBuy: true }]);
  entries.push(['fresh-no-buy', { createdAt: now - 1_000, lastMarketAt: 0, initialBuy: false }]);

  const selected = selectSolanaMarketCandidates(entries, {
    now,
    pollMs: 1_500,
    limit: 30,
    maxCandidateAgeMs: 8 * 60_000,
    openPaperAddresses: new Set()
  }).map(([mint]) => mint);

  assert.equal(selected[0], 'fresh-a');
  assert.equal(selected[1], 'fresh-b');
  assert.ok(selected.includes('fresh-no-buy'));
});

test('open paper positions have highest scheduling priority and survive candidate TTL', () => {
  const now = 2_000_000;
  const entries = [
    ['stale-paper', { createdAt: now - 30 * 60_000, lastMarketAt: 0, initialBuy: true }],
    ['fresh-buy', { createdAt: now - 2_000, lastMarketAt: 0, initialBuy: true }],
    ['expired', { createdAt: now - 9 * 60_000, lastMarketAt: 0, initialBuy: true }]
  ];

  const selected = selectSolanaMarketCandidates(entries, {
    now,
    pollMs: 1_500,
    limit: 30,
    maxCandidateAgeMs: 8 * 60_000,
    openPaperAddresses: new Set(['stale-paper'])
  }).map(([mint]) => mint);

  assert.deepEqual(selected, ['stale-paper', 'fresh-buy']);
});

test('recently checked candidates are not rescheduled before poll interval', () => {
  const now = 3_000_000;
  const entries = [
    ['too-soon', { createdAt: now - 1_000, lastMarketAt: now - 500, initialBuy: true }],
    ['due', { createdAt: now - 2_000, lastMarketAt: now - 2_000, initialBuy: true }]
  ];

  const selected = selectSolanaMarketCandidates(entries, {
    now,
    pollMs: 1_500,
    limit: 30,
    maxCandidateAgeMs: 8 * 60_000
  }).map(([mint]) => mint);

  assert.deepEqual(selected, ['due']);
});


test('paper probe eligibility uses the plausible gate result plus score threshold', () => {
  assert.equal(isSolanaPaperProbeEligible({ rejectionReason: null, score: 70, minScore: 68 }), true);
  assert.equal(isSolanaPaperProbeEligible({ rejectionReason: null, score: 67, minScore: 68 }), false);
  assert.equal(isSolanaPaperProbeEligible({ rejectionReason: 'weak-buy-sell-ratio', score: 90, minScore: 68 }), false);
});


test('early alert lane surfaces strong market flow without waiting for holder profile', () => {
  const market = {
    priceUsd: 0.001,
    liquidityUsd: 12_000,
    marketCapUsd: 320_000,
    buys5m: 18,
    sells5m: 6,
    volume5mUsd: 2_400,
    priceChange5mPct: 24
  };
  assert.equal(isSolanaEarlyAlertEligible({
    rejectionReason: null,
    score: 80,
    ageMs: 60_000,
    market
  }), true);
});

test('early alert lane still rejects weak or one-way unsafe market flow', () => {
  const base = {
    priceUsd: 0.001,
    liquidityUsd: 12_000,
    marketCapUsd: 320_000,
    buys5m: 18,
    sells5m: 6,
    volume5mUsd: 2_400,
    priceChange5mPct: 24
  };
  const common = { ageMs: 60_000 };
  assert.equal(isSolanaEarlyAlertEligible({ ...common, rejectionReason: 'weak-buy-sell-ratio', score: 80, market: base }), false);
  assert.equal(isSolanaEarlyAlertEligible({ ...common, rejectionReason: null, score: 80, market: { ...base, sells5m: 0 } }), false);
  assert.equal(isSolanaEarlyAlertEligible({ ...common, rejectionReason: null, score: 80, market: { ...base, volume5mUsd: 100 } }), false);
  assert.equal(isSolanaEarlyAlertEligible({ ...common, rejectionReason: null, score: 70, market: base }), false);
});


test('strict early alert requires liquidity, volume, balanced momentum, and age window', () => {
  const good = {
    priceUsd: 0.0012,
    liquidityUsd: 14_000,
    marketCapUsd: 180_000,
    buys5m: 22,
    sells5m: 8,
    volume5mUsd: 4_500,
    priceChange5mPct: 18
  };
  assert.equal(isSolanaEarlyAlertEligible({ rejectionReason: null, score: 82, ageMs: 60_000, market: good }), true);
  assert.equal(isSolanaEarlyAlertEligible({ rejectionReason: null, score: 82, ageMs: 60_000, market: { ...good, liquidityUsd: 2_000 } }), false);
  assert.equal(isSolanaEarlyAlertEligible({ rejectionReason: null, score: 82, ageMs: 60_000, market: { ...good, buys5m: 5 } }), false);
  assert.equal(isSolanaEarlyAlertEligible({ rejectionReason: null, score: 82, ageMs: 60_000, market: { ...good, sells5m: 1, buys5m: 30 } }), false);
  assert.equal(isSolanaEarlyAlertEligible({ rejectionReason: null, score: 82, ageMs: 60_000, market: { ...good, priceChange5mPct: 48 } }), false);
});

test('early momentum requires two separated confirmations and resets on price reversal', () => {
  const first = advanceSolanaEarlyConfirmation({
    currentPriceUsd: 0.001,
    now: 10_000,
    minGapMs: 8_000,
    confirmations: 2
  });
  assert.equal(first.count, 1);
  assert.equal(first.confirmed, false);

  const tooSoon = advanceSolanaEarlyConfirmation({
    count: first.count,
    lastAt: first.lastAt,
    lastPriceUsd: first.lastPriceUsd,
    currentPriceUsd: 0.00101,
    now: 14_000,
    minGapMs: 8_000,
    confirmations: 2
  });
  assert.equal(tooSoon.count, 1);
  assert.equal(tooSoon.confirmed, false);

  const second = advanceSolanaEarlyConfirmation({
    count: first.count,
    lastAt: first.lastAt,
    lastPriceUsd: first.lastPriceUsd,
    currentPriceUsd: 0.00102,
    now: 18_500,
    minGapMs: 8_000,
    confirmations: 2
  });
  assert.equal(second.count, 2);
  assert.equal(second.confirmed, true);

  const reversal = advanceSolanaEarlyConfirmation({
    count: 1,
    lastAt: 10_000,
    lastPriceUsd: 0.001,
    currentPriceUsd: 0.0008,
    now: 20_000,
    minGapMs: 8_000,
    confirmations: 2
  });
  assert.equal(reversal.count, 1);
  assert.equal(reversal.confirmed, false);
});


test('breakout lane catches strong sustained moves that strict early lane rejects as overextended', () => {
  const market = {
    priceUsd: 0.0015,
    liquidityUsd: 18_000,
    marketCapUsd: 220_000,
    buys5m: 42,
    sells5m: 12,
    volume5mUsd: 9_000,
    priceChange5mPct: 88
  };
  assert.equal(isSolanaEarlyAlertEligible({ rejectionReason: 'move-overextended', score: 90, ageMs: 80_000, market }), false);
  assert.equal(isSolanaBreakoutEligible({ ageMs: 80_000, market }), true);
});

test('breakout lane rejects one-way, low-liquidity, or weak-volume spikes', () => {
  const base = {
    priceUsd: 0.0015,
    liquidityUsd: 18_000,
    marketCapUsd: 220_000,
    buys5m: 42,
    sells5m: 12,
    volume5mUsd: 9_000,
    priceChange5mPct: 88
  };
  assert.equal(isSolanaBreakoutEligible({ ageMs: 80_000, market: { ...base, liquidityUsd: 2_000 } }), false);
  assert.equal(isSolanaBreakoutEligible({ ageMs: 80_000, market: { ...base, sells5m: 0 } }), false);
  assert.equal(isSolanaBreakoutEligible({ ageMs: 80_000, market: { ...base, volume5mUsd: 500 } }), false);
});


test('tuned breakout lane accepts moderate verified liquidity and flow only after a strong move', () => {
  const market = {
    priceUsd: 0.0002,
    liquidityUsd: 6_000,
    marketCapUsd: 90_000,
    buys5m: 12,
    sells5m: 4,
    volume5mUsd: 1_800,
    priceChange5mPct: 52
  };
  assert.equal(isSolanaBreakoutEligible({ ageMs: 70_000, market }), true);
  assert.equal(isSolanaBreakoutEligible({ ageMs: 70_000, market: { ...market, priceChange5mPct: 25 } }), false);
  assert.equal(isSolanaBreakoutEligible({ ageMs: 70_000, market: { ...market, sells5m: 1 } }), false);
});


test('holder provider retry backoff grows and caps safely', () => {
  assert.equal(solanaProfileRetryDelayMs(1), 5_000);
  assert.equal(solanaProfileRetryDelayMs(2), 10_000);
  assert.equal(solanaProfileRetryDelayMs(3), 20_000);
  assert.equal(solanaProfileRetryDelayMs(8), 60_000);
});
