import test from 'node:test';
import assert from 'node:assert/strict';
import { PaperTrader } from '../src/trading/paperTrader.mjs';

const cfg = (maxOpen = 2) => ({
  startingUsd: 1000,
  tradeSizeUsd: 100,
  maxOpen,
  stopLossPct: 10,
  peakHunterStartPct: 200
});

const persisted = (overrides = {}) => ({
  id: 'paper-trade-1',
  opened_at: '2026-09-15T08:00:00.000Z',
  entry_price_usd: '2',
  size_usd: '100',
  quantity: '50',
  peak_pnl_pct: '40',
  highest_price_usd: '2.8',
  moon_score: '70',
  metadata: {
    symbol: 'RESTORE',
    remaining_size_usd: 60,
    remaining_quantity: 30,
    realized_pnl_usd: 5,
    sold_pct: 40,
    manual: true,
    sizing: { mode: 'usd', value: 100 }
  },
  tokens: {
    address: 'RestoreAddress1111111111111111111111111111',
    symbol: 'RESTORE',
    name: 'Restore Token'
  },
  ...overrides
});

test('restores an open paper position and preserves remaining basis', () => {
  const trader = new PaperTrader(cfg());
  trader.setRealizedPnlUsd(12);

  const result = trader.restoreOpenPosition(persisted());
  assert.equal(result.ok, true);
  assert.equal(trader.openPositions.length, 1);
  assert.equal(result.position.persistenceId, 'paper-trade-1');
  assert.equal(result.position.usdSize, 60);
  assert.equal(result.position.quantity, 30);
  assert.equal(result.position.originalUsdSize, 100);
  assert.equal(result.position.originalQuantity, 50);
  assert.equal(result.position.highWaterPnlPct, 40);
  assert.equal(result.position.highWaterPriceUsd, 2.8);
  assert.equal(result.position.manual, true);
  assert.deepEqual(result.position.sizing, { mode: 'usd', value: 100 });
  assert.equal(trader.stats.realizedPnlUsd, 17);
  assert.equal(trader.availableUsd, 957);
});

test('does not restore duplicate addresses or exceed configured max positions', () => {
  const trader = new PaperTrader(cfg(1));
  assert.equal(trader.restoreOpenPosition(persisted()).ok, true);
  assert.equal(trader.restoreOpenPosition(persisted({ id: 'paper-trade-2' })).reason, 'max-open-positions');
  assert.equal(trader.openPositions.length, 1);
});

test('rejects empty or malformed persisted positions', () => {
  const trader = new PaperTrader(cfg());
  const empty = persisted({ metadata: { remaining_size_usd: 0, remaining_quantity: 0 } });
  assert.equal(trader.restoreOpenPosition(empty).reason, 'persisted-position-empty');
  const malformed = persisted({ entry_price_usd: null });
  assert.equal(trader.restoreOpenPosition(malformed).reason, 'invalid-persisted-position');
  assert.equal(trader.openPositions.length, 0);
});
