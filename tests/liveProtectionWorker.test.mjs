import test from 'node:test';
import assert from 'node:assert/strict';
import { LiveProtectionEngine } from '../src/trading/liveProtectionWorker.mjs';
import { protectionSettings } from '../src/trading/liveProtectionPolicy.mjs';

const settings = protectionSettings({
  LIVE_PROTECTION_POLL_MS: '1500',
  LIVE_PROTECTION_UNCERTAINTY_GRACE_MS: '60000'
});

function baseTrade(overrides = {}) {
  return {
    id: '11111111-1111-4111-8111-111111111111',
    token_id: '22222222-2222-4222-8222-222222222222',
    wallet_address: 'wallet',
    status: 'open',
    entry_price_usd: 1,
    input_sol: 0.01,
    quantity_atomic: '1000',
    high_water_pnl_pct: 0,
    highest_price_usd: 1,
    current_stop: -10,
    stop_reason: 'initial-stop',
    protection_started_at: new Date().toISOString(),
    metadata: { remaining_cost_basis_sol: 0.01 },
    tokens: { address: 'TokenMint1111111111111111111111111111111', symbol: 'TEST' },
    ...overrides
  };
}

test('safe mode observes stop trigger but never broadcasts', async () => {
  const audits = [];
  let claimed = false;
  let executed = false;
  const store = {
    updateLiveTrade: async () => ({}),
    latestRiskSignal: async () => null,
    getAudit: async () => null,
    createAudit: async (row) => { audits.push(row); return row; },
    claimLiveTradeForSell: async () => { claimed = true; return null; }
  };
  const engine = new LiveProtectionEngine({
    store,
    settings,
    broadcastEnabled: false,
    marketProvider: async () => ({ priceUsd: 0.85, liquidityUsd: 20_000, priceSources: ['test'] }),
    securityProvider: async () => ({ mintAuthorityDisabled: true, freezeAuthorityDisabled: true }),
    balanceReader: async () => 1000n,
    jupiter: { configured: true, getOrder: async () => { executed = true; }, executeOrder: async () => { executed = true; } }
  });
  engine.sellQuote = async () => ({ outAmountAtomic: '8500000', routePnlPct: -15 });

  await engine.monitorOpenTrade(baseTrade());

  assert.equal(executed, false);
  assert.equal(claimed, false);
  assert.equal(audits.length, 1);
  assert.equal(audits[0].status, 'blocked');
  assert.equal(audits[0].error, 'LIVE_TRADING_ENABLED=false');
});

test('duplicate sell DB lock prevents a second execution', async () => {
  let orderCalls = 0;
  const store = {
    claimLiveTradeForSell: async () => null
  };
  const engine = new LiveProtectionEngine({
    store,
    settings,
    broadcastEnabled: true,
    jupiter: {
      configured: true,
      getOrder: async () => { orderCalls += 1; return {}; },
      executeOrder: async () => { orderCalls += 1; return {}; }
    }
  });

  const result = await engine.attemptSell(baseTrade(), 'stop:test');
  assert.equal(result.locked, false);
  assert.equal(orderCalls, 0);
});

test('restart recovery closes a trade whose protection audit already succeeded', async () => {
  const updates = [];
  const store = {
    getAudit: async () => ({
      request_id: 'protect:req',
      status: 'succeeded',
      tx_hash: 'confirmed-signature',
      payload: {
        trigger: 'stop:trailing',
        targetAmountAtomic: '1000',
        outputAmountAtomic: '12000000',
        marketPriceUsd: 1.2
      }
    }),
    updateLiveTrade: async (id, patch) => { updates.push({ id, patch }); return patch; }
  };
  const engine = new LiveProtectionEngine({ store, settings, broadcastEnabled: false });
  await engine.reconcileClosingTrade(baseTrade({
    status: 'closing',
    sell_lock_request_id: 'protect:req'
  }));

  assert.equal(updates.at(-1).patch.status, 'closed');
  assert.equal(updates.at(-1).patch.exit_tx, 'confirmed-signature');
});

test('failure after broadcast stays closing until balance/signature reconciliation', async () => {
  const tradeUpdates = [];
  const auditUpdates = [];
  let executeCalls = 0;
  const store = {
    claimLiveTradeForSell: async (id, requestId, reason) => ({ ...baseTrade(), id, status: 'closing', sell_lock_request_id: requestId, exit_reason: reason }),
    createAudit: async (row) => ({ ...row, payload: row.payload }),
    transitionAudit: async (requestId, expected, next, patch) => ({ request_id: requestId, status: next, payload: patch.payload }),
    updateAudit: async (requestId, patch) => { auditUpdates.push({ requestId, patch }); return patch; },
    updateLiveTrade: async (id, patch) => { tradeUpdates.push({ id, patch }); return patch; },
    appendAuditEvent: async () => null,
    getAudit: async () => ({
      request_id: auditUpdates[0]?.requestId || 'protect:req',
      status: 'failed',
      tx_hash: null,
      error: 'timeout',
      created_at: new Date(Date.now() - 120000).toISOString(),
      updated_at: new Date(Date.now() - 120000).toISOString(),
      payload: {
        trigger: 'stop:test',
        balanceBeforeAtomic: '1000',
        targetAmountAtomic: '1000',
        executionUncertain: true,
        executionStartedAt: new Date(Date.now() - 120000).toISOString()
      }
    })
  };
  const engine = new LiveProtectionEngine({
    store,
    settings,
    broadcastEnabled: true,
    balanceReader: async () => 0n,
    jupiter: {
      configured: true,
      getOrder: async () => ({ requestId: 'jupiter-request', transaction: 'tx', outAmount: '9000000' }),
      executeOrder: async () => {
        executeCalls += 1;
        throw new Error('router timeout after broadcast');
      }
    }
  });

  const first = await engine.attemptSell(baseTrade(), 'stop:test', { balance: 1000n, amountAtomic: 1000n });
  assert.equal(first.uncertain, true);
  assert.equal(executeCalls, 1);
  assert.equal(tradeUpdates.some((x) => x.patch.status === 'open'), false);
  assert.equal(tradeUpdates.at(-1).patch.status, 'closing');
  assert.equal(auditUpdates.at(-1).patch.payload.executionUncertain, true);

  await engine.reconcileClosingTrade(baseTrade({
    status: 'closing',
    sell_lock_request_id: auditUpdates[0]?.requestId || 'protect:req',
    sell_broadcast_at: new Date(Date.now() - 120000).toISOString()
  }));

  assert.equal(executeCalls, 1);
  assert.equal(tradeUpdates.at(-1).patch.status, 'closed');
});
