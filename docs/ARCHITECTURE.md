# Architecture

SUMMECA Meme Radar is a standalone private-access meme-token research, alerting, and paper-trading service with optional live execution that remains locked by default.

## Solana pipeline

1. **Direct discovery** — Pump.fun program events are detected from Solana/Helius WebSocket wakeups and transaction resolution.
2. **Market enrichment** — Birdeye is used when indexed; DexScreener and GeckoTerminal provide market fallbacks.
3. **On-chain safety** — Solana RPC verifies mint/freeze authority and Token-2022 extensions independently of third-party security indexing.
4. **Flow enrichment** — Birdeye V3 trades are preferred; legacy token trades are used when V3 indexing for a fresh mint is unavailable. Unknown buyer-wallet data is kept unknown rather than displayed as zero.
5. **Four-state safety gate** — `SAFE`, `UNKNOWN`, `DANGEROUS`, or `IGNORED`.
6. **Launch-pattern filter** — already-exploded, one-way, concentrated WOFI-style launches are excluded from new alerts/tracking.
7. **Scoring** — Early Entry, Moon Potential, Risk, and momentum remain separate signals. Missing holder data is not rewarded as if it were verified-safe data.
8. **Tracking** — SAFE and UNKNOWN opportunities can be performance-tracked; ignored launch patterns are retired silently.
9. **Paper trading** — simulated entries and Peak Hunter exits operate with position and portfolio limits.
10. **Persistence** — Supabase stores tokens, snapshots, signals, signal threads, paper trades, live-trade state, settings, activation codes, and subscribers.
11. **Telegram** — the owner gets full controls; other users require a one-time activation code and receive only permitted alerts/actions.

## Provider resilience

- Helius RPC/metadata calls back off after rate limiting and use public Solana read-only fallbacks where appropriate.
- Solana transaction resolution accepts version 0 and version 1 transactions.
- Birdeye security `400` responses on not-yet-indexed fresh tokens are treated as pending evidence, not proof of danger.
- A provider failure must not silently convert missing data into verified-safe data.

## Live-execution boundary

`LIVE_TRADING_ENABLED=false` is the default and production-safe state. The code contains a separate Privy wallet execution layer with Jupiter/PumpPortal routing, strict pre-entry safety checks, capped position sizing, reserve protection, stop loss, profit locking, and persistent live-trade state. Enabling it is a separate operational decision and is not implied by deploying the radar.

Secrets, wallet authorization material, API keys, and bot tokens must remain in the deployment secret stores and must never be committed to Git.

## Access boundary

Telegram activation codes are generated randomly and only their SHA-256 hashes are persisted. Codes are one-use by default, may expire, and can be revoked. Owner controls are not broadcast to subscribers.

## Separation from the SUMMECA website

This repository is independent from the production SUMMECA website. It must not share website payment/authentication state or expose website secrets through the radar service.
