import test from 'node:test';
import assert from 'node:assert/strict';
import {
  advanceProtectionState,
  initialProtectionState,
  protectionSettings
} from '../src/trading/liveProtectionPolicy.mjs';

const settings = protectionSettings({
  LIVE_PROTECTION_STOP_LOSS_PCT: '10',
  LIVE_PROTECTION_TRAIL_START_PCT: '12',
  LIVE_PROTECTION_TRAIL_PCT: '8',
  LIVE_PROTECTION_TIGHT_TRAIL_START_PCT: '35',
  LIVE_PROTECTION_TIGHT_TRAIL_PCT: '5',
  LIVE_PROTECTION_PROFIT_LOCK_TRIGGER_PCT: '30',
  LIVE_PROTECTION_PROFIT_LOCK_FLOOR_PCT: '20'
});

test('live protection high-water only moves upward', () => {
  const initial = initialProtectionState(1, settings);
  const first = advanceProtectionState({
    entryPriceUsd: 1,
    currentPriceUsd: 1.30,
    previousHighestPriceUsd: initial.highestPriceUsd,
    previousHighWaterPnlPct: initial.highWaterPnlPct,
    previousCurrentStop: initial.currentStop
  }, settings);
  const second = advanceProtectionState({
    entryPriceUsd: 1,
    currentPriceUsd: 1.16,
    previousHighestPriceUsd: first.highestPriceUsd,
    previousHighWaterPnlPct: first.highWaterPnlPct,
    previousCurrentStop: first.currentStop
  }, settings);

  assert.ok(first.highWaterPnlPct > 29.9);
  assert.equal(second.highWaterPnlPct, first.highWaterPnlPct);
  assert.equal(second.highestPriceUsd, first.highestPriceUsd);
});

test('live trailing stop never decreases after price retraces', () => {
  const first = advanceProtectionState({
    entryPriceUsd: 1,
    currentPriceUsd: 1.20,
    previousHighestPriceUsd: 1,
    previousHighWaterPnlPct: 0,
    previousCurrentStop: -10
  }, settings);
  const second = advanceProtectionState({
    entryPriceUsd: 1,
    currentPriceUsd: 1.15,
    previousHighestPriceUsd: first.highestPriceUsd,
    previousHighWaterPnlPct: first.highWaterPnlPct,
    previousCurrentStop: first.currentStop
  }, settings);
  const third = advanceProtectionState({
    entryPriceUsd: 1,
    currentPriceUsd: 1.08,
    previousHighestPriceUsd: second.highestPriceUsd,
    previousHighWaterPnlPct: second.highWaterPnlPct,
    previousCurrentStop: second.currentStop
  }, settings);

  assert.ok(first.currentStop >= 12 - 1e-9);
  assert.equal(second.currentStop, first.currentStop);
  assert.equal(third.currentStop, second.currentStop);
  assert.equal(third.triggered, true);
});

test('profit lock and tighter trailing raise the floor progressively', () => {
  const locked = advanceProtectionState({
    entryPriceUsd: 1,
    currentPriceUsd: 1.36,
    previousHighestPriceUsd: 1,
    previousHighWaterPnlPct: 0,
    previousCurrentStop: -10
  }, settings);
  assert.ok(locked.currentStop >= 30 - 1e-9);

  const retrace = advanceProtectionState({
    entryPriceUsd: 1,
    currentPriceUsd: 1.29,
    previousHighestPriceUsd: locked.highestPriceUsd,
    previousHighWaterPnlPct: locked.highWaterPnlPct,
    previousCurrentStop: locked.currentStop
  }, settings);
  assert.equal(retrace.currentStop, locked.currentStop);
  assert.equal(retrace.triggered, true);
});
