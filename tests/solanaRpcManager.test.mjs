import test from 'node:test';
import assert from 'node:assert/strict';
import {
  SharedSolanaRpcManager,
  solanaPublicRpcEndpoints,
  solanaRpcCooldownMs
} from '../src/infra/solanaRpcManager.mjs';

test('shared Solana RPC cooldown policy respects retry-after and auth cooldowns', () => {
  assert.equal(solanaRpcCooldownMs(429, { base429Ms: 30_000 }), 30_000);
  assert.equal(solanaRpcCooldownMs(429, { base429Ms: 30_000, attempt: 2 }), 90_000);
  assert.equal(solanaRpcCooldownMs(429, { retryAfterSec: 90, base429Ms: 30_000 }), 90_000);
  assert.equal(solanaRpcCooldownMs(403), 300_000);
  assert.equal(solanaRpcCooldownMs(500), 0);
});

test('public Solana RPC endpoint list deduplicates a custom URL that matches a default', () => {
  const rows = solanaPublicRpcEndpoints('https://solana-rpc.publicnode.com');
  const urls = rows.map((row) => row.url);
  assert.equal(new Set(urls).size, urls.length);
  assert.equal(urls.filter((url) => url === 'https://solana-rpc.publicnode.com').length, 1);
});

test('shared endpoint lane serializes callers and enforces the minimum interval', async () => {
  let now = 1_000;
  const seen = [];
  const manager = new SharedSolanaRpcManager({
    nowFn: () => now,
    sleepImpl: async (ms) => { now += ms; },
    fetchImpl: async () => {
      seen.push(now);
      return new Response(JSON.stringify({ jsonrpc: '2.0', result: 'ok' }), {
        status: 200,
        headers: { 'content-type': 'application/json' }
      });
    }
  });

  const call = () => manager.callEndpoint({
    key: 'test-lane',
    url: 'https://rpc.example.invalid',
    provider: 'Test RPC',
    method: 'getSlot',
    params: [],
    timeoutMs: 2_000,
    minIntervalMs: 100
  });

  const values = await Promise.all([call(), call()]);
  assert.deepEqual(values, ['ok', 'ok']);
  assert.deepEqual(seen, [1_000, 1_100]);
});

test('429 cooldown is shared by later callers on the same endpoint lane', async () => {
  let now = 5_000;
  let fetches = 0;
  const manager = new SharedSolanaRpcManager({
    nowFn: () => now,
    sleepImpl: async (ms) => { now += ms; },
    fetchImpl: async () => {
      fetches += 1;
      return new Response(JSON.stringify({ error: 'rate limited' }), {
        status: 429,
        headers: { 'retry-after': '2' }
      });
    }
  });

  const options = {
    key: 'shared-429',
    url: 'https://rpc.example.invalid',
    provider: 'Test RPC',
    method: 'getTokenLargestAccounts',
    params: [],
    timeoutMs: 2_000,
    minIntervalMs: 0,
    cooldown429Ms: 30_000
  };

  await assert.rejects(manager.callEndpoint(options), /HTTP 429/);
  await assert.rejects(manager.callEndpoint(options), /cooling down/);
  assert.equal(fetches, 1);
});
