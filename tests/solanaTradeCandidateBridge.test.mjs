import test from 'node:test';
import assert from 'node:assert/strict';
import { isSolanaBridgePaperTrade, SolanaTradeCandidateBridge } from '../src/signals/solanaTradeCandidateBridge.mjs';

class FakeStore {
  constructor() {
    this.enabled = true;
    this.funnel = [];
    this.snapshots = [];
    this.signals = [];
    this.opened = [];
    this.updated = [];
    this.closed = [];
  }
  async listOpenPaperTrades() { return []; }
  async paperRealizedPnlUsdForStrategies(strategies) { this.requestedStrategies = strategies; return 0; }
  bindPaperTrade() {}
  async upsertCandidateFunnel(row) { this.funnel.push(row); return row; }
  async saveSnapshot(snapshot, scores) {
    this.snapshots.push({ snapshot, scores });
    return { tokenId: 'token-1', snapshotId: 'snapshot-1' };
  }
  async saveSignal(row) { this.signals.push(row); }
  async openPaperTrade(snapshot, scores, position, tokenId) {
    this.opened.push({ snapshot, scores, position, tokenId });
    position.persistenceId = 'paper-1';
    return 'paper-1';
  }
  async updateOpenPaperTrade(snapshot, position) { this.updated.push({ snapshot, position }); }
  async closePaperTrade(snapshot, scores, position) { this.closed.push({ snapshot, scores, position }); }
}

class FakeTrader {
  constructor() {
    this.position = null;
    this.realized = 0;
    this.enterCalls = 0;
  }
  get openPositions() { return this.position ? [this.position] : []; }
  setRealizedPnlUsd(value) { this.realized = value; }
  restoreOpenPosition() { return { ok: false, reason: 'none' }; }
  getPosition(address) { return this.position?.address === address ? this.position : null; }
  enterQualified(snapshot, scores, options) {
    this.enterCalls += 1;
    if (this.position) return { ok: false, reason: 'position-already-open' };
    this.position = {
      address: snapshot.address,
      symbol: snapshot.symbol,
      entryPriceUsd: snapshot.priceUsd,
      entryAt: snapshot.observedAt,
      usdSize: 35,
      originalUsdSize: 35,
      quantity: 100,
      originalQuantity: 100,
      highWaterPnlPct: 0,
      highWaterPriceUsd: snapshot.priceUsd,
      realizedPnlUsd: 0,
      soldPct: 0,
      status: 'open',
      strategy: options.strategy,
      lifecycleStrategy: options.strategy,
      sizing: { strategy: options.strategy, sizeMultiplier: options.sizeMultiplier }
    };
    return { ok: true, position: this.position };
  }
  promoteLifecycle(address, next) {
    const position = this.getPosition(address);
    if (!position) return { ok: false, reason: 'no-open-position' };
    const previous = position.lifecycleStrategy;
    position.lifecycleStrategy = next;
    position.sizing = { ...(position.sizing || {}), promotedFrom: previous, promotedTo: next };
    this.promoteCalls = (this.promoteCalls || 0) + 1;
    return { ok: true, changed: previous !== next, previous, next, position };
  }
  update() { return { pnlPct: 1 }; }
}

const candidate = {
  mint: '11111111111111111111111111111111',
  state: { createdAt: Date.now() - 20_000, initialBuy: true },
  market: {
    symbol: 'TEST',
    priceUsd: 0.001,
    liquidityUsd: 12_000,
    marketCapUsd: 200_000,
    buys5m: 14,
    sells5m: 5,
    volume5mUsd: 4_000,
    priceChange5mPct: 12
  },
  profile: {
    pass: true,
    provider: 'solana-rpc',
    limitedEvidence: false,
    observedAccounts: 20,
    top10UsersPct: 25
  },
  score: 82
};

test('qualified Solana candidate persists a signal and opens one paper trade only', async () => {
  const store = new FakeStore();
  const trader = new FakeTrader();
  const bridge = new SolanaTradeCandidateBridge({ store, trader, enabled: true, paperMinScore: 72, logger: { log() {}, warn() {} } });

  const first = await bridge.observe({ ...candidate, qualified: true });
  const second = await bridge.observe({ ...candidate, qualified: true });

  assert.equal(first.paperOpened, true);
  assert.equal(second.paperOpened, false);
  assert.equal(trader.enterCalls, 1);
  assert.equal(store.opened.length, 1);
  assert.equal(store.signals.filter((row) => row.type === 'entry').length, 1);
  assert.ok(store.funnel.some((row) => row.stage === 'paper_open'));
});

