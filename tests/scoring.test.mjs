import test from 'node:test';
import assert from 'node:assert/strict';
import { scoreToken } from '../src/core/scoring.mjs';
import { demoSnapshots } from '../src/feeds/demo.mjs';

test('strong clean token passes entry threshold', () => {
  const score = scoreToken(demoSnapshots()[0]);
  assert.ok(score.entry >= 82, `entry=${score.entry}`);
  assert.ok(score.risk < 50, `risk=${score.risk}`);
  assert.equal(score.blockers.length, 0);
});

test('honeypot is blocked', () => {
  const score = scoreToken({ ...demoSnapshots()[0], honeypot: true });
  assert.ok(score.blockers.includes('honeypot flag'));
  assert.ok(score.risk >= 90, `risk=${score.risk}`);
});

test('live high-confidence winner profile remains eligible for approved signals', () => {
  const base = demoSnapshots()[0];
  const score = scoreToken({
    ...base,
    marketDataVerified: true,
    securityVerified: true,
    uniqueBuyersVerified: true,
    volume5mUsd: 48_000,
    priceChange5mPct: 12,
    creatorPct: 1.4
  });

  assert.equal(score.qualityGatePassed, true, score.qualityGateReasons.join(', '));
  assert.ok(score.entry >= 82, `entry=${score.entry}`);
});

test('live hype without verified sells/security is capped below approved-signal threshold', () => {
  const now = Date.now();
  const score = scoreToken({
    address: '11111111111111111111111111111111',
    symbol: 'HYPE',
    observedAt: now,
    listedAt: now - 20_000,
    priceUsd: 0.00001,
    liquidityUsd: 40_000,
    marketDataVerified: true,
    securityVerified: false,
    mintAuthorityDisabled: true,
    freezeAuthorityDisabled: true,
    buys30s: 28,
    sells30s: 0,
    buyVolume30sUsd: 8_000,
    sellVolume30sUsd: 0,
    volume5mUsd: 35_000,
    priceChange5mPct: 45,
    buyerAcceleration: 3,
    volumeAcceleration: 3
  });

  assert.equal(score.qualityGatePassed, false);
  assert.ok(score.entry < 82, `entry=${score.entry}`);
  assert.ok(score.qualityGateReasons.some((reason) => /security|sells/.test(reason)));
});

test('already overextended live move is not emitted as a fresh approved entry', () => {
  const base = demoSnapshots()[0];
  const score = scoreToken({
    ...base,
    marketDataVerified: true,
    securityVerified: true,
    uniqueBuyersVerified: true,
    volume5mUsd: 80_000,
    priceChange5mPct: 135,
    creatorPct: 1.4
  });

  assert.equal(score.qualityGatePassed, false);
  assert.ok(score.entry < 82, `entry=${score.entry}`);
  assert.ok(score.qualityGateReasons.includes('move already overextended'));
});
