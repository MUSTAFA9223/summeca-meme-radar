import { env } from './config/env.mjs';
import { scoreToken } from './core/scoring.mjs';
import { enrichTokenSnapshot, fetchNewListings } from './feeds/birdeye.mjs';
import { demoSnapshots } from './feeds/demo.mjs';
import { TelegramNotifier } from './notifiers/telegram.mjs';
import { PaperTrader } from './trading/paperTrader.mjs';

const trader = new PaperTrader({
  startingUsd: env.paperStartingUsd,
  tradeSizeUsd: env.paperTradeSizeUsd,
  maxOpen: env.maxOpenPositions,
  stopLossPct: env.paperStopLossPct,
  peakHunterStartPct: env.peakHunterStartPct
});
const telegram = new TelegramNotifier(env.telegramBotToken, env.telegramChatId);
const candidates = new Map();
const securityChecked = new Set();
let ticking = false;

const ageSeconds = (s) => Math.max(0, (Date.now() - s.listedAt) / 1000);

async function liveSnapshots() {
  const listings = await fetchNewListings(env.birdeyeApiKey, { limit: env.discoveryBatchSize });
  for (const listing of listings) {
    if (ageSeconds(listing) <= env.maxTokenAgeSeconds) {
      candidates.set(listing.address, { ...candidates.get(listing.address), ...listing });
    }
  }

  const openAddresses = new Set(trader.openPositions.map((p) => p.address));
  for (const [address, snapshot] of candidates) {
    if (!openAddresses.has(address) && ageSeconds(snapshot) > env.maxTokenAgeSeconds) {
      candidates.delete(address);
      securityChecked.delete(address);
    }
  }

  const openSnapshots = [...openAddresses].map((address) => candidates.get(address)).filter(Boolean);
  const freshCandidates = [...candidates.values()]
    .filter((snapshot) => !openAddresses.has(snapshot.address))
    .sort((a, b) => (b.listedAt - a.listedAt) || (b.liquidityUsd - a.liquidityUsd));
  const selected = [...openSnapshots, ...freshCandidates]
    .slice(0, Math.max(env.maxTrackedTokens, openSnapshots.length));

  const enriched = [];
  for (const base of selected) {
    const address = base.address;
    try {
      const snapshot = await enrichTokenSnapshot(env.birdeyeApiKey, base, {
        includeSecurity: !securityChecked.has(address)
      });
      candidates.set(address, snapshot);
      securityChecked.add(address);
      enriched.push(snapshot);
    } catch (error) {
      console.error('[enrich]', address, error.message);
      enriched.push(base);
    }
  }
  return enriched;
}

async function tick() {
  if (ticking) return;
  ticking = true;
  try {
    const live = Boolean(env.birdeyeApiKey);
    const snapshots = live ? await liveSnapshots() : demoSnapshots();

    for (const s of snapshots) {
      if (s.liquidityUsd < env.minLiquidityUsd) continue;
      if (!trader.openPositions.some((p) => p.address === s.address) && ageSeconds(s) > env.maxTokenAgeSeconds) continue;

      const scores = scoreToken(s);
      const existing = trader.openPositions.find((p) => p.address === s.address);
      if (existing) {
        const result = trader.update(s, scores);
        if (result.closed) await telegram.exit(result.closed);
        continue;
      }

      const p = trader.maybeEnter(s, scores, env.entryScoreThreshold);
      console.log(JSON.stringify({
        mode: live ? 'live-data/paper-trading' : 'demo/paper-trading',
        token: s.symbol,
        address: s.address,
        scores,
        flow: {
          buys30s: s.buys30s ?? 0,
          sells30s: s.sells30s ?? 0,
          uniqueBuyers30s: s.uniqueBuyers30s ?? 0
        },
        paperEntry: Boolean(p)
      }));
      if (scores.entry >= env.entryScoreThreshold) await telegram.signal(s, scores, p ?? undefined);
    }
  } finally {
    ticking = false;
  }
}

console.log(`SUMMECA Meme Radar v0.2 — PAPER ONLY — ${env.birdeyeApiKey ? 'Birdeye live discovery + enrichment' : 'demo feed'}`);
await tick();
setInterval(() => tick().catch((err) => console.error('[tick]', err)), env.birdeyePollMs);
