import test from 'node:test';
import assert from 'node:assert/strict';

import {
  DEFAULT_STOP_LADDER_CONFIG,
  formatStopLadder,
  normalizeStopLadderConfig,
  parseStopLadderInput,
  stopFloorForHighWater
} from '../src/trading/stopLadder.mjs';

test('manual ladder parses the requested +100→+50 and +300→+200 pattern', () => {
  const config = parseStopLadderInput('SL=15;100:50,300:200,500:350');
  assert.equal(config.initialStopLossPct, 15);
  assert.deepEqual(config.levels, [
    { triggerPct: 100, stopPct: 50 },
    { triggerPct: 300, stopPct: 200 },
    { triggerPct: 500, stopPct: 350 }
  ]);
  assert.deepEqual(stopFloorForHighWater(99, config), { floorPct: null, triggerPct: null });
  assert.deepEqual(stopFloorForHighWater(100, config), { floorPct: 50, triggerPct: 100 });
  assert.deepEqual(stopFloorForHighWater(350, config), { floorPct: 200, triggerPct: 300 });
});

test('invalid ladder rows are removed and stop can never exceed trigger', () => {
  const config = normalizeStopLadderConfig({
    initialStopLossPct: 12,
    levels: [
      { triggerPct: 100, stopPct: 50 },
      { triggerPct: 200, stopPct: 250 },
      { triggerPct: 300, stopPct: 200 }
    ]
  });
  assert.deepEqual(config.levels, [
    { triggerPct: 100, stopPct: 50 },
    { triggerPct: 300, stopPct: 200 }
  ]);
});

test('default ladder is human-readable in Arabic', () => {
  const lines = formatStopLadder(DEFAULT_STOP_LADDER_CONFIG);
  assert.ok(lines.some((line) => line.includes('+100%') && line.includes('+50%')));
  assert.ok(lines.some((line) => line.includes('+300%') && line.includes('+200%')));
});
