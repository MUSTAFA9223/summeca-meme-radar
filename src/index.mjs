import { env } from './config/env.mjs';
import { scoreToken } from './core/scoring.mjs';
import { fetchNewListings } from './feeds/birdeye.mjs';
import { demoSnapshots } from './feeds/demo.mjs';
import { TelegramNotifier } from './notifiers/telegram.mjs';
import { PaperTrader } from './trading/paperTrader.mjs';

const trader = new PaperTrader({ startingUsd: env.paperStartingUsd, tradeSizeUsd: env.paperTradeSizeUsd,
  maxOpen: env.maxOpenPositions, stopLossPct: env.paperStopLossPct, peakHunterStartPct: env.peakHunterStartPct });
const telegram = new TelegramNotifier(env.telegramBotToken, env.telegramChatId);
const seen = new Set();

async function tick() {
  const live = Boolean(env.birdeyeApiKey);
  const snapshots = live ? await fetchNewListings(env.birdeyeApiKey) : demoSnapshots();
  for (const s of snapshots) {
    if (s.liquidityUsd < env.minLiquidityUsd) continue;
    const scores = scoreToken(s);
    const existing = trader.openPositions.find(p => p.address === s.address);
    if (existing) {
      const result = trader.update(s, scores);
      if (result.closed) await telegram.exit(result.closed);
      continue;
    }
    if (seen.has(s.address)) continue;
    seen.add(s.address);
    const p = trader.maybeEnter(s, scores, env.entryScoreThreshold);
    console.log(JSON.stringify({ mode: live ? 'live-data/paper-trading' : 'demo/paper-trading', token: s.symbol, scores, paperEntry: Boolean(p) }));
    if (scores.entry >= env.entryScoreThreshold) await telegram.signal(s, scores, p ?? undefined);
  }
}

console.log(`SUMMECA Meme Radar v0.1 — PAPER ONLY — ${env.birdeyeApiKey ? 'Birdeye live discovery' : 'demo feed'}`);
await tick();
setInterval(() => tick().catch(err => console.error('[tick]', err)), env.birdeyePollMs);
