import test from 'node:test';
import assert from 'node:assert/strict';
import { advanceSolanaEarlyConfirmation, isSolanaEarlyAlertEligible, isSolanaPaperProbeEligible, selectSolanaMarketCandidates } from '../src/signals/solanaUltraEarlyWorker.mjs';

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
    marketCapUsd: 320_000,
    buys5m: 12,
    sells5m: 4,
    volume5mUsd: 2_400,
    priceChange5mPct: 24
  };
  assert.equal(isSolanaEarlyAlertEligible({
    rejectionReason: null,
    score: 65,
    minScore: 55,
    market
  }), true);
});

test('early alert lane still rejects weak or one-way unsafe market flow', () => {
  const base = {
    marketCapUsd: 320_000,
    buys5m: 12,
    sells5m: 4,
    volume5mUsd: 2_400,
    priceChange5mPct: 24
  };
  assert.equal(isSolanaEarlyAlertEligible({ rejectionReason: 'weak-buy-sell-ratio', score: 80, market: base }), false);
  assert.equal(isSolanaEarlyAlertEligible({ rejectionReason: null, score: 80, market: { ...base, sells5m: 0 } }), false);
  assert.equal(isSolanaEarlyAlertEligible({ rejectionReason: null, score: 80, market: { ...base, volume5mUsd: 100 } }), false);
  assert.equal(isSolanaEarlyAlertEligible({ rejectionReason: null, score: 50, minScore: 55, market: base }), false);
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
