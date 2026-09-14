import test from 'node:test';
import assert from 'node:assert/strict';
import { entryQuality, isRisingMomentum, momentumScore, persistedSafety } from '../src/core/momentumProfile.mjs';

const safeBase = {
  address: '7YttLkHDoQnJ1Nnq7Zf8fTtq2NM2yMZyyZnCZ3HECHg1',
  symbol: 'SAFE',
  listedAt: Date.now() - 90_000,
  priceUsd: 0.00012,
  liquidityUsd: 18_000,
  marketCapUsd: 90_000,
  buys30s: 12,
  sells30s: 4,
  buyVolume30sUsd: 1_500,
  sellVolume30sUsd: 400,
  uniqueBuyers30s: 10,
  buyerAcceleration: 1.8,
  volumeAcceleration: 1.7,
  volume5mUsd: 22_000,
  priceChange5mPct: 18,
  entryScore: 90,
  moonScore: 88,
  riskScore: 18,
  honeypot: false,
  mintAuthorityDisabled: true,
  freezeAuthorityDisabled: true,
  marketDataVerified: true,
  securityVerified: true,
  top10HolderPct: 24,
  creatorPct: 3
};

test('safe strong momentum passes the persisted safety gate', () => {
  const safety = persistedSafety(safeBase);
  assert.equal(safety.ok, true);
  assert.equal(safety.status, 'safe');
  assert.equal(isRisingMomentum(safeBase), true);
  assert.ok(momentumScore(safeBase) >= 65);
  assert.notEqual(entryQuality(safeBase).key, 'blocked');
});

test('missing verified security is pending and remains trackable', () => {
  const snapshot = { ...safeBase, securityVerified: false, honeypot: undefined, mintAuthorityDisabled: undefined, freezeAuthorityDisabled: undefined };
  const safety = persistedSafety(snapshot);
  assert.equal(safety.ok, false);
  assert.equal(safety.status, 'unknown');
  assert.equal(safety.trackingAllowed, true);
  assert.ok(safety.reasons.some((reason) => reason.includes('security')));
  assert.equal(entryQuality(snapshot).key, 'pending');
});

test('missing dedicated honeypot field does not block when other verified evidence is safe', () => {
  const snapshot = { ...safeBase, honeypot: undefined };
  const safety = persistedSafety(snapshot);
  assert.equal(safety.ok, true);
  assert.equal(safety.status, 'safe');
});

test('large run-up is marked as a late entry even when otherwise safe', () => {
  const snapshot = { ...safeBase, priceChange5mPct: 95 };
  assert.equal(persistedSafety(snapshot).ok, true);
  assert.equal(entryQuality(snapshot).key, 'late');
});

test('no observed sell cannot become an approved entry but stays pending for tracking', () => {
  const snapshot = { ...safeBase, sells30s: 0 };
  const safety = persistedSafety(snapshot);
  assert.equal(safety.ok, false);
  assert.equal(safety.status, 'unknown');
  assert.equal(safety.trackingAllowed, true);
  assert.equal(entryQuality(snapshot).key, 'pending');
});

test('confirmed honeypot remains blocked even with strong momentum', () => {
  const snapshot = { ...safeBase, honeypot: true, riskScore: 100 };
  const safety = persistedSafety(snapshot);
  assert.equal(safety.ok, false);
  assert.equal(safety.status, 'dangerous');
  assert.equal(safety.trackingAllowed, false);
  assert.equal(entryQuality(snapshot).key, 'blocked');
});
