import fs from 'node:fs';
import { peakExitDecision } from '../core/peakHunter.mjs';

export class PaperTrader {
  #positions = new Map();
  #realizedPnlUsd = 0;
  constructor(cfg) { this.cfg = cfg; }
  get openPositions() { return [...this.#positions.values()].filter(p => p.status === 'open'); }
  get stats() { return { open: this.openPositions.length, realizedPnlUsd: this.#realizedPnlUsd }; }

  maybeEnter(s, scores, threshold) {
    if (scores.entry < threshold || scores.blockers.length || s.priceUsd <= 0) return null;
    if (this.openPositions.length >= this.cfg.maxOpen || this.#positions.has(s.address)) return null;
    const p = {
      address: s.address, symbol: s.symbol, entryPriceUsd: s.priceUsd, entryAt: s.observedAt,
      usdSize: this.cfg.tradeSizeUsd, quantity: this.cfg.tradeSizeUsd / s.priceUsd,
      highWaterPriceUsd: s.priceUsd, highWaterPnlPct: 0, moonScoreAtEntry: scores.moon, status: 'open'
    };
    this.#positions.set(s.address, p);
    this.#log({ type: 'ENTRY', position: p, scores });
    return p;
  }

  update(s, scores) {
    const p = this.#positions.get(s.address);
    if (!p || p.status !== 'open' || s.priceUsd <= 0) return {};
    const pnlPct = ((s.priceUsd / p.entryPriceUsd) - 1) * 100;
    if (s.priceUsd > p.highWaterPriceUsd) p.highWaterPriceUsd = s.priceUsd;
    p.highWaterPnlPct = Math.max(p.highWaterPnlPct, pnlPct);
    const d = peakExitDecision({ snapshot: s, scores, pnlPct, highWaterPnlPct: p.highWaterPnlPct,
      stopLossPct: this.cfg.stopLossPct, peakHunterStartPct: this.cfg.peakHunterStartPct });
    if (!d.exit) return { pnlPct };
    p.status = 'closed'; p.exitPriceUsd = s.priceUsd; p.exitAt = s.observedAt;
    p.pnlPct = pnlPct; p.exitReason = d.reason;
    this.#realizedPnlUsd += p.usdSize * (pnlPct / 100);
    this.#log({ type: 'EXIT', position: p, scores, decision: d });
    return { closed: p, pnlPct };
  }
  #log(event) { fs.appendFileSync('paper-trades.jsonl', JSON.stringify({ at: new Date().toISOString(), ...event }) + '\n'); }
}
