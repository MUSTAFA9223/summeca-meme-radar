import test from 'node:test';
import assert from 'node:assert/strict';

import {
  applyWinnerEvidence,
  extractEvmWinnerBuyers,
  extractSolanaWinnerBuyers,
  scoreAutoSmartWallet
} from '../src/signals/smartWalletDiscoveryWorker.mjs';

test('auto smart wallet is never promoted from one winning token', () => {
  const one = applyWinnerEvidence(null, {
    network: 'solana',
    address: 'J2Gys26qFcmetpneVYTcpeRMwLMNE2RRdtJCSkwxVKjG',
    tokenAddress: '9xQeWvG816bUx9EPfEZ5QxvT1c2fv7FzYfg41ZfYgS3',
    peakRoiPct: 400
  });
  assert.equal(one.samples, 1);
  assert.equal(one.promoted, false);
});

test('repeated high-quality winner evidence promotes a wallet', () => {
  const address = 'J2Gys26qFcmetpneVYTcpeRMwLMNE2RRdtJCSkwxVKjG';
  const one = applyWinnerEvidence(null, {
    network: 'solana',
    address,
    tokenAddress: '9xQeWvG816bUx9EPfEZ5QxvT1c2fv7FzYfg41ZfYgS3',
    peakRoiPct: 120
  });
  const two = applyWinnerEvidence(one, {
    network: 'solana',
    address,
    tokenAddress: 'So11111111111111111111111111111111111111112',
    peakRoiPct: 90
  });
  assert.equal(two.samples, 2);
  assert.equal(two.promoted, true);
  assert.ok(two.score >= 60);
  assert.ok(two.avgPeakRoi >= 40);
});

test('duplicate evidence for the same token does not inflate samples', () => {
  const address = '0x1111111111111111111111111111111111111111';
  const first = applyWinnerEvidence(null, {
    network: 'bsc',
    address,
    tokenAddress: '0x2222222222222222222222222222222222222222',
    peakRoiPct: 100
  });
  const duplicate = applyWinnerEvidence(first, {
    network: 'bsc',
    address,
    tokenAddress: '0x2222222222222222222222222222222222222222',
    peakRoiPct: 300
  });
  assert.equal(duplicate.samples, 1);
  assert.equal(duplicate.promoted, false);
});

test('the same EVM address stays network-specific', () => {
  const address = '0x1111111111111111111111111111111111111111';
  const bsc = applyWinnerEvidence(null, {
    network: 'bsc',
    address,
    tokenAddress: '0x2222222222222222222222222222222222222222',
    peakRoiPct: 80
  });
  const arc = applyWinnerEvidence(null, {
    network: 'arc',
    address,
    tokenAddress: '0x2222222222222222222222222222222222222222',
    peakRoiPct: 80
  });
  assert.equal(bsc.network, 'bsc');
  assert.equal(arc.network, 'arc');
  assert.notEqual(`${bsc.network}:${bsc.address}`, `${arc.network}:${arc.address}`);
});

test('Solana winner parser extracts unique SWAP recipients', () => {
  const mint = '9xQeWvG816bUx9EPfEZ5QxvT1c2fv7FzYfg41ZfYgS3';
  const buyer = 'J2Gys26qFcmetpneVYTcpeRMwLMNE2RRdtJCSkwxVKjG';
  const rows = [
    {
      type: 'SWAP',
      timestamp: 2,
      signature: 'sig2',
      tokenTransfers: [{ mint, toUserAccount: buyer }]
    },
    {
      type: 'SWAP',
      timestamp: 3,
      signature: 'sig3',
      tokenTransfers: [{ mint, toUserAccount: buyer }]
    },
    {
      type: 'TRANSFER',
      timestamp: 1,
      signature: 'sig1',
      tokenTransfers: [{ mint, toUserAccount: '4Nd1mYV3Fv7dyYTJcXsM9M3oTqVhPq8PZ3r1fQK9E2La' }]
    }
  ];
  const buyers = extractSolanaWinnerBuyers(rows, mint);
  assert.equal(buyers.length, 1);
  assert.equal(buyers[0].address, buyer);
  assert.equal(buyers[0].txHash, 'sig2');
});

test('EVM winner parser ignores mint transfers, pool recipients, and duplicates', () => {
  const token = '0x2222222222222222222222222222222222222222';
  const pair = '0x3333333333333333333333333333333333333333';
  const buyer = '0x1111111111111111111111111111111111111111';
  const topic = (address) => `0x${'0'.repeat(24)}${address.slice(2)}`;
  const transfer = (from, to, hash) => ({
    address: token,
    topics: [
      '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef',
      topic(from),
      topic(to)
    ],
    transactionHash: hash,
    blockNumber: '0x10'
  });
  const rows = [
    transfer('0x0000000000000000000000000000000000000000', buyer, 'mint'),
    transfer(pair, pair, 'pool'),
    transfer(pair, buyer, 'buy1'),
    transfer(pair, buyer, 'buy2')
  ];
  const buyers = extractEvmWinnerBuyers(rows, token, pair);
  assert.equal(buyers.length, 1);
  assert.equal(buyers[0].address, buyer);
  assert.equal(buyers[0].txHash, 'buy1');
});

test('scoring requires enough evidence even when ROI is extreme', () => {
  const score = scoreAutoSmartWallet({
    evidence: [{ peakRoiPct: 1000 }]
  });
  assert.equal(score.samples, 1);
  assert.equal(score.promoted, false);
});
