import assert from 'node:assert/strict';
import test from 'node:test';
import {
  evaluateEarlyEvmCandidate,
  evaluateEvmSafety,
  evaluateRunnerWatchCandidate,
  isRisingEvmMomentum
} from '../src/signals/evmRadarWorker.mjs';

const base = () => ({
  networkType: 'evm',
  chain: 'robinhood',
  address: '0x284f3ae946ea4689f14d031d1f381d62ad846da2',
  listedAt: Date.now() - 30_000,
  observedAt: Date.now(),
  priceUsd: 0.0001,
  liquidityUsd: 12_000,
  marketCapUsd: 80_000,
  buys30s: 8,
  sells30s: 2,
  buyVolume30sUsd: 1600,
  sellVolume30sUsd: 300,
  volume5mUsd: 9_000,
  priceChange5mPct: 25,
  marketDataVerified: true,
  securityVerified: false
});

test('Robinhood momentum can alert early while strict security is still pending', () => {
  const snapshot = base();
  const scores = { entry: 70, moon: 75, risk: 20 };
  const safety = evaluateEvmSafety(snapshot, scores);
  assert.equal(safety.ok, false);
  assert.equal(isRisingEvmMomentum(snapshot), true);
  assert.equal(evaluateEarlyEvmCandidate(snapshot, scores, safety, 82).ok, true);
});

test('known EVM danger blocks the pending early alert', () => {
  const snapshot = { ...base(), honeypot: true };
  const scores = { entry: 70, moon: 75, risk: 20 };
  assert.equal(evaluateEarlyEvmCandidate(snapshot, scores, evaluateEvmSafety(snapshot, scores), 82).ok, false);
});

test('overextended Robinhood launch becomes no-chase runner watch instead of disappearing', () => {
  const snapshot = { ...base(), priceChange5mPct: 180, volume5mUsd: 25_000 };
  const scores = { entry: 50, moon: 85, risk: 20 };
  const safety = evaluateEvmSafety(snapshot, scores);
  assert.equal(evaluateEarlyEvmCandidate(snapshot, scores, safety, 82).ok, false);
  assert.equal(evaluateRunnerWatchCandidate(snapshot, scores).ok, true);
});

test('runner watch rejects known dangerous contracts', () => {
  const snapshot = { ...base(), priceChange5mPct: 180, volume5mUsd: 25_000, blacklist: true };
  const scores = { entry: 50, moon: 85, risk: 20 };
  assert.equal(evaluateRunnerWatchCandidate(snapshot, scores).ok, false);
});
