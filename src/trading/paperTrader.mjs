import fs from 'node:fs';
import { ultraEarlyMomentumProfile } from '../core/momentumProfile.mjs';
import { peakExitDecision } from '../core/peakHunter.mjs';

const finite = (value, fallback = null) => {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
};

const positive = (value, fallback = null) => {
  const n = finite(value, null);
  return n != null && n > 0 ? n : fallback;
};

export class PaperTrader {
  #positions = new Map();
  #realizedPnlUsd = 0;
  constructor(cfg) { this.cfg = cfg; }

  get openPositions() { return [...this.#positions.values()].filter(p => p.status === 'open'); }
  get availableUsd() {
    const committed = this.openPositions.reduce((sum, p) => sum + Number(p.usdSize ?? 0), 0);
    return Math.max(0, Number(this.cfg.startingUsd ?? 0) + this.#realizedPnlUsd - committed);
  }
  get stats() {
    return {
      open: this.openPositions.length,
      realizedPnlUsd: this.#realizedPnlUsd,
      availableUsd: this.availableUsd
    };
  }

  setRealizedPnlUsd(value) {
    this.#realizedPnlUsd = finite(value, 0) ?? 0;
    return this.#realizedPnlUsd;
  }

  restoreOpenPosition(row = {}) {
    const token = row.tokens ?? {};
    const metadata = row.metadata ?? {};
    const address = String(token.address ?? row.address ?? '').trim();
    const entryPriceUsd = positive(row.entry_price_usd ?? row.entryPriceUsd);
    const originalUsdSize = positive(row.size_usd ?? row.originalUsdSize ?? row.usdSize);
    const originalQuantity = positive(row.quantity ?? row.originalQuantity);
    const remainingUsdSize = finite(metadata.remaining_size_usd, originalUsdSize);
    const remainingQuantity = finite(metadata.remaining_quantity, originalQuantity);

    if (!address || !entryPriceUsd || !originalUsdSize || !originalQuantity) {
      return { ok: false, reason: 'invalid-persisted-position' };
    }
    if (!(remainingUsdSize > 0) || !(remainingQuantity > 0)) {
      return { ok: false, reason: 'persisted-position-empty' };
    }
    if (this.openPositions.length >= this.cfg.maxOpen) return { ok: false, reason: 'max-open-positions' };
    if (this.getPosition(address)) return { ok: false, reason: 'position-already-open' };

    const openedAtMs = Date.parse(String(row.opened_at ?? ''));
    const realizedPnlUsd = finite(metadata.realized_pnl_usd, 0) ?? 0;
    const manual = metadata.manual === true;
    const position = {
      address,
      symbol: token.symbol ?? metadata.symbol ?? row.symbol ?? 'TOKEN',
      entryPriceUsd,
      entryAt: Number.isFinite(openedAtMs) ? openedAtMs : Date.now(),
      usdSize: remainingUsdSize,
      originalUsdSize,
      quantity: remainingQuantity,
      originalQuantity,
      realizedPnlUsd,
      soldPct: Math.max(0, Math.min(100, finite(metadata.sold_pct, 0) ?? 0)),
      highWaterPriceUsd: positive(row.highest_price_usd, entryPriceUsd) ?? entryPriceUsd,
      highWaterPnlPct: finite(row.peak_pnl_pct, 0) ?? 0,
      moonScoreAtEntry: finite(row.moon_score, 0) ?? 0,
      status: 'open',
      manual,
      sizing: metadata.sizing ?? null,
      strategy: String(metadata.strategy ?? metadata.sizing?.strategy ?? (manual ? 'manual' : 'standard')),
      lifecycleStrategy: String(metadata.sizing?.promotedTo ?? metadata.strategy ?? metadata.sizing?.strategy ?? (manual ? 'manual' : 'standard')),
      declineConfirmations: 0,
      forcedExitReason: null,
      persistenceId: row.id ?? null,
      restored: true
    };

    this.#positions.set(address, position);
    this.#realizedPnlUsd += realizedPnlUsd;
    return { ok: true, position };
  }

  getPosition(address) {
    const p = this.#positions.get(String(address ?? ''));
    return p?.status === 'open' ? p : null;
  }

  promoteLifecycle(address, nextStrategy = 'solana-ultra-qualified') {
    const p = this.getPosition(address);
    if (!p) return { ok: false, reason: 'no-open-position' };
    const next = String(nextStrategy || '').trim();
    if (!next) return { ok: false, reason: 'invalid-strategy' };
    if (p.lifecycleStrategy === next) return { ok: true, changed: false, position: p };

    const previous = p.lifecycleStrategy || p.strategy;
    p.lifecycleStrategy = next;
    if (next === 'solana-ultra-qualified') p.forcedExitReason = null;
    p.sizing = {
      ...(p.sizing && typeof p.sizing === 'object' ? p.sizing : {}),
      promotedFrom: previous,
      promotedTo: next,
      promotedAt: Date.now()
    };
    this.#log({ type: 'LIFECYCLE_PROMOTION', address: p.address, previous, next });
    return { ok: true, changed: true, previous, next, position: p };
  }

  requestExit(address, reason = 'paper capacity rebalance') {
    const p = this.getPosition(address);
    if (!p) return { ok: false, reason: 'no-open-position' };
    const text = String(reason || '').trim();
    if (!text) return { ok: false, reason: 'invalid-exit-reason' };
    p.forcedExitReason = text;
    this.#log({ type: 'EXIT_REQUESTED', address: p.address, strategy: p.strategy, lifecycleStrategy: p.lifecycleStrategy, reason: text });
    return { ok: true, position: p, reason: text };
  }

  #openPosition(s, scores, usdSize, { manual = false, sizing = null, strategy = 'standard' } = {}) {
    const requested = Number(usdSize);
    if (!Number.isFinite(requested) || requested <= 0 || Number(s.priceUsd) <= 0) {
      return { ok: false, reason: 'price-or-size-unavailable' };
    }
    if (this.openPositions.length >= this.cfg.maxOpen) return { ok: false, reason: 'max-open-positions' };
    if (this.#positions.has(s.address) && this.#positions.get(s.address)?.status === 'open') {
      return { ok: false, reason: 'position-already-open' };
    }

    const available = this.availableUsd;
    if (available <= 0) return { ok: false, reason: 'no-paper-cash' };
    const size = Math.min(requested, available);
    if (size <= 0) return { ok: false, reason: 'no-paper-cash' };
    const quantity = size / s.priceUsd;

    const p = {
      address: s.address,
      symbol: s.symbol,
      entryPriceUsd: s.priceUsd,
      entryAt: s.observedAt,
      usdSize: size,
      originalUsdSize: size,
      quantity,
      originalQuantity: quantity,
      realizedPnlUsd: 0,
      soldPct: 0,
      highWaterPriceUsd: s.priceUsd,
      highWaterPnlPct: 0,
      moonScoreAtEntry: scores.moon,
      status: 'open',
      manual,
      sizing,
      strategy,
      lifecycleStrategy: strategy,
      declineConfirmations: 0,
      forcedExitReason: null,
      persistenceId: null,
      restored: false
    };
    this.#positions.set(s.address, p);
    this.#log({ type: manual ? 'MANUAL_ENTRY' : 'ENTRY', position: p, scores });
    return { ok: true, position: p, requestedUsd: requested, actualUsd: size, availableBeforeUsd: available };
  }

  maybeEnter(s, scores, threshold) {
    const ultraEarly = ultraEarlyMomentumProfile(s, scores);
    const effectiveThreshold = ultraEarly.eligible ? Math.min(Number(threshold), 72) : Number(threshold);
    if (scores.entry < effectiveThreshold || scores.blockers.length || s.priceUsd <= 0) return null;

    const sizeMultiplier = ultraEarly.eligible ? 0.35 : 1;
    const requestedUsd = Number(this.cfg.tradeSizeUsd) * sizeMultiplier;
    const strategy = ultraEarly.eligible ? 'ultra-early-momentum' : 'standard';
    const sizing = ultraEarly.eligible
      ? {
          mode: 'strategy',
          strategy,
          sizeMultiplier,
          ageSec: ultraEarly.ageSec,
          buySellRatio: ultraEarly.ratio
        }
      : null;

    const result = this.#openPosition(s, scores, requestedUsd, { strategy, sizing });
    return result.ok ? result.position : null;
  }

  enterQualified(s, scores, {
    strategy = 'qualified',
    sizeMultiplier = 1
  } = {}) {
    const multiplier = Math.max(0.05, Math.min(1, Number(sizeMultiplier) || 1));
    const requestedUsd = Number(this.cfg.tradeSizeUsd) * multiplier;
    return this.#openPosition(s, scores, requestedUsd, {
      manual: false,
      strategy,
      sizing: {
        mode: 'strategy',
        strategy,
        sizeMultiplier: multiplier
      }
    });
  }

