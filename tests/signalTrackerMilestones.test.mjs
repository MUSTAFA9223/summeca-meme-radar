import test from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_MILESTONES, SignalTracker } from '../src/signals/signalTracker.mjs';

test('default milestones provide dense updates during the first 100% rise', () => {
  assert.deepEqual(DEFAULT_MILESTONES.slice(0, 7), [10, 20, 30, 40, 50, 75, 100]);
});

test('restored signal catches the next unsent early-rise milestone', () => {
  const tracker = new SignalTracker({ ttlMs: 60 * 60 * 1000 });
  tracker.start({
    tokenId: 'token-1',
    chatId: '123',
    rootMessageId: 99,
    snapshot: { address: 'A', symbol: 'AAA', priceUsd: 0.00004886 },
    startedAt: Date.now() - 5 * 60 * 1000,
    referencePriceUsd: 0.00004886,
    peakPriceUsd: 0.00006000,
    peakReturnPct: 22.8,
    lastMilestonePct: 25
  });

  const event = tracker.observe({
    address: 'A',
    priceUsd: 0.00006895,
    observedAt: Date.now(),
    listedAt: Date.now() - 20 * 60 * 1000
  });

  assert.equal(event.type, 'milestone');
  assert.equal(event.milestonePct, 40);
  assert.ok(event.returnPct > 41 && event.returnPct < 42);
});
