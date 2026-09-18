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


test('manual stop ladder locks +50% after +100% and +200% after +300%', () => {
  const ladderSettings = {
    ...settings,
    manualStopLadder: true,
    stopLadder: [
      { triggerPct: 100, stopPct: 50 },
      { triggerPct: 300, stopPct: 200 }
    ]
  };

  const at100 = advanceProtectionState({
    entryPriceUsd: 1,
    currentPriceUsd: 2,
    previousHighestPriceUsd: 1,
    previousHighWaterPnlPct: 0,
    previousCurrentStop: -15
  }, ladderSettings);
  assert.equal(at100.currentStop, 50);

  const at300 = advanceProtectionState({
    entryPriceUsd: 1,
    currentPriceUsd: 4,
    previousHighestPriceUsd: at100.highestPriceUsd,
    previousHighWaterPnlPct: at100.highWaterPnlPct,
    previousCurrentStop: at100.currentStop
  }, ladderSettings);
  assert.equal(at300.currentStop, 200);

  const retrace = advanceProtectionState({
    entryPriceUsd: 1,
    currentPriceUsd: 2.9,
    previousHighestPriceUsd: at300.highestPriceUsd,
    previousHighWaterPnlPct: at300.highWaterPnlPct,
    previousCurrentStop: at300.currentStop
  }, ladderSettings);
  assert.equal(retrace.currentStop, at300.currentStop);
  assert.equal(retrace.triggered, true);
});
