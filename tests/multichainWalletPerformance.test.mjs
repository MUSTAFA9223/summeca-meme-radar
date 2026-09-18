import test from 'node:test';
import assert from 'node:assert/strict';

import { evmConfigs } from '../src/signals/multiChainWorker.mjs';
import { summarizeWalletPerformance } from '../src/signals/walletPerformanceWorker.mjs';

test('EVM smart-wallet radar includes BNB, Robinhood, and Arc', () => {
  const keys = evmConfigs.map((row) => row.key).sort();
  assert.deepEqual(keys, ['arc', 'bnb', 'robinhood']);
  const arc = evmConfigs.find((row) => row.key === 'arc');
  assert.equal(arc.walletEnv, 'ARC_WALLETS');
  assert.equal(arc.dexChain, 'arc');
});

test('wallet performance is isolated by network and preserves Solana address casing', () => {
  const evm = '0x1111111111111111111111111111111111111111';
  const sol = 'AbCdEfGhijkLmNoPqRsTuVwXyZ123456789ABCDEFGH';
  const tokenById = new Map([
    ['b', { chain: 'bsc', initial_price_usd: 1, highest_price_usd: 2 }],
    ['a', { chain: 'arc', initial_price_usd: 1, highest_price_usd: 1.5 }],
    ['s', { chain: 'solana', initial_price_usd: 1, highest_price_usd: 3 }]
  ]);
  const signals = [
    { token_id: 'b', entry_score: 80, risk_score: 20, reason: { wallets: [{ address: evm, label: 'same' }] } },
    { token_id: 'a', entry_score: 75, risk_score: 25, reason: { wallets: [{ address: evm.toUpperCase(), label: 'same' }] } },
    { token_id: 's', entry_score: 90, risk_score: 10, reason: { wallets: [{ address: sol, label: 'sol-wallet' }] } }
  ];

  const rows = summarizeWalletPerformance(signals, tokenById);
  assert.equal(rows.length, 3);

  const bsc = rows.find((row) => row.network === 'bsc');
  const arc = rows.find((row) => row.network === 'arc');
  const solana = rows.find((row) => row.network === 'solana');

  assert.equal(bsc.address, evm);
  assert.equal(arc.address, evm);
  assert.equal(bsc.samples, 1);
  assert.equal(arc.samples, 1);
  assert.equal(solana.address, sol);
  assert.equal(solana.samples, 1);
  assert.ok(solana.avgPeakRoi > bsc.avgPeakRoi);
});
