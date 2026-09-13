# Architecture

SUMMECA Meme Radar is a standalone Solana meme-token research and paper-trading service.

## Pipeline

1. **Discovery feed** — fresh Solana meme-token listings.
2. **Enrichment** — liquidity, trade flow, holder concentration, developer/insider/bundler signals.
3. **Risk Engine** — blocks critical-risk candidates independently from momentum.
4. **Early Entry Score** — measures freshness, buyer acceleration, buy/sell imbalance, volume acceleration, and liquidity quality.
5. **Moon Score** — tracks whether momentum remains exceptional after entry.
6. **Paper Trader** — simulates entries with hard portfolio limits.
7. **Peak Hunter** — adaptive exit logic after large gains, plus emergency exits when risk deteriorates.
8. **Notifications** — Telegram alerts for entries/exits and important state changes.

## Safety boundary

Live trading is deliberately disabled in v0.1. No private key, seed phrase, or signing secret belongs in the repository. A future live execution service, if enabled after validation, must use a separate capped trading wallet, secret storage, hard position limits, and a kill switch.

## Separation from SUMMECA website

This repository is independent from the production SUMMECA website. It must not share deployment secrets, application database credentials, or production payment/authentication infrastructure with the website.
