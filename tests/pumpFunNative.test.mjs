import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizePumpCoinMarket, summarizePumpTradeFlow } from '../src/feeds/pumpFunNative.mjs';

test('Pump.fun native coin data normalizes price and market cap without DexScreener', () => {
  const market = normalizePumpCoinMarket({
    mint: '8WXf2w4CLLKAFz78UUrQvVrvGjbkKc5zzzVe2bRfpump',
    name: 'Zturtle',
    symbol: 'ZTURTLE',
    creator: '11111111111111111111111111111111',
    created_timestamp: 1_700_000_000,
    last_trade_timestamp: 1_700_000_120,
    complete: false,
    bonding_curve: '22222222222222222222222222222222',
    associated_bonding_curve: '33333333333333333333333333333333',
    usd_market_cap: 50_000,
    total_supply: '1000000000000000',
    virtual_sol_reserves: '30000000000',
    virtual_token_reserves: '1073000000000000',
    reply_count: 12
  }, 150);

  assert.ok(market);
  assert.equal(market.source, 'pump-native');
  assert.equal(market.hasFlow, false);
  assert.equal(market.marketCapUsd, 50_000);
  assert.equal(market.priceUsd, 0.00005);
  assert.equal(market.symbol, 'ZTURTLE');
  assert.equal(market.complete, false);
  assert.equal(market.replyCount, 12);
  assert.equal(market.pairCreatedAt, 1_700_000_000_000);
  assert.equal(market.lastTradeAt, 1_700_000_120_000);
});

test('Pump.fun native price falls back to reserve ratio when USD market cap is unavailable', () => {
  const market = normalizePumpCoinMarket({
    mint: '8WXf2w4CLLKAFz78UUrQvVrvGjbkKc5zzzVe2bRfpump',
    symbol: 'ZT',
    virtual_sol_reserves: '30000000000',
    virtual_token_reserves: '1000000000000000',
    total_supply: '1000000000000000'
  }, 100);

  assert.ok(market);
  assert.equal(market.marketCapUsd, 0);
  assert.ok(Math.abs(market.priceUsd - 0.000003) < 1e-12);
});

test('Pump.fun native normalizer rejects invalid mint payloads', () => {
  assert.equal(normalizePumpCoinMarket({ mint: 'not-a-solana-address', usd_market_cap: 1000 }, 100), null);
  assert.equal(normalizePumpCoinMarket(null, 100), null);
});


test('Pump.fun trade rows produce verified 5m flow and price change', () => {
  const now = 1_800_000_000_000;
  const flow = summarizePumpTradeFlow([
    {
      timestamp: (now - 240_000) / 1000,
      is_buy: true,
      sol_amount: 1_000_000_000,
      token_amount: 100_000_000
    },
    {
      timestamp: (now - 120_000) / 1000,
      isBuy: false,
      solAmount: 500_000_000,
      tokenAmount: 50_000_000
    },
    {
      timestamp: (now - 30_000) / 1000,
      is_buy: true,
      sol_amount: 1_200_000_000,
      token_amount: 100_000_000
    }
  ], { nowMs: now, solPriceUsd: 100 });

  assert.equal(flow.hasFlow, true);
  assert.equal(flow.buys5m, 2);
  assert.equal(flow.sells5m, 1);
  assert.equal(flow.tradeCount5m, 3);
  assert.ok(Math.abs(flow.volume5mUsd - 270) < 1e-9);
  assert.ok(Math.abs(flow.priceChange5mPct - 20) < 1e-9);
});

test('Pump.fun flow ignores stale and unclassified trades', () => {
  const now = 1_800_000_000_000;
  const flow = summarizePumpTradeFlow([
    { timestamp: (now - 10 * 60_000) / 1000, is_buy: true, sol_amount: 1_000_000_000, token_amount: 100_000_000 },
    { timestamp: (now - 10_000) / 1000, sol_amount: 1_000_000_000, token_amount: 100_000_000 }
  ], { nowMs: now, solPriceUsd: 100 });

  assert.equal(flow.hasFlow, false);
  assert.equal(flow.tradeCount5m, 0);
  assert.equal(flow.volume5mUsd, 0);
});
