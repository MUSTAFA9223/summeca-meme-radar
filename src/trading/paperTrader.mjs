import fs from 'node:fs';
import { peakExitDecision } from '../core/peakHunter.mjs';

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

  getPosition(address) {
    const p = this.#positions.get(String(address ?? ''));
    return p?.status === 'open' ? p : null;
  }

  #openPosition(s, scores, usdSize, { manual = false, sizing = null } = {}) {
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
      sizing
    };
    this.#positions.set(s.address, p);
    this.#log({ type: manual ? 'MANUAL_ENTRY' : 'ENTRY', position: p, scores });
    return { ok: true, position: p, requestedUsd: requested, actualUsd: size, availableBeforeUsd: available };
  }

  maybeEnter(s, scores, threshold) {
    if (scores.entry < threshold || scores.blockers.length || s.priceUsd <= 0) return null;
    const result = this.#openPosition(s, scores, this.cfg.tradeSizeUsd);
    return result.ok ? result.position : null;
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

  update(s, scores) {
    const p = this.#positions.get(s.address);
    if (!p || p.status !== 'open' || s.priceUsd <= 0) return {};
    const pnlPct = ((s.priceUsd / p.entryPriceUsd) - 1) * 100;
    if (s.priceUsd > p.highWaterPriceUsd) p.highWaterPriceUsd = s.priceUsd;
    p.highWaterPnlPct = Math.max(p.highWaterPnlPct, pnlPct);
    const d = peakExitDecision({
      snapshot: s,
      scores,
      pnlPct,
      highWaterPnlPct: p.highWaterPnlPct,
      stopLossPct: this.cfg.stopLossPct,
      peakHunterStartPct: this.cfg.peakHunterStartPct
    });
    if (!d.exit) return { pnlPct };

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
