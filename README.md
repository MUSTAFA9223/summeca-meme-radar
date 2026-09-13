# SUMMECA Meme Radar

Early-momentum Solana meme-token research bot. **v0.1 is paper-trading only.** It does not hold keys and cannot send live trades.

## What v0.1 does

- Monitors fresh Solana meme listings (Birdeye when configured; demo feed otherwise).
- Computes **Early Entry**, **Moon Potential**, and **Risk** scores.
- Blocks obvious critical-risk candidates.
- Simulates entries and adaptive Peak-Hunter exits.
- Logs simulated trades to `paper-trades.jsonl`.
- Can send Telegram alerts.

## Run

```bash
npm install
cp .env.example .env
npm run check
npm run dev
```

Add your own `BIRDEYE_API_KEY` and optional Telegram credentials to `.env`. Never commit `.env`.

## Safety architecture

Live execution is deliberately locked in this release. The next milestone is realtime enrichment (1s/15s trades, holder/risk data), replay/backtesting, and measurable precision/recall. Only after those metrics are acceptable should a **separate, capped trading wallet** and a live execution adapter be considered.

## Scoring philosophy

The bot does not claim to predict a +5000% token. It detects early demand acceleration, keeps risk independent from momentum, and lets exceptional runners stay open while momentum remains healthy.

## Next milestones

1. Birdeye WebSocket enrichment: new listings, MEME_STATS, token transactions.
2. Helius low-latency Solana stream as a second source and failover.
3. Persistent SQLite/Postgres event store and historical replay.
4. Backtest entry/exit thresholds over failed, +2x, +5x, +10x, +50x cohorts.
5. Telegram controls and mobile dashboard.
6. Optional live execution only after paper-trading validation and hard risk caps.
