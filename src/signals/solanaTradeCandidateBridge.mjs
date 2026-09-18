import { env } from '../config/env.mjs';
import { SupabaseStore } from '../storage/supabaseStore.mjs';
import { PaperTrader } from '../trading/paperTrader.mjs';

const finite = (value, fallback = 0) => Number.isFinite(Number(value)) ? Number(value) : fallback;
const clamp = (value, min = 0, max = 100) => Math.max(min, Math.min(max, finite(value)));

function scoreFromUltra(score, profile = {}, market = {}) {
  const top10 = finite(profile?.top10UsersPct, 0);
  const limitedPenalty = profile?.limitedEvidence ? 6 : 0;
  const concentrationPenalty = top10 > 30 ? Math.min(24, (top10 - 30) * 1.2) : 0;
  const risk = Math.round(clamp(18 + limitedPenalty + concentrationPenalty));
  const entry = Math.round(clamp(score));
  const moon = Math.round(clamp(entry + Math.max(-8, Math.min(8, finite(market?.priceChange5mPct) / 5)) - risk * 0.08));
  return {
    entry,
    moon,
    risk,
    reasons: ['solana ultra qualified candidate'],
    blockers: []
  };
}

function marketTelemetry(market = {}) {
  const buys5m = finite(market?.buys5m);
  const sells5m = finite(market?.sells5m);
  return {
    marketCapUsd: finite(market?.marketCapUsd),
    liquidityUsd: finite(market?.liquidityUsd),
    buys5m,
    sells5m,
    volume5mUsd: finite(market?.volume5mUsd),
    buySellRatio: buys5m / Math.max(1, sells5m),
    priceChange5mPct: finite(market?.priceChange5mPct)
  };
}

function snapshotFromUltra({ mint, state, market, profile }) {
  return {
    address: mint,
    symbol: market?.symbol || 'TOKEN',
    name: market?.symbol || 'Token',
    source: 'solana-pumpfun-ultra',
    listedAt: Number(state?.createdAt) || Date.now(),
    observedAt: Date.now(),
    priceUsd: finite(market?.priceUsd),
    liquidityUsd: finite(market?.liquidityUsd),
    marketCapUsd: finite(market?.marketCapUsd),
    volume5mUsd: finite(market?.volume5mUsd),
    priceChange5mPct: finite(market?.priceChange5mPct),
    buys5m: finite(market?.buys5m),
    sells5m: finite(market?.sells5m),
    top10HolderPct: finite(profile?.top10UsersPct, null),
    holderCount: finite(profile?.observedAccounts, null),
    directCreate: true,
    marketDataVerified: finite(market?.priceUsd) > 0,
    securityVerified: false,
    raw: {
      profileProvider: profile?.provider || 'solana-rpc',
      profileLimitedEvidence: profile?.limitedEvidence === true,
      initialBuy: state?.initialBuy === true,
      flowWindow: '5m'
    }
  };
}

export class SolanaTradeCandidateBridge {
  constructor({
    store = new SupabaseStore(env.supabaseUrl, env.supabaseSecretKey),
    trader = new PaperTrader({
      startingUsd: env.paperStartingUsd,
      tradeSizeUsd: env.paperTradeSizeUsd,
      maxOpen: env.maxOpenPositions,
      stopLossPct: env.paperStopLossPct,
      peakHunterStartPct: env.peakHunterStartPct
    }),
    enabled = String(process.env.SOLANA_PAPER_BRIDGE_ENABLED ?? 'true').toLowerCase() !== 'false',
    paperMinScore = Math.max(50, Math.min(95, finite(process.env.SOLANA_PAPER_MIN_SCORE, 72))),
    paperProbeMinScore = Math.max(50, Math.min(95, finite(process.env.SOLANA_PAPER_PROBE_MIN_SCORE, 68))),
    logger = console
  } = {}) {
    this.store = store;
    this.trader = trader;
    this.enabled = enabled;
    this.paperMinScore = paperMinScore;
    this.paperProbeMinScore = paperProbeMinScore;
    this.logger = logger;
    this.initialized = false;
    this.initializing = null;
    this.stageCache = new Map();
    this.snapshotAt = new Map();
    this.signalSent = new Set();
  }

