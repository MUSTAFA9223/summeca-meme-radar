import test from 'node:test';
import assert from 'node:assert/strict';
import { TrenchesWorker } from '../src/signals/trenchesWorker.mjs';

const wallet = '0x1111111111111111111111111111111111111111';
const token = '0x2222222222222222222222222222222222222222';
const other = '0x3333333333333333333333333333333333333333';

test('on-chain trenches verifies a tracked wallet when it is the transaction payer', () => {
  const worker = new TrenchesWorker();
  const evidence = worker.payerEvidence(wallet, { from: wallet, value: '0x0' }, { logs: [] }, token);
  assert.equal(evidence.verified, true);
  assert.equal(evidence.mode, 'tx-from');
});

test('on-chain trenches rejects an unrelated inbound token transfer as payer evidence', () => {
  const worker = new TrenchesWorker();
  const pad = (address) => `0x${'0'.repeat(24)}${address.slice(2)}`;
  const transferTopic = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';
  const receipt = {
    logs: [{
      address: token,
      topics: [transferTopic, pad(other), pad(wallet)],
      data: '0x01'
    }]
  };
  const evidence = worker.payerEvidence(wallet, { from: other, value: '0x0' }, receipt, token);
  assert.equal(evidence.verified, false);
  assert.equal(evidence.mode, 'none');
});

test('on-chain wallet clusters retain distinct confirming wallets in the active window', () => {
  const worker = new TrenchesWorker();
  worker.clusterMs = 120_000;
  const first = worker.addEvent(token, { wallet, observedAt: Date.now(), label: 'one' });
  assert.equal(first.length, 1);
  const second = worker.addEvent(token, { wallet: other, observedAt: Date.now(), label: 'two' });
  assert.equal(second.length, 2);
  assert.deepEqual(new Set(second.map((row) => row.wallet)), new Set([wallet, other]));
});
