import assert from 'node:assert/strict';
import test from 'node:test';
import { extractPumpCreateMint, PUMP_FUN_PROGRAM_ID, resolvePumpCreateMint } from '../src/feeds/heliusDirectCreate.mjs';

const mint = '9xQeWvG816bUx9EPjHmaT23yvVMbRR4vsePhdBrPpump';

const createTx = () => ({
  transaction: {
    message: {
      accountKeys: [],
      instructions: [
        {
          programId: PUMP_FUN_PROGRAM_ID,
          accounts: [mint, '11111111111111111111111111111111']
        }
      ]
    }
  },
  meta: {}
});

test('extractPumpCreateMint gets first create account from parsed Pump instruction', () => {
  assert.equal(extractPumpCreateMint(createTx()), mint);
});

test('extractPumpCreateMint supports compiled account indexes', () => {
  const tx = {
    transaction: {
      message: {
        accountKeys: [
          { pubkey: mint },
          { pubkey: PUMP_FUN_PROGRAM_ID },
          { pubkey: '11111111111111111111111111111111' }
        ],
        instructions: [
          { programIdIndex: 1, accounts: [0, 2] }
        ]
      }
    },
    meta: {}
  };
  assert.equal(extractPumpCreateMint(tx), mint);
});

test('resolvePumpCreateMint accepts version-1 Solana transactions', async () => {
  const originalFetch = globalThis.fetch;
  let rpcBody = null;
  globalThis.fetch = async (_url, init) => {
    rpcBody = JSON.parse(String(init?.body ?? '{}'));
    return new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, result: createTx() }), {
      status: 200,
      headers: { 'content-type': 'application/json' }
    });
  };
  try {
    const resolved = await resolvePumpCreateMint('test-key', 'test-signature', { retries: 1 });
    assert.equal(resolved, mint);
    assert.equal(rpcBody?.method, 'getTransaction');
    assert.equal(rpcBody?.params?.[1]?.maxSupportedTransactionVersion, 1);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
