import test from 'node:test';
import assert from 'node:assert/strict';
import { isSolanaPaperProbeEligible, selectSolanaMarketCandidates } from '../src/signals/solanaUltraEarlyWorker.mjs';

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
