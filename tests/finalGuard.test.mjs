import test from 'node:test';
import assert from 'node:assert/strict';
import { evaluateFinalSafety } from '../src/bot/phase7FinalGuard.mjs';

const limits = {
  killSwitch: false,
  maxTradesPerDay: 6,
  maxDailyBuySol: 0.10,
  minLiquidityUsd: 8_000,
  maxMove5mPct: 50,
  maxTopUserPct: 12,
  maxTop5Pct: 35,
  maxTop10Pct: 50,
  smokeOnStart: false
};

test('final guard accepts a liquid distributed token with revoked authorities and real sells', () => {
  const result = evaluateFinalSafety({
    market: { liquidityUsd: 25_000, buys5m: 18, sells5m: 6, move5mPct: 18 },
    profile: { observedAccounts: 12, topUserPct: 6, top5Pct: 22, top10Pct: 38 },
    mintAuthority: null,
    freezeAuthority: null
  }, limits);
  assert.equal(result.ok, true);
  assert.deepEqual(result.reasons, []);
});

test('final guard blocks missing sells and active authorities', () => {
  const result = evaluateFinalSafety({
    market: { liquidityUsd: 30_000, buys5m: 20, sells5m: 0, move5mPct: 10 },
    profile: { observedAccounts: 10, topUserPct: 5, top5Pct: 20, top10Pct: 30 },
    mintAuthority: 'SomeAuthority',
    freezeAuthority: null
  }, limits);
  assert.equal(result.ok, false);
  assert.ok(result.reasons.includes('no-real-sell-observed'));
  assert.ok(result.reasons.includes('mint-authority-active'));
});

test('final guard blocks concentrated or unavailable holder evidence', () => {
  const concentrated = evaluateFinalSafety({
    market: { liquidityUsd: 20_000, buys5m: 8, sells5m: 3, move5mPct: 12 },
    profile: { observedAccounts: 8, topUserPct: 18, top5Pct: 44, top10Pct: 60 },
    mintAuthority: null,
    freezeAuthority: null
  }, limits);
  assert.equal(concentrated.ok, false);
  assert.ok(concentrated.reasons.includes('top-user-concentration'));
  assert.ok(concentrated.reasons.includes('top5-concentration'));
  assert.ok(concentrated.reasons.includes('top10-concentration'));

  const unavailable = evaluateFinalSafety({
    market: { liquidityUsd: 20_000, buys5m: 8, sells5m: 3, move5mPct: 12 },
    profile: null,
    mintAuthority: null,
    freezeAuthority: null
  }, limits);
  assert.equal(unavailable.ok, false);
  assert.ok(unavailable.reasons.includes('holder-profile-unavailable'));
});
