import test from 'node:test';
import assert from 'node:assert/strict';
import { SignalTracker } from '../src/signals/signalTracker.mjs';

test('starts reference on first valid price then emits milestone updates once', () => {
  const tracker = new SignalTracker({ ttlMs: 60 * 60 * 1000 });
  tracker.start({
    tokenId: 'token-1',
    chatId: '123',
    rootMessageId: 77,
    snapshot: { address: 'A', symbol: 'AAA', name: 'AAA', priceUsd: 0 },
    startedAt: Date.now()
  });

  const reference = tracker.observe({ address: 'A', priceUsd: 1, observedAt: Date.now() });
  assert.equal(reference.type, 'reference');
  assert.equal(reference.thread.referencePriceUsd, 1);

  const first = tracker.observe({ address: 'A', priceUsd: 2.05, observedAt: Date.now() });
  assert.equal(first.type, 'milestone');
  assert.equal(first.milestonePct, 100);
  assert.ok(first.returnPct > 104 && first.returnPct < 106);

  const duplicate = tracker.observe({ address: 'A', priceUsd: 2.1, observedAt: Date.now() });
  assert.equal(duplicate, null);

  // Keep this test outside the launch filter by using an older listing context.
  const moon = tracker.observe({ address: 'A', priceUsd: 11.05, observedAt: Date.now(), listedAt: Date.now() - 20 * 60 * 1000 });
  assert.equal(moon.type, 'milestone');
  assert.equal(moon.milestonePct, 1000);
  assert.ok(moon.returnPct > 1004 && moon.returnPct < 1006);
});

test('silently expires a tracked WOFI-like vertical launch', () => {
  const tracker = new SignalTracker({ ttlMs: 60 * 60 * 1000 });
  tracker.start({
    tokenId: 'wofi-token',
    chatId: '123',
    rootMessageId: 99,
    snapshot: { address: 'W', symbol: 'WOFI', priceUsd: 0.0001 },
    startedAt: Date.now() - 5 * 60 * 1000
  });
  const event = tracker.observe({
    address: 'W',
    priceUsd: 0.03,
    observedAt: Date.now(),
    listedAt: Date.now() - 5 * 60 * 1000,
    buys30s: 7.2,
    sells30s: 0,
    volume5mUsd: 176963,
    priceChange5mPct: 45138
  });
  assert.equal(event.type, 'expired');
  assert.equal(event.reason, 'ignored-launch-pattern');
});

test('rotates tracked addresses for rate-limited enrichment', () => {
  const tracker = new SignalTracker();
  for (let i = 0; i < 4; i += 1) {
    tracker.start({
      tokenId: `token-${i}`,
      chatId: '123',
      rootMessageId: i + 1,
      snapshot: { address: `A${i}`, symbol: `S${i}`, priceUsd: 1 }
    });
  }
  assert.deepEqual(tracker.nextAddresses(2), ['A0', 'A1']);
  assert.deepEqual(tracker.nextAddresses(2), ['A2', 'A3']);
});
