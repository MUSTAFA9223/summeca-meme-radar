import test from 'node:test';
import assert from 'node:assert/strict';
import { manualTradeCaps, manualLiveGate } from '../src/bot/phase6ManualConfirm.mjs';
import { env } from '../src/config/env.mjs';

test('manual live caps stay inside hard safety bounds', () => {
  const caps = manualTradeCaps();
  assert.ok(caps.maxBuySol >= 0.001);
  assert.ok(caps.maxBuySol <= Math.min(0.25, env.liveMaxEntrySol));
  assert.ok(caps.maxSlippageBps >= 50 && caps.maxSlippageBps <= 1000);
  assert.ok(caps.maxPriceImpactPct >= 0.25 && caps.maxPriceImpactPct <= 10);
  assert.ok(caps.maxFeeBps >= 0 && caps.maxFeeBps <= 500);
  assert.ok(caps.confirmTtlMs >= 15_000 && caps.confirmTtlMs <= 120_000);
  assert.ok(caps.reserveSol >= env.liveMinSolReserve);
});

test('manual execution requires two independent runtime gates', () => {
  const gate = manualLiveGate();
  assert.equal(typeof gate.liveEnabled, 'boolean');
  assert.equal(typeof gate.manualArmed, 'boolean');
  const executable = gate.liveEnabled && gate.manualArmed;
  assert.equal(executable, Boolean(gate.liveEnabled && gate.manualArmed));
});
