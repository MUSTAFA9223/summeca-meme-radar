import test from 'node:test';
import assert from 'node:assert/strict';

import {
  classifySmartEntry,
  dynamicSmartWalletScore,
  mergeSmartCluster,
  smartClusterScore,
  shouldSuppressWalletToken
} from '../src/signals/smartWalletQuality.mjs';

test('entry timing distinguishes early from late/high-risk entries', () => {
  const early = classifySmartEntry({
    observedAtMs: 150_000,
    pairCreatedAt: 100_000,
    movePct: 25
  });
  assert.equal(early.timing, 'early');
  assert.equal(early.ageMs, 50_000);
  assert.equal(early.late, false);

  const late = classifySmartEntry({
    observedAtMs: 500_000,
    pairCreatedAt: 100_000,
    movePct: 240
  });
  assert.equal(late.timing, 'late');
  assert.equal(late.late, true);
  assert.equal(late.riskLabel, 'HIGH_RISK_LATE');
});

test('dynamic score can fall when recent measured performance is weak', () => {
  const score = dynamicSmartWalletScore(
    { score: 90 },
    {
      samples: 8,
      performanceScore: 35,
      samples24h: 3,
      samples7d: 8,
      hit50Rate24h: 0,
      hit50Rate7d: 12,
      lastSignalAt: '2026-09-19T15:00:00Z'
    },
    { now: Date.parse('2026-09-19T16:00:00Z') }
  );
  assert.ok(score < 70);
  assert.ok(score < 90);
});

test('cluster requires unique wallets and not repeated buys from one wallet', () => {
  const first = mergeSmartCluster(null, {
    walletAddress: 'wallet-a',
    dynamicScore: 80,
    observedAtMs: 100_000
  }, { now: 100_000, windowMs: 120_000 });
  assert.equal(first.uniqueWallets, 1);
  assert.equal(first.shouldNotify, false);

  const duplicate = mergeSmartCluster(first, {
    walletAddress: 'wallet-a',
    dynamicScore: 80,
    observedAtMs: 110_000
  }, { now: 110_000, windowMs: 120_000 });
  assert.equal(duplicate.uniqueWallets, 1);
  assert.equal(duplicate.duplicate, true);

  const second = mergeSmartCluster(duplicate, {
    walletAddress: 'wallet-b',
    dynamicScore: 86,
    observedAtMs: 115_000
  }, { now: 115_000, windowMs: 120_000 });
  assert.equal(second.uniqueWallets, 2);
  assert.equal(second.shouldNotify, true);

  const score = smartClusterScore(second.entries, {
    liquidityUsd: 20_000,
    volume5mUsd: 5_000,
    buys5m: 20,
    sells5m: 6,
    priceChange5mPct: 35
  });
  assert.ok(score >= 70);
});

test('wallet-token dedupe suppresses repeats only inside TTL', () => {
  assert.equal(shouldSuppressWalletToken(100_000, { now: 150_000, ttlMs: 60_000 }), true);
  assert.equal(shouldSuppressWalletToken(100_000, { now: 170_001, ttlMs: 60_000 }), false);
});


test('cluster rejects two wallets observed through the same transaction as coordinated evidence', () => {
  const first = mergeSmartCluster(null, {
    walletAddress: 'wallet-a',
    dynamicScore: 88,
    txHash: 'same-tx',
    observedAtMs: 100_000
  }, { now: 100_000, windowMs: 120_000 });

  const coordinated = mergeSmartCluster(first, {
    walletAddress: 'wallet-b',
    dynamicScore: 91,
    txHash: 'same-tx',
    observedAtMs: 102_000
  }, { now: 102_000, windowMs: 120_000 });

  assert.equal(coordinated.uniqueWallets, 1);
  assert.equal(coordinated.coordinated, true);
  assert.equal(coordinated.shouldNotify, false);

  const independent = mergeSmartCluster(coordinated, {
    walletAddress: 'wallet-c',
    dynamicScore: 86,
    txHash: 'other-tx',
    observedAtMs: 105_000
  }, { now: 105_000, windowMs: 120_000 });

  assert.equal(independent.uniqueWallets, 2);
  assert.equal(independent.coordinated, false);
  assert.equal(independent.shouldNotify, true);
});
