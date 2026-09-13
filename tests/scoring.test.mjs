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
