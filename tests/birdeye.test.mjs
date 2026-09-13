import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeSecurity, summarizeTrades } from '../src/feeds/birdeye.mjs';

test('summarizeTrades derives 30s flow and acceleration', () => {
  const nowMs = 2_000_000_000_000;
  const sec = (offset) => Math.floor((nowMs + offset * 1000) / 1000);
  const items = [
    { block_unix_time: sec(-10), tx_type: 'buy', owner: 'A', volume_usd: 100 },
    { block_unix_time: sec(-9), tx_type: 'buy', owner: 'B', volume_usd: 80 },
    { block_unix_time: sec(-8), tx_type: 'sell', owner: 'C', volume_usd: 20 },
    { block_unix_time: sec(-40), tx_type: 'buy', owner: 'D', volume_usd: 50 }
  ];
  const s = summarizeTrades(items, { nowMs, windowSeconds: 30 });
  assert.equal(s.buys30s, 2);
  assert.equal(s.sells30s, 1);
  assert.equal(s.buyVolume30sUsd, 180);
  assert.equal(s.sellVolume30sUsd, 20);
  assert.equal(s.uniqueBuyers30s, 2);
  assert.equal(s.buyerAcceleration, 2);
  assert.equal(s.volumeAcceleration, 4);
});

test('normalizeSecurity only sets known booleans and concentration', () => {
  const s = normalizeSecurity({ data: { freezeable: true, mintable: false, isHoneypot: false, top10HolderPercent: 21.5 } });
  assert.equal(s.freezeAuthorityDisabled, false);
  assert.equal(s.mintAuthorityDisabled, true);
  assert.equal(s.honeypot, false);
  assert.equal(s.top10HolderPct, 21.5);
});
