import { ignoredLaunchPattern } from '../core/launchPattern.mjs';

const DEFAULT_MILESTONES = [20, 25, 50, 100, 200, 300, 500, 750, 1000, 1500, 2000, 3000, 5000, 10000, 20000, 50000];

const positive = (value) => {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : null;
};

export class SignalTracker {
  #threads = new Map();
  #cursor = 0;

  constructor({ milestones = DEFAULT_MILESTONES, ttlMs = 6 * 60 * 60 * 1000 } = {}) {
    this.milestones = [...milestones].map(Number).filter(Number.isFinite).sort((a, b) => a - b);
    this.ttlMs = Math.max(60_000, Number(ttlMs) || 6 * 60 * 60 * 1000);
  }

  get size() { return this.#threads.size; }
  has(address) { return this.#threads.has(String(address ?? '')); }
  get(address) { return this.#threads.get(String(address ?? '')) ?? null; }
  values() { return [...this.#threads.values()]; }

  start({ tokenId, chatId, rootMessageId, snapshot, startedAt = Date.now(), referencePriceUsd = null, peakPriceUsd = null, peakReturnPct = 0, lastMilestonePct = 0 }) {
    const address = String(snapshot?.address ?? '');
    if (!address || !rootMessageId) return null;
    const reference = positive(referencePriceUsd) ?? positive(snapshot?.priceUsd);
    const peak = positive(peakPriceUsd) ?? reference;
    const thread = {
      tokenId,
      chatId: String(chatId ?? ''),
      rootMessageId: Number(rootMessageId),
      address,
      symbol: snapshot?.symbol ?? 'TOKEN',
      name: snapshot?.name ?? snapshot?.symbol ?? 'Token',
      imageUrl: snapshot?.imageUrl ?? null,
      startedAt: new Date(startedAt).getTime() || Date.now(),
      referencePriceUsd: reference,
      peakPriceUsd: peak,
      peakReturnPct: Number(peakReturnPct) || 0,
      lastMilestonePct: Number(lastMilestonePct) || 0
    };
    this.#threads.set(address, thread);
    return thread;
  }

  restore(rows = []) {
    for (const row of Array.isArray(rows) ? rows : []) {
      const token = row.tokens ?? {};
      const snapshot = {
        address: token.address,
        symbol: token.symbol,
        name: token.name,
        imageUrl: row.image_url ?? null
      };
      this.start({
        tokenId: row.token_id,
        chatId: row.chat_id,
        rootMessageId: row.root_message_id,
        snapshot,
        startedAt: row.started_at,
        referencePriceUsd: row.reference_price_usd,
        peakPriceUsd: row.peak_price_usd,
        peakReturnPct: row.peak_return_pct,
        lastMilestonePct: row.last_milestone_pct
      });
    }
    return this.values();
  }

  remove(address) {
    return this.#threads.delete(String(address ?? ''));
  }

  nextAddresses(limit = 2, exclude = []) {
    const excluded = new Set(exclude);
    const addresses = [...this.#threads.keys()].filter((address) => !excluded.has(address));
    if (!addresses.length || limit <= 0) return [];
    const picked = [];
    for (let i = 0; i < Math.min(limit, addresses.length); i += 1) {
      picked.push(addresses[(this.#cursor + i) % addresses.length]);
    }
    this.#cursor = (this.#cursor + picked.length) % addresses.length;
    return picked;
  }

  observe(snapshot) {
    const thread = this.get(snapshot?.address);
    if (!thread) return null;
    const now = Number(snapshot?.observedAt) || Date.now();
    if (now - thread.startedAt > this.ttlMs) {
      return { type: 'expired', thread, reason: 'ttl' };
    }

    // If a tracked launch later reveals the already-exploded/one-way pattern,
    // retire the thread silently. The caller handles `expired` by deactivating
    // persistence and removing it without sending another Telegram alert.
    const ignored = ignoredLaunchPattern(snapshot);
    if (ignored.ignored) {
      return { type: 'expired', thread, reason: 'ignored-launch-pattern', ignoredReasons: ignored.reasons };
    }

    const price = positive(snapshot?.priceUsd);
    if (!price) return null;

    if (!thread.referencePriceUsd) {
      thread.referencePriceUsd = price;
      thread.peakPriceUsd = price;
      thread.peakReturnPct = 0;
      return { type: 'reference', thread, returnPct: 0, priceUsd: price };
    }

    const returnPct = ((price / thread.referencePriceUsd) - 1) * 100;
    if (!Number.isFinite(returnPct)) return null;

    if (!thread.peakPriceUsd || price > thread.peakPriceUsd) thread.peakPriceUsd = price;
    thread.peakReturnPct = Math.max(thread.peakReturnPct ?? 0, returnPct);

    const crossed = this.milestones.filter((milestone) => milestone > thread.lastMilestonePct && returnPct >= milestone);
    if (!crossed.length) return null;
    const milestonePct = crossed[crossed.length - 1];
    thread.lastMilestonePct = milestonePct;
    return {
      type: 'milestone',
      thread,
      milestonePct,
      returnPct,
      peakReturnPct: thread.peakReturnPct,
      priceUsd: price
    };
  }
}

export { DEFAULT_MILESTONES };
