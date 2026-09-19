import test from 'node:test';
import assert from 'node:assert/strict';
import { summarizeWalletPerformance } from '../src/signals/walletPerformanceWorker.mjs';

test('wallet performance keeps latest token entry context per wallet', () => {
  const wallet = 'wallet-alpha';
  const tokenById = new Map([
    ['older', {
      id: 'older',
      chain: 'solana',
      address: 'token-old',
      symbol: 'OLD',
      initial_price_usd: 0.001,
      highest_price_usd: 0.002
    }],
    ['newer', {
      id: 'newer',
      chain: 'solana',
      address: 'token-new',
      symbol: 'NEW',
      initial_price_usd: 0.01,
      highest_price_usd: 0.015
    }]
  ]);

  const signals = [
    {
      created_at: '2026-09-19T15:10:00Z',
      token_id: 'newer',
      entry_score: 84,
      risk_score: 25,
      reason: {
        network: 'solana',
        detected_price_usd: 0.011,
        tx: 'sig-new',
        wallets: [{ network: 'solana', address: wallet, label: 'smart-1', paid_usd: 0 }]
      }
    },
    {
      created_at: '2026-09-19T14:00:00Z',
      token_id: 'older',
      entry_score: 75,
      risk_score: 30,
      reason: {
        network: 'solana',
        detected_price_usd: 0.0011,
        tx: 'sig-old',
        wallets: [{ network: 'solana', address: wallet, label: 'smart-1', paid_usd: 0 }]
      }
    }
  ];

  const rows = summarizeWalletPerformance(signals, tokenById);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].address, wallet);
  assert.equal(rows[0].samples, 2);
  assert.equal(rows[0].lastTokenSymbol, 'NEW');
  assert.equal(rows[0].lastTokenAddress, 'token-new');
  assert.equal(rows[0].lastDetectedPriceUsd, 0.011);
  assert.equal(rows[0].lastTxHash, 'sig-new');
  assert.equal(rows[0].lastSignalAt, '2026-09-19T15:10:00Z');
});


test('wallet performance dedupes the same wallet-token evidence and scores recent windows', () => {
  const now = Date.parse('2026-09-19T16:00:00Z');
  const tokenById = new Map([['t1', {
    id: 't1',
    chain: 'solana',
    address: 'token-one',
    symbol: 'ONE',
    initial_price_usd: 1,
    highest_price_usd: 1.8
  }]]);

  const baseReason = {
    network: 'solana',
    detected_price_usd: 1,
    wallets: [{ network: 'solana', address: 'wallet-alpha', label: 'smart-a', paid_usd: 0 }]
  };
  const rows = summarizeWalletPerformance([
    { id: 's1', created_at: '2026-09-19T15:00:00Z', token_id: 't1', entry_score: 85, risk_score: 20, reason: baseReason },
    { id: 's2', created_at: '2026-09-19T15:05:00Z', token_id: 't1', entry_score: 90, risk_score: 20, reason: { ...baseReason, smart_cluster: true } }
  ], tokenById, now);

  assert.equal(rows.length, 1);
  assert.equal(rows[0].samples, 1);
  assert.equal(rows[0].samples24h, 1);
  assert.equal(rows[0].samples7d, 1);
  assert.equal(rows[0].hit50Rate24h, 100);
  assert.ok(rows[0].recentScore24h > 0);
});