test('provider-pending candidates are tracked without opening a paper position', async () => {
  const store = new FakeStore();
  const trader = new FakeTrader();
  const bridge = new SolanaTradeCandidateBridge({ store, trader, enabled: true, paperMinScore: 72, paperProbeMinScore: 68, logger: { log() {}, warn() {} } });

  const result = await bridge.observe({
    ...candidate,
    profile: null,
    score: 0,
    qualified: false,
    paperEligible: false,
    rejectionReason: 'profile-provider-pending'
  });

  assert.equal(result.paperOpened, false);
  assert.equal(trader.enterCalls, 0);
  assert.equal(store.opened.length, 0);
  assert.ok(store.funnel.some((row) => row.stage === 'profile_pending' && row.rejectionReason === 'profile-provider-pending'));
});

test('score below the paper threshold remains a durable qualified candidate without auto paper entry', async () => {
  const store = new FakeStore();
  const trader = new FakeTrader();
  const bridge = new SolanaTradeCandidateBridge({ store, trader, enabled: true, paperMinScore: 80, logger: { log() {}, warn() {} } });

  const result = await bridge.observe({ ...candidate, score: 75, qualified: true });

  assert.equal(result.paperOpened, false);
  assert.equal(trader.enterCalls, 0);
  assert.equal(store.signals.length, 1);
  assert.ok(store.funnel.some((row) => row.stage === 'qualified'));
});


test('paper-only probe opens for a strong provider-pending candidate without creating a normal entry signal', async () => {
  const store = new FakeStore();
  const trader = new FakeTrader();
  const bridge = new SolanaTradeCandidateBridge({ store, trader, enabled: true, paperMinScore: 72, paperProbeMinScore: 68, logger: { log() {}, warn() {} } });

  const result = await bridge.observe({
    ...candidate,
    profile: null,
    score: 74,
    qualified: false,
    paperEligible: true,
    rejectionReason: 'profile-provider-pending'
  });

  assert.equal(result.paperOpened, true);
  assert.equal(trader.enterCalls, 1);
  assert.equal(store.opened.length, 1);
  assert.equal(store.signals.filter((row) => row.type === 'entry').length, 0);
  assert.equal(store.opened[0].position.strategy, 'solana-ultra-probe');
  assert.ok(store.funnel.some((row) => row.stage === 'paper_probe_open'));
});


test('strategy isolation excludes legacy paper trades from the Solana bridge bankroll', async () => {
  assert.equal(isSolanaBridgePaperTrade({ metadata: { sizing: { strategy: 'solana-ultra-probe' } } }), true);
  assert.equal(isSolanaBridgePaperTrade({ metadata: { sizing: { strategy: 'solana-ultra-qualified' } } }), true);
  assert.equal(isSolanaBridgePaperTrade({ metadata: { sizing: { strategy: 'legacy-paper-entry' } } }), false);
  assert.equal(isSolanaBridgePaperTrade({ metadata: { manual: true } }), false);

  const store = new FakeStore();
  const trader = new FakeTrader();
  const bridge = new SolanaTradeCandidateBridge({ store, trader, logger: { log() {}, warn() {} } });
  await bridge.initialize();

  assert.deepEqual(new Set(store.requestedStrategies), new Set(['solana-ultra-qualified', 'solana-ultra-probe']));
  assert.equal(trader.realized, 0);
});


test('existing probe is promoted when holder profile later qualifies without opening a duplicate trade', async () => {
  const store = new FakeStore();
  const trader = new FakeTrader();
  const bridge = new SolanaTradeCandidateBridge({ store, trader, enabled: true, paperMinScore: 72, paperProbeMinScore: 68, logger: { log() {}, warn() {} } });

  const probe = await bridge.observe({
    ...candidate,
    profile: null,
    score: 74,
    qualified: false,
    paperEligible: true,
    rejectionReason: 'profile-provider-pending'
  });
  assert.equal(probe.paperOpened, true);

  const qualified = await bridge.observe({
    ...candidate,
    score: 82,
    qualified: true,
    paperEligible: true,
    rejectionReason: null
  });

  assert.equal(qualified.paperOpened, false);
  assert.equal(trader.enterCalls, 1);
  assert.equal(trader.promoteCalls, 1);
  assert.equal(trader.position.lifecycleStrategy, 'solana-ultra-qualified');
  assert.ok(store.funnel.some((row) => row.stage === 'paper_promoted'));
});
