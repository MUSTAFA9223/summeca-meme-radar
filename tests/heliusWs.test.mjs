import test from 'node:test';
import assert from 'node:assert/strict';
import {
  BoundedTaskPool,
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

test('BoundedTaskPool runs hydration work in parallel up to configured concurrency', async () => {
  const pool = new BoundedTaskPool({ concurrency: 3, maxQueued: 12 });
  let active = 0;
  let peak = 0;
  let completed = 0;

  const jobs = Array.from({ length: 9 }, (_, index) => new Promise((resolve) => {
    pool.submit(async () => {
      active += 1;
      peak = Math.max(peak, active);
      await new Promise((done) => setTimeout(done, 15 + (index % 2) * 5));
      active -= 1;
      completed += 1;
      resolve();
    });
  }));

  await Promise.all(jobs);
  const deadline = Date.now() + 1000;
  while (pool.pending && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assert.equal(peak, 3);
  assert.equal(completed, 9);
  assert.equal(pool.pending, 0);
});

test('BoundedTaskPool drops the oldest queued launch when the backlog is saturated', async () => {
  const dropped = [];
  const pool = new BoundedTaskPool({
    concurrency: 1,
    maxQueued: 2,
    onDrop: (meta) => dropped.push(meta?.id)
  });

  let releaseFirst;
  const first = new Promise((resolve) => { releaseFirst = resolve; });
  const executed = [];

  pool.submit(async () => {
    executed.push('active');
    await first;
  }, { id: 'active' });
  pool.submit(async () => { executed.push('oldest'); }, { id: 'oldest' });
  pool.submit(async () => { executed.push('middle'); }, { id: 'middle' });
  pool.submit(async () => { executed.push('newest'); }, { id: 'newest' });

  releaseFirst();
  const deadline = Date.now() + 1000;
  while (pool.pending && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 5));
  }

  assert.deepEqual(dropped, ['oldest']);
  assert.deepEqual(executed, ['active', 'middle', 'newest']);
  assert.equal(pool.pending, 0);
});
