import test from 'node:test';
import assert from 'node:assert/strict';
import { globalMomentumDecision, parseGlobalPools } from '../src/signals/globalNetworkRadar.mjs';

const NOW = Date.parse('2026-09-15T09:30:00Z');

function pool({ network = 'eth', address = '0xpool', tokenId = 'eth_0xabc', createdAt = '2026-09-15T09:28:00Z', price5 = '18', buys = 24, sells = 6, volume = '18000', liquidity = '24000' } = {}) {
  return {
    id: `${network}_${address}`,
    type: 'pool',
    attributes: {
      address,
      pool_created_at: createdAt,
      base_token_price_usd: '0.00042',
      quote_token_price_usd: '1',
      reserve_in_usd: liquidity,
      market_cap_usd: '420000',
      fdv_usd: '450000',
      transactions: { m5: { buys, sells, buyers: 18, sellers: 5 } },
      volume_usd: { m5: volume },
      price_change_percentage: { m5: price5, h1: '31' }
    },
    relationships: {
      network: { data: { id: network, type: 'network' } },
      dex: { data: { id: 'uniswap_v3', type: 'dex' } },
      base_token: { data: { id: tokenId, type: 'token' } },
      quote_token: { data: { id: `${network}_quote`, type: 'token' } }
    }
  };
}

function token(id, address, symbol = 'MOON') {
  return { id, type: 'token', attributes: { address, name: `${symbol} token`, symbol } };
}

test('parseGlobalPools keeps non-dedicated networks and normalizes market snapshot', () => {
  const payload = {
    data: [
      pool(),
      pool({ network: 'solana', address: 'solpool', tokenId: 'solana_mint' })
    ],
    included: [
      token('eth_0xabc', '0xabc', 'MOON'),
      token('eth_quote', '0xusdc', 'USDC'),
      token('solana_mint', 'So11111111111111111111111111111111111111112', 'MEME'),
      token('solana_quote', 'USDC111111111111111111111111111111111111111', 'USDC')
    ]
  };

  const snapshots = parseGlobalPools(payload, NOW);
  assert.equal(snapshots.length, 1);
  assert.equal(snapshots[0].chain, 'eth');
  assert.equal(snapshots[0].address, '0xabc');
  assert.equal(snapshots[0].symbol, 'MOON');
  assert.equal(snapshots[0].trades5m, 30);
  assert.equal(snapshots[0].marketDataVerified, true);
});

test('globalMomentumDecision accepts explosive early momentum and rejects weak flow', () => {
  const strong = {
    listedAt: NOW - 120_000,
    priceUsd: 0.00042,
    liquidityUsd: 24_000,
    volume5mUsd: 18_000,
    buys30s: 3.0,
    sells30s: 0.75,
    trades5m: 30,
    priceChange5mPct: 18,
    marketDataVerified: true
  };
  assert.equal(globalMomentumDecision(strong, NOW).ok, true);

  const weak = {
    ...strong,
    volume5mUsd: 900,
    liquidityUsd: 800,
    buys30s: 0.5,
    sells30s: 1.5,
    trades5m: 4,
    priceChange5mPct: 1
  };
  assert.equal(globalMomentumDecision(weak, NOW).ok, false);
});
