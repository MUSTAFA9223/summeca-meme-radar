import assert from 'node:assert/strict';
import test from 'node:test';
import { env } from '../src/config/env.mjs';
import { SmartMoneyWorker } from '../src/signals/smartMoneyWorker.mjs';

const VALID_MINT = 'So11111111111111111111111111111111111111112';

test('smart-money candidate gate accepts qualified Solana flow', () => {
  const worker = new SmartMoneyWorker();
  const candidate = {
    mint: VALID_MINT,
    netFlowUsd: Math.max(env.smartMoneyMinNetFlowUsd, 10_000),
    smartTraders: Math.max(env.smartMoneyMinTraders, 4),
    buyUsd: 20_000,
    sellUsd: 5_000,
    marketCapUsd: env.smartMoneyMaxMarketCapUsd > 0
      ? Math.min(env.smartMoneyMaxMarketCapUsd, 500_000)
      : 500_000
  };
  assert.equal(worker.candidateEligible(candidate), true);
});

test('smart-money candidate gate rejects weak flow and weak wallet consensus', () => {
  const worker = new SmartMoneyWorker();
  assert.equal(worker.candidateEligible({
    mint: VALID_MINT,
    netFlowUsd: Math.max(0, env.smartMoneyMinNetFlowUsd - 1),
    smartTraders: Math.max(0, env.smartMoneyMinTraders - 1),
    buyUsd: 100,
    sellUsd: 100,
    marketCapUsd: 100_000
  }), false);
});

test('smart-money candidate gate rejects malformed addresses', () => {
  const worker = new SmartMoneyWorker();
  assert.equal(worker.candidateEligible({
    mint: 'not-a-solana-mint',
    netFlowUsd: env.smartMoneyMinNetFlowUsd + 10_000,
    smartTraders: env.smartMoneyMinTraders + 5,
    buyUsd: 20_000,
    sellUsd: 1_000,
    marketCapUsd: 100_000
  }), false);
});
