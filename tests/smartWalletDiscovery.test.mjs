import test from 'node:test';
import assert from 'node:assert/strict';

import {
  applyWinnerEvidence,
  extractEvmWinnerBuyers,
  extractSolanaWinnerBuyers,
  extractSolanaRpcWinnerBuyers,
  extractSolanaWalletBuy,
  scoreAutoSmartWallet,
  smartWalletSignalStats,
  solanaMonitorBatchSize
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


test('Solana RPC fallback proves a buyer from positive token delta plus native spend', () => {
  const mint = '9xQeWvG816bUx9EPfEZ5QxvT1c2fv7FzYfg41ZfYgS3';
  const buyer = 'J2Gys26qFcmetpneVYTcpeRMwLMNE2RRdtJCSkwxVKjG';
  const tx = {
    _signature: 'rpc-sig',
    blockTime: 10,
    transaction: {
      message: {
        accountKeys: [{ pubkey: buyer }]
      }
    },
    meta: {
      fee: 5000,
      preBalances: [10_000_000],
      postBalances: [8_000_000],
      preTokenBalances: [],
      postTokenBalances: [{
        mint,
        owner: buyer,
        uiTokenAmount: { amount: '1000000' }
      }],
      logMessages: []
    }
  };
  const buyers = extractSolanaRpcWinnerBuyers([tx], mint);
  assert.equal(buyers.length, 1);
  assert.equal(buyers[0].address, buyer);
  assert.equal(buyers[0].txHash, 'rpc-sig');
});

test('Solana RPC fallback ignores free token receipts without trade or native spend', () => {
  const mint = '9xQeWvG816bUx9EPfEZ5QxvT1c2fv7FzYfg41ZfYgS3';
  const buyer = 'J2Gys26qFcmetpneVYTcpeRMwLMNE2RRdtJCSkwxVKjG';
  const tx = {
    transaction: { message: { accountKeys: [{ pubkey: buyer }] } },
    meta: {
      fee: 5000,
      preBalances: [10_000_000],
      postBalances: [9_995_000],
      preTokenBalances: [],
      postTokenBalances: [{ mint, owner: buyer, uiTokenAmount: { amount: '1000000' } }],
      logMessages: []
    }
  };
  assert.equal(extractSolanaRpcWinnerBuyers([tx], mint).length, 0);
});


test('Solana smart-wallet monitoring batches enough wallets for a bounded sweep', () => {
  assert.equal(solanaMonitorBatchSize(50, {
    intervalMs: 8_000,
    targetSweepMs: 90_000,
    maxBatch: 6
  }), 5);
  assert.equal(solanaMonitorBatchSize(3, {
    intervalMs: 8_000,
    targetSweepMs: 90_000,
    maxBatch: 6
  }), 1);
  assert.equal(solanaMonitorBatchSize(0), 0);
});

test('Solana smart-wallet monitoring never exceeds the configured batch cap', () => {
  assert.equal(solanaMonitorBatchSize(500, {
    intervalMs: 5_000,
    targetSweepMs: 30_000,
    maxBatch: 7
  }), 7);
});


test('Solana monitored wallet buy exposes token, amount, SOL spend, and block time', () => {
  const wallet = 'J2Gys26qFcmetpneVYTcpeRMwLMNE2RRdtJCSkwxVKjG';
  const mint = '9xQeWvG816bUx9EPfEZ5QxvT1c2fv7FzYfg41ZfYgS3';
  const tx = {
    blockTime: 1_700_000_000,
    transaction: { message: { accountKeys: [{ pubkey: wallet }] } },
    meta: {
      fee: 5_000,
      preBalances: [2_000_000_000],
      postBalances: [1_799_995_000],
      preTokenBalances: [],
      postTokenBalances: [{
        mint,
        owner: wallet,
        uiTokenAmount: { amount: '2500000', decimals: 6, uiAmountString: '2.5' }
      }],
      logMessages: ['Program log: Instruction: Buy']
    }
  };

  const buy = extractSolanaWalletBuy(tx, wallet);
  assert.equal(buy.mint, mint);
  assert.equal(buy.tokenAmount, 2.5);
  assert.equal(Number(buy.solSpent.toFixed(6)), 0.2);
  assert.equal(buy.blockTime, 1_700_000_000);
  assert.equal(buy.blockTimeMs, 1_700_000_000_000);
});

test('Solana monitored wallet parser rejects a free token receipt with no trade spend', () => {
  const wallet = 'J2Gys26qFcmetpneVYTcpeRMwLMNE2RRdtJCSkwxVKjG';
  const mint = '9xQeWvG816bUx9EPfEZ5QxvT1c2fv7FzYfg41ZfYgS3';
  const tx = {
    transaction: { message: { accountKeys: [{ pubkey: wallet }] } },
    meta: {
      fee: 5_000,
      preBalances: [2_000_000_000],
      postBalances: [1_999_995_000],
      preTokenBalances: [],
      postTokenBalances: [{
        mint,
        owner: wallet,
        uiTokenAmount: { amount: '1000000', decimals: 6, uiAmountString: '1' }
      }],
      logMessages: ['Program log: Instruction: Transfer']
    }
  };
  assert.equal(extractSolanaWalletBuy(tx, wallet), null);
});

test('smart-wallet signal stats expose historical hit rates', () => {
  const stats = smartWalletSignalStats({
    score: 82,
    samples: 4,
    avgPeakRoi: 137.5,
    hit50: 3,
    hit100: 1
  });
  assert.equal(stats.score, 82);
  assert.equal(stats.samples, 4);
  assert.equal(stats.hit50Rate, 75);
  assert.equal(stats.hit100Rate, 25);
});
