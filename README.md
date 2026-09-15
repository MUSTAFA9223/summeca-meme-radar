# SUMMECA Meme Radar

Private, real-time meme-token momentum radar focused on very early Solana launches, safety-gated tracking, Telegram alerts, paper trading, and optional locked-by-default live execution.

## Current release

Version **0.15.1** includes:

- Pump.fun direct-create detection through Solana/Helius WebSocket wakeups.
- Birdeye enrichment with DexScreener/GeckoTerminal and public Solana RPC fallbacks.
- Early Entry, Moon Potential, Risk, and momentum scoring.
- Four-state safety model: `SAFE`, `UNKNOWN`, `DANGEROUS`, and `IGNORED`.
- Continued performance tracking while safety evidence is still pending.
- Suppression of already-exploded, one-way WOFI-style launches.
- Persistent Supabase snapshots, signals, paper trades, and Telegram signal threads.
- Private Telegram access with one-time activation codes, expirations, revocation, and owner-only admin controls.
- Paper trading and Peak Hunter exits.
- Optional Privy + Jupiter/PumpPortal live automation that is **disabled by default** and remains fail-closed behind strict safety checks.

## Safety model

Incomplete evidence is not treated as confirmed danger:

- `SAFE`: eligible for normal entry logic.
- `UNKNOWN`: no real-money entry; momentum and performance can continue to be monitored.
- `DANGEROUS`: confirmed critical risk; execution is blocked.
- `IGNORED`: noisy/late/vertical launch patterns are removed from alerts and tracking.

Live execution should stay disabled until provider reliability, wallet configuration, and database permissions have been validated in the target environment.

## Run locally

```bash
npm install
cp .env.example .env
npm run check
npm run dev
```

Never commit `.env`, wallet authorization material, Telegram bot tokens, Supabase service-role keys, or provider API keys.

## Production

- Runtime: Railway
- Database: Supabase
- CI: GitHub Actions (`npm run check` plus live smoke tests on `main`)
- Node.js: 22+

See `docs/ARCHITECTURE.md` and the files under `supabase/migrations/` for the current architecture and reproducible database schema.
