import test from 'node:test';
import assert from 'node:assert/strict';
import {
  PUMP_FUN_PROGRAM_ID,
  buildLogsSubscribeRequest,
  classifyProgramLogs,
  createHeliusWsUrl
} from '../src/feeds/heliusWs.mjs';

test('buildLogsSubscribeRequest targets the requested program', () => {
  const request = buildLogsSubscribeRequest(PUMP_FUN_PROGRAM_ID, 7, 'processed');
  assert.equal(request.method, 'logsSubscribe');
  assert.equal(request.id, 7);
  assert.deepEqual(request.params[0], { mentions: [PUMP_FUN_PROGRAM_ID] });
  assert.equal(request.params[1].commitment, 'processed');
});

test('classifyProgramLogs identifies common pump instructions', () => {
  assert.equal(classifyProgramLogs(['Program log: Instruction: Create']), 'create');
  assert.equal(classifyProgramLogs(['Program log: Instruction: Buy']), 'buy');
  assert.equal(classifyProgramLogs(['Program log: Instruction: Sell']), 'sell');
  assert.equal(classifyProgramLogs(['Program log: Instruction: Migrate']), 'migrate');
  assert.equal(classifyProgramLogs(['Program log: something else']), 'activity');
});

test('createHeliusWsUrl encodes api key', () => {
  assert.equal(
    createHeliusWsUrl('abc+123'),
    'wss://mainnet.helius-rpc.com/?api-key=abc%2B123'
  );
});
