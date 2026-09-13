import { env } from './config/env.mjs';
import { scoreToken } from './core/scoring.mjs';
import { enrichTokenSnapshot, fetchNewListings } from './feeds/birdeye.mjs';
import { demoSnapshots } from './feeds/demo.mjs';
import { HeliusProgramStream } from './feeds/heliusWs.mjs';
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
let lastHeliusTriggerAt = 0;
let heliusStream = null;

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

async function tick(trigger = 'poll') {
  if (ticking) return false;
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
        trigger,
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
    return true;
  } finally {
    ticking = false;
  }
}

function startHeliusWakeups() {
  if (!env.heliusWsEnabled || !env.heliusApiKey || !env.birdeyeApiKey) return;

  heliusStream = new HeliusProgramStream({
    apiKey: env.heliusApiKey,
    programIds: env.heliusProgramIds,
    staleAfterMs: env.heliusStaleAfterMs,
    onEvent: (event) => {
      if (event.err) return;
      if (!['create', 'migrate'].includes(event.kind)) return;

      const now = Date.now();
      if (now - lastHeliusTriggerAt < env.heliusTriggerMinMs) return;
      lastHeliusTriggerAt = now;

      console.log(JSON.stringify({
        mode: 'helius-wakeup',
        kind: event.kind,
        signature: event.signature,
        slot: event.slot,
        observedAt: event.observedAt
      }));
      void tick(`helius:${event.kind}`).catch((error) => console.error('[helius-trigger]', error));
    }
  });
  heliusStream.start();
}

function shutdown(signal) {
  console.log(`[shutdown] ${signal}`);
  heliusStream?.stop();
  process.exit(0);
}

process.once('SIGINT', () => shutdown('SIGINT'));
process.once('SIGTERM', () => shutdown('SIGTERM'));

const liveMode = Boolean(env.birdeyeApiKey);
const heliusMode = liveMode && env.heliusWsEnabled && Boolean(env.heliusApiKey);
console.log(`SUMMECA Meme Radar v0.3 — PAPER ONLY — ${liveMode ? 'Birdeye live data' : 'demo feed'}${heliusMode ? ' + Helius WebSocket wakeups' : ''}`);
startHeliusWakeups();
await tick('startup');
setInterval(() => tick('fallback-poll').catch((err) => console.error('[tick]', err)), env.birdeyePollMs);
