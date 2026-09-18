import test from 'node:test';
import assert from 'node:assert/strict';
import { buildLegacySolTransferTransaction, parseSolanaCopyTrade } from '../src/bot/phase8OwnerFlows.mjs';

const WALLET = 'BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB';
const MINT = 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';

function tx({ preSol, postSol, preToken, postToken, fee = 5000 }) {
  return {
    transaction: {
      message: {
        accountKeys: [{ pubkey: WALLET, signer: true, writable: true }]
      }
    },
    meta: {
      fee,
      preBalances: [preSol],
      postBalances: [postSol],
      preTokenBalances: [{
        owner: WALLET,
        mint: MINT,
        uiTokenAmount: { amount: String(preToken), decimals: 6 }
      }],
      postTokenBalances: [{
        owner: WALLET,
        mint: MINT,
        uiTokenAmount: { amount: String(postToken), decimals: 6 }
      }]
    }
  };
}

test('copy parser detects a source-wallet SOL buy', () => {
  const trade = parseSolanaCopyTrade(tx({
    preSol: 10_000_000_000,
    postSol: 9_499_995_000,
    preToken: 0,
    postToken: 1_000_000
  }), WALLET);

  assert.equal(trade.side, 'buy');
  assert.equal(trade.mint, MINT);
  assert.equal(trade.tokenDeltaAtomic, '1000000');
  assert.equal(trade.sourceLamports, '500000000');
});

test('copy parser detects a source-wallet token sell', () => {
  const trade = parseSolanaCopyTrade(tx({
    preSol: 5_000_000_000,
    postSol: 5_399_995_000,
    preToken: 2_000_000,
    postToken: 500_000
  }), WALLET);

  assert.equal(trade.side, 'sell');
  assert.equal(trade.mint, MINT);
  assert.equal(trade.tokenDeltaAtomic, '1500000');
  assert.equal(trade.sourceLamports, '399995000');
});

test('copy parser ignores transactions without a wallet token delta', () => {
  const trade = parseSolanaCopyTrade(tx({
    preSol: 5_000_000_000,
    postSol: 4_999_995_000,
    preToken: 1_000_000,
    postToken: 1_000_000
  }), WALLET);
  assert.equal(trade, null);
});


test('wallet SOL transfer builder creates a legacy transaction with one signer', () => {
  const base64 = buildLegacySolTransferTransaction({
    from: 'So11111111111111111111111111111111111111112',
    to: 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA',
    lamports: 10_000_000n,
    recentBlockhash: '11111111111111111111111111111111'
  });
  const bytes = Buffer.from(base64, 'base64');
  assert.equal(bytes[0], 1); // one signature slot
  assert.equal(bytes.subarray(1, 65).every((value) => value === 0), true);
  assert.deepEqual([...bytes.subarray(65, 69)], [1, 0, 1, 3]); // message header + 3 accounts
  assert.ok(bytes.length > 200);
});

test('wallet SOL transfer builder rejects non-positive amounts', () => {
  assert.throws(() => buildLegacySolTransferTransaction({
    from: 'So11111111111111111111111111111111111111112',
    to: 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA',
    lamports: 0n,
    recentBlockhash: '11111111111111111111111111111111'
  }), /مبلغ الإرسال غير صالح/);
});