  async initialize() {
    if (this.initialized) return this.trader.openPositions;
    if (this.initializing) return this.initializing;
    this.initializing = (async () => {
      if (!this.store?.enabled) {
        this.initialized = true;
        return [];
      }
      try {
        const [rows, realized] = await Promise.all([
          this.store.listOpenPaperTrades(Math.max(10, env.maxOpenPositions * 4)),
          this.store.paperRealizedPnlUsd()
        ]);
        this.trader.setRealizedPnlUsd(realized);
        let restored = 0;
        for (const row of rows) {
          const result = this.trader.restoreOpenPosition(row);
          if (!result?.ok) continue;
          this.store.bindPaperTrade(result.position.address, row.id);
          restored += 1;
        }
        if (restored) this.logger.log(`[solana:paper-bridge] restored=${restored}`);
      } catch (error) {
        this.logger.warn?.('[solana:paper-bridge:init]', error?.message ?? error);
      }
      this.initialized = true;
      return this.trader.openPositions;
    })();
    return this.initializing;
  }

  hasOpenPaperPosition(address) {
    return Boolean(this.trader.getPosition(String(address ?? '')));
  }

  openPositions() {
    return this.trader.openPositions;
  }

  async recordStage({ mint, state, stage, score = null, reason = null, metadata = {} }) {
    if (!this.store?.enabled || !mint) return null;
    const key = `${stage}:${reason || ''}:${score ?? ''}`;
    const prior = this.stageCache.get(mint);
    const now = Date.now();
    if (prior?.key === key && now - prior.at < 30_000) return null;
    this.stageCache.set(mint, { key, at: now });
    try {
      return await this.store.upsertCandidateFunnel({
        network: 'solana',
        tokenAddress: mint,
        source: 'pumpfun-ultra',
        stage,
        score,
        rejectionReason: reason,
        firstSeenAt: Number(state?.createdAt) || now,
        metadata
      });
    } catch (error) {
      this.logger.warn?.(`[solana:funnel] mint=${String(mint).slice(0, 8)}… ${error?.message ?? error}`);
      return null;
    }
  }

