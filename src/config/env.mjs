import fs from 'node:fs';

function loadDotEnv() {
  if (!fs.existsSync('.env')) return;
  for (const raw of fs.readFileSync('.env', 'utf8').split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const i = line.indexOf('=');
    if (i < 1) continue;
    const key = line.slice(0, i).trim();
    const value = line.slice(i + 1).trim().replace(/^['"]|['"]$/g, '');
    if (!(key in process.env)) process.env[key] = value;
  }
}
loadDotEnv();

const num = (name, fallback) => {
  const v = Number(process.env[name] ?? fallback);
  if (!Number.isFinite(v)) throw new Error(`Invalid numeric env ${name}`);
  return v;
};

export const env = {
  birdeyeApiKey: process.env.BIRDEYE_API_KEY ?? '',
  birdeyePollMs: Math.max(5000, num('BIRDEYE_POLL_MS', 10000)),
  discoveryBatchSize: Math.max(1, Math.min(20, Math.floor(num('DISCOVERY_BATCH_SIZE', 10)))),
  maxTrackedTokens: Math.max(1, Math.min(10, Math.floor(num('MAX_TRACKED_TOKENS', 3)))),
  telegramBotToken: process.env.TELEGRAM_BOT_TOKEN ?? '',
  telegramChatId: process.env.TELEGRAM_CHAT_ID ?? '',
  liveTradingEnabled: (process.env.LIVE_TRADING_ENABLED ?? 'false') === 'true',
  minLiquidityUsd: num('MIN_LIQUIDITY_USD', 8000),
  entryScoreThreshold: num('ENTRY_SCORE_THRESHOLD', 82),
  moonScoreThreshold: num('MOON_SCORE_THRESHOLD', 88),
  maxTokenAgeSeconds: num('MAX_TOKEN_AGE_SECONDS', 300),
  paperStartingUsd: num('PAPER_STARTING_USD', 1000),
  paperTradeSizeUsd: num('PAPER_TRADE_SIZE_USD', 25),
  maxOpenPositions: Math.max(1, Math.min(3, Math.floor(num('MAX_OPEN_POSITIONS', 2)))),
  paperStopLossPct: num('PAPER_STOP_LOSS_PCT', 22),
  peakHunterStartPct: num('PEAK_HUNTER_START_PCT', 200)
};

if (env.liveTradingEnabled) {
  throw new Error('Safety lock: live trading is intentionally disabled. Use paper trading and validate results first.');
}
