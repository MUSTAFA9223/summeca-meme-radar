import test from 'node:test';
import assert from 'node:assert/strict';
import { ignoredLaunchPattern } from '../src/core/launchPattern.mjs';
import { evaluateSignalSafety } from '../src/core/safetyGate.mjs';

const base = {
  source: 'pump_fun_direct',
  listedAt: Date.now() - 2 * 60 * 1000,
  priceUsd: 0.00005,
  liquidityUsd: 30_000,
  marketCapUsd: 180_000,
  volume5mUsd: 8_000,
  buys30s: 12,
  sells30s: 3,
  priceChange5mPct: 120,
  priceChange1hPct: 120,
  marketDataVerified: true,
  securityVerified: true,
  honeypot: false,
  mintAuthorityDisabled: true,
  freezeAuthorityDisabled: true,
  top10HolderPct: 20,
  creatorPct: 2
};

const scores = { risk: 20, blockers: [] };

test('seven-figure market cap is hidden even after the fresh window', () => {
  const snapshot = {
    ...base,
    listedAt: Date.now() - 4 * 60 * 60 * 1000,
    marketCapUsd: 1_350_000,
    priceChange5mPct: 1.1,
    priceChange1hPct: 2.1
  };
  const pattern = ignoredLaunchPattern(snapshot);
  assert.equal(pattern.ignored, true);
  assert.match(pattern.reasons.join(' '), /oversized market cap/i);
  const safety = evaluateSignalSafety(snapshot, scores);
  assert.equal(safety.status, 'ignored');
  assert.equal(safety.trackingAllowed, false);
  assert.equal(safety.entryAllowed, false);
});

test('four-digit run-up is hidden even after fifteen minutes', () => {
  const snapshot = {
    ...base,
    listedAt: Date.now() - 25 * 60 * 1000,
    marketCapUsd: 42_000,
    priceChange5mPct: 1369,
    priceChange1hPct: 1369
  };
  const pattern = ignoredLaunchPattern(snapshot);
  assert.equal(pattern.ignored, true);
  assert.match(pattern.reasons.join(' '), /extreme run-up/i);
});

test('fresh launch above five hundred percent is hidden before alerting', () => {
  const snapshot = {
    ...base,
    listedAt: Date.now() - 6 * 60 * 1000,
    marketCapUsd: 300_000,
    priceChange5mPct: 650,
    priceChange1hPct: 650
  };
  const safety = evaluateSignalSafety(snapshot, scores);
  assert.equal(safety.status, 'ignored');
  assert.equal(safety.trackingAllowed, false);
  assert.match(safety.ignoredReasons.join(' '), /already-exploded fresh run-up/i);
});

test('normal early launch remains eligible for safety evaluation', () => {
  const pattern = ignoredLaunchPattern(base);
  assert.equal(pattern.ignored, false);
  const safety = evaluateSignalSafety(base, scores);
  assert.equal(safety.status, 'safe');
  assert.equal(safety.trackingAllowed, true);
});
