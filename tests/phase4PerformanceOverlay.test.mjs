import test from 'node:test';
import assert from 'node:assert/strict';
import { performanceView } from '../src/bot/phase4PerformanceOverlay.mjs';

test('performance view shows wallet address and latest entered token', () => {
  const view = performanceView({
    updatedAt: '2026-09-19T15:20:00Z',
    wallets: [{
      label: 'smart-alpha',
      address: 'wallet-alpha',
      performanceScore: 88,
      samples: 4,
      avgPeakRoi: 120,
      hit25Rate: 100,
      hit50Rate: 75,
      hit100Rate: 25,
      paidUsd: 0,
      avgEntryScore: 82,
      avgRisk: 24,
      lastTokenSymbol: 'TEST',
      lastTokenAddress: 'token-latest',
      lastDetectedPriceUsd: 0.000123,
      lastSignalAt: '2026-09-19T15:19:00Z'
    }]
  });

  assert.ok(view);
  assert.match(view.text, /المحفظة: wallet-alpha/);
  assert.match(view.text, /آخر دخول: \$TEST/);
  assert.match(view.text, /العقد: token-latest/);
  assert.match(view.text, /سعر الرصد:/);
});
