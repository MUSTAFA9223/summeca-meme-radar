import assert from 'node:assert/strict';
import test from 'node:test';
import { extractPumpCreateMint, PUMP_FUN_PROGRAM_ID } from '../src/feeds/heliusDirectCreate.mjs';

const mint = '9xQeWvG816bUx9EPjHmaT23yvVMbRR4vsePhdBrPpump';

test('extractPumpCreateMint gets first create account from parsed Pump instruction', () => {
  const tx = {
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
  };
  assert.equal(extractPumpCreateMint(tx), mint);
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