  enterManual(s, scores, sizing) {
    const mode = String(sizing?.mode ?? 'usd');
    const value = Number(sizing?.value);
    if (!Number.isFinite(value) || value <= 0) return { ok: false, reason: 'invalid-size' };

    let requestedUsd;
    if (mode === 'percent') {
      const pct = Math.max(0, Math.min(100, value));
      requestedUsd = this.availableUsd * (pct / 100);
    } else {
      requestedUsd = value;
    }

    return this.#openPosition(s, scores, requestedUsd, {
      manual: true,
      strategy: 'manual',
      sizing: { mode, value }
    });
  }

  manualSell(s, percent = 100) {
    const p = this.getPosition(s?.address);
    if (!p) return { ok: false, reason: 'no-open-position' };
    const price = Number(s?.priceUsd);
    if (!Number.isFinite(price) || price <= 0) return { ok: false, reason: 'price-unavailable' };

    const requestedPct = Number(percent);
    if (!Number.isFinite(requestedPct) || requestedPct <= 0) return { ok: false, reason: 'invalid-sell-percent' };
    const sellPct = Math.max(0, Math.min(100, requestedPct));
    const fraction = sellPct / 100;
    const costBasisUsd = Number(p.usdSize) * fraction;
    const quantitySold = Number(p.quantity) * fraction;
    const proceedsUsd = quantitySold * price;
    const legPnlUsd = proceedsUsd - costBasisUsd;
    const legPnlPct = ((price / Number(p.entryPriceUsd)) - 1) * 100;

    p.realizedPnlUsd = Number(p.realizedPnlUsd ?? 0) + legPnlUsd;
    this.#realizedPnlUsd += legPnlUsd;
    p.soldPct = Math.min(100, Number(p.soldPct ?? 0) + (100 - Number(p.soldPct ?? 0)) * fraction);

    const fullExit = sellPct >= 99.999 || Number(p.quantity) - quantitySold <= 1e-15;
    if (fullExit) {
      p.status = 'closed';
      p.exitPriceUsd = price;
      p.exitAt = s.observedAt ?? Date.now();
      p.exitReason = 'manual paper sell';
      p.quantity = 0;
      p.usdSize = 0;
      p.soldPct = 100;
      p.pnlPct = Number(p.originalUsdSize) > 0
        ? (Number(p.realizedPnlUsd) / Number(p.originalUsdSize)) * 100
        : legPnlPct;
      this.#log({
        type: 'MANUAL_EXIT',
        position: p,
        sellPct,
        proceedsUsd,
        legPnlUsd,
        legPnlPct
      });
      return {
        ok: true,
        closed: true,
        position: p,
        sellPct,
        proceedsUsd,
        legPnlUsd,
        legPnlPct,
        realizedPnlUsd: p.realizedPnlUsd,
        remainingUsdSize: 0,
        remainingQuantity: 0
      };
    }

    p.usdSize = Math.max(0, Number(p.usdSize) - costBasisUsd);
    p.quantity = Math.max(0, Number(p.quantity) - quantitySold);
    this.#log({
      type: 'MANUAL_PARTIAL_EXIT',
      address: p.address,
      symbol: p.symbol,
      sellPct,
      priceUsd: price,
      proceedsUsd,
      costBasisUsd,
      legPnlUsd,
      legPnlPct,
      remainingUsdSize: p.usdSize,
      remainingQuantity: p.quantity
    });
    return {
      ok: true,
      closed: false,
      position: p,
      sellPct,
      proceedsUsd,
      legPnlUsd,
      legPnlPct,
      realizedPnlUsd: p.realizedPnlUsd,
      remainingUsdSize: p.usdSize,
      remainingQuantity: p.quantity
    };
  }

  #ultraEarlyExitDecision(s, p, scores, pnlPct) {
    if (p.strategy !== 'ultra-early-momentum') return null;

    const observedAt = finite(s?.observedAt, Date.now()) ?? Date.now();
    const entryAt = finite(p.entryAt, observedAt) ?? observedAt;
    const holdSec = Math.max(0, (observedAt - entryAt) / 1000);
    const highWater = Number(p.highWaterPnlPct ?? 0);
    const drawdown = Math.max(0, highWater - pnlPct);
    const buys = Math.max(0, finite(s?.buys30s, 0) ?? 0);
    const sells = Math.max(0, finite(s?.sells30s, 0) ?? 0);
    const buyUsd = Math.max(0, finite(s?.buyVolume30sUsd, 0) ?? 0);
    const sellUsd = Math.max(0, finite(s?.sellVolume30sUsd, 0) ?? 0);
    const buyerAcceleration = finite(s?.buyerAcceleration, 1) ?? 1;
    const moon = Number(scores?.moon ?? 0);
    const emergencyBlockers = Array.isArray(scores?.blockers)
      ? scores.blockers.filter((b) => /honeypot|developer is selling|very low liquidity|freeze authority/.test(String(b)))
      : [];

    if (emergencyBlockers.length) {
      return { exit: true, reason: `emergency-risk: ${emergencyBlockers.join(', ')}`, holdSec, drawdown };
    }

    // Immediate launch failure protection remains active. This is separate from
    // profit-taking: a winning trade is otherwise allowed to run until a genuine
    // reversal is confirmed from its observed peak.
    if (pnlPct <= -6) {
      return { exit: true, reason: 'ultra-early hard stop-loss (-6%)', holdSec, drawdown };
    }

    // Do not react to tiny wicks. A winner must first establish a meaningful peak.
    if (highWater < 8) {
      p.declineConfirmations = 0;
      return { exit: false, holdSec, drawdown, highWaterPnlPct: highWater };
    }

    // Wider winners get more breathing room so a 100%+ runner is not sold on a
    // normal small pullback. We only call it a real decline when price has pulled
    // back materially from the peak AND order flow is weakening.
    const reversalDrawdownPct = highWater >= 100 ? 12 : highWater >= 40 ? 9 : highWater >= 15 ? 7 : 5;
    const severeDrawdownPct = reversalDrawdownPct * 1.75;
    const sellCountPressure = sells > buys;
    const sellVolumePressure = sellUsd > 0 && sellUsd >= buyUsd * 1.15;
    const flowBreaking = sellCountPressure
      || sellVolumePressure
      || buyerAcceleration < 0.8
      || moon < 60;
    const reversalCandidate = drawdown >= reversalDrawdownPct && flowBreaking;
    const severeReversal = drawdown >= severeDrawdownPct && (flowBreaking || sells >= buys);

    if (severeReversal) {
      p.declineConfirmations = 0;
      return {
        exit: true,
        reason: `ultra-early confirmed real decline (${drawdown.toFixed(1)}% from peak)`,
        holdSec,
        drawdown,
        highWaterPnlPct: highWater,
        reversalDrawdownPct,
        confirmation: 'severe'
      };
    }

    if (reversalCandidate) p.declineConfirmations = Number(p.declineConfirmations ?? 0) + 1;
    else p.declineConfirmations = 0;

    if (p.declineConfirmations >= 2) {
      p.declineConfirmations = 0;
      return {
        exit: true,
        reason: `ultra-early confirmed real decline (${drawdown.toFixed(1)}% from peak)`,
        holdSec,
        drawdown,
        highWaterPnlPct: highWater,
        reversalDrawdownPct,
        confirmation: 'two-snapshots'
      };
    }

    return {
      exit: false,
      holdSec,
      drawdown,
      highWaterPnlPct: highWater,
      reversalDrawdownPct,
      declineConfirmations: p.declineConfirmations,
      flowBreaking
    };
  }

  update(s, scores) {
    const p = this.#positions.get(s.address);
    if (!p || p.status !== 'open' || s.priceUsd <= 0) return {};
    const pnlPct = ((s.priceUsd / p.entryPriceUsd) - 1) * 100;
    if (s.priceUsd > p.highWaterPriceUsd) p.highWaterPriceUsd = s.priceUsd;
    p.highWaterPnlPct = Math.max(p.highWaterPnlPct, pnlPct);

    const observedAt = finite(s?.observedAt, Date.now()) ?? Date.now();
    const holdMs = Math.max(0, observedAt - (finite(p.entryAt, observedAt) ?? observedAt));
    const probeMaxHoldMs = Math.max(60_000, finite(this.cfg.probeMaxHoldMs, 20 * 60_000) ?? 20 * 60_000);
    const lifecycleStrategy = String(p.lifecycleStrategy ?? p.strategy ?? '');

    let d = null;
    if (p.forcedExitReason) {
      d = {
        exit: true,
        reason: p.forcedExitReason,
        holdMs,
        forced: true
      };
    }
    if (!d && lifecycleStrategy === 'solana-ultra-probe' && holdMs >= probeMaxHoldMs) {
      d = {
        exit: true,
        reason: `paper probe max-hold (${Math.round(probeMaxHoldMs / 60_000)}m)`,
        holdMs,
        probeMaxHoldMs
      };
    }
    if (!d) {
      d = p.strategy === 'ultra-early-momentum'
        ? this.#ultraEarlyExitDecision(s, p, scores, pnlPct)
        : peakExitDecision({
            snapshot: s,
            scores,
            pnlPct,
            highWaterPnlPct: p.highWaterPnlPct,
            stopLossPct: this.cfg.stopLossPct,
            peakHunterStartPct: this.cfg.peakHunterStartPct
          });
    }
    if (!d?.exit) return { pnlPct };

    const remainingPnlUsd = Number(p.usdSize) * (pnlPct / 100);
    p.realizedPnlUsd = Number(p.realizedPnlUsd ?? 0) + remainingPnlUsd;
    this.#realizedPnlUsd += remainingPnlUsd;
    p.status = 'closed';
    p.exitPriceUsd = s.priceUsd;
    p.exitAt = s.observedAt;
    p.pnlPct = Number(p.originalUsdSize) > 0
      ? (Number(p.realizedPnlUsd) / Number(p.originalUsdSize)) * 100
      : pnlPct;
    p.exitReason = d.reason;
    this.#log({ type: 'EXIT', position: p, scores, decision: d, remainingPnlUsd });
    return { closed: p, pnlPct: p.pnlPct };
  }

  #log(event) {
    fs.appendFileSync('paper-trades.jsonl', JSON.stringify({ at: new Date().toISOString(), ...event }) + '\n');
  }
}