  async observe({ mint, state, market, profile, score, qualified, paperEligible = qualified, rejectionReason = null }) {
    await this.initialize();
    const snapshot = snapshotFromUltra({ mint, state, market, profile });
    const scores = scoreFromUltra(score, profile, market);
    const existing = this.trader.getPosition(mint);

    if (existing) {
      const result = this.trader.update(snapshot, scores);
      try {
        if (result?.closed) {
          await this.store.saveSignal({
            tokenId: state?.tokenId ?? null,
            type: 'exit',
            scores,
            reason: { trigger: 'solana-ultra-paper-exit', exitReason: result.closed.exitReason }
          });
          await this.store.closePaperTrade(snapshot, scores, result.closed);
          await this.recordStage({
            mint,
            state,
            stage: 'paper_closed',
            score: scores.entry,
            metadata: { pnlPct: result.closed.pnlPct, exitReason: result.closed.exitReason }
          });
          return { paperClosed: true, position: result.closed, scores, snapshot };
        }
        await this.store.updateOpenPaperTrade(snapshot, existing);
      } catch (error) {
        this.logger.warn?.(`[solana:paper-bridge:update] mint=${String(mint).slice(0, 8)}… ${error?.message ?? error}`);
      }
    }

    const isProbe = !qualified && paperEligible;
    if (!qualified && !paperEligible) {
      await this.recordStage({
        mint,
        state,
        stage: rejectionReason === 'profile-provider-pending' ? 'profile_pending' : 'rejected',
        score: scores.entry,
        reason: rejectionReason,
        metadata: {
          profileProvider: profile?.provider || null,
          limitedEvidence: profile?.limitedEvidence === true,
          market: marketTelemetry(market)
        }
      });
      return { paperOpened: false, scores, snapshot };
    }

    if (isProbe) {
      await this.recordStage({
        mint,
        state,
        stage: 'paper_probe_candidate',
        score: scores.entry,
        reason: rejectionReason || 'profile-provider-pending',
        metadata: {
          profileProvider: profile?.provider || null,
          limitedEvidence: true,
          liveEligible: false,
          market: marketTelemetry(market)
        }
      });
    }

    let refs = null;
    const now = Date.now();
    if (!this.snapshotAt.has(mint) || now - this.snapshotAt.get(mint) >= 5_000) {
      this.snapshotAt.set(mint, now);
      try {
        refs = await this.store.saveSnapshot(snapshot, scores);
        if (refs?.tokenId) state.tokenId = refs.tokenId;
      } catch (error) {
        this.logger.warn?.(`[solana:paper-bridge:snapshot] mint=${String(mint).slice(0, 8)}… ${error?.message ?? error}`);
      }
    }

    if (qualified && !this.signalSent.has(mint) && state?.tokenId) {
      try {
        await this.store.saveSignal({
          tokenId: state.tokenId,
          snapshotId: refs?.snapshotId ?? null,
          type: 'entry',
          scores,
          reason: {
            trigger: 'solana-ultra-qualified',
            paperOnly: true,
            profileProvider: profile?.provider || 'solana-rpc',
            limitedEvidence: profile?.limitedEvidence === true
          }
        });
        this.signalSent.add(mint);
      } catch (error) {
        this.logger.warn?.(`[solana:paper-bridge:signal] mint=${String(mint).slice(0, 8)}… ${error?.message ?? error}`);
      }
    }

    const paperThreshold = qualified ? this.paperMinScore : this.paperProbeMinScore;
    const candidateStage = qualified ? 'qualified' : 'paper_probe_candidate';
    if (!this.enabled || scores.entry < paperThreshold || this.trader.getPosition(mint)) {
      await this.recordStage({ mint, state, stage: candidateStage, score: scores.entry, reason: isProbe ? rejectionReason : null });
      return { paperOpened: false, scores, snapshot };
    }

    const result = this.trader.enterQualified(snapshot, scores, {
      strategy: qualified ? 'solana-ultra-qualified' : 'solana-ultra-probe',
      sizeMultiplier: qualified ? 0.35 : 0.15
    });
    if (!result?.ok) {
      await this.recordStage({
        mint,
        state,
        stage: 'qualified',
        score: scores.entry,
        reason: `paper-${result?.reason || 'not-opened'}`
      });
      return { paperOpened: false, scores, snapshot, reason: result?.reason };
    }

    try {
      const tokenId = state?.tokenId || (await this.store.saveSnapshot(snapshot, scores))?.tokenId;
      if (tokenId) state.tokenId = tokenId;
      await this.store.openPaperTrade(snapshot, scores, result.position, tokenId);
      await this.recordStage({
        mint,
        state,
        stage: qualified ? 'paper_open' : 'paper_probe_open',
        score: scores.entry,
        metadata: { strategy: result.position.strategy, sizeUsd: result.position.usdSize, liveEligible: qualified }
      });
      this.logger.log(`[solana:paper-entry] mode=${qualified ? 'qualified' : 'probe'} mint=${String(mint).slice(0, 8)}… score=${scores.entry} usd=${Number(result.position.usdSize).toFixed(2)}`);
      return { paperOpened: true, position: result.position, scores, snapshot };
    } catch (error) {
      this.logger.warn?.(`[solana:paper-bridge:open] mint=${String(mint).slice(0, 8)}… ${error?.message ?? error}`);
      return { paperOpened: false, scores, snapshot, reason: 'persistence-failed' };
    }
  }
}

export { scoreFromUltra, snapshotFromUltra };
