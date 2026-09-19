import { sharedHeliusRpc } from '../infra/solanaRpcManager.mjs';

const finite = (value, fallback = 0) => Number.isFinite(Number(value)) ? Number(value) : fallback;

const cache = new Map();

const CACHE_MS = Math.max(2_000, Math.min(60_000, finite(process.env.HELIUS_HOLDER_CACHE_MS, 10_000)));
const COOLDOWN_MS = Math.max(5_000, Math.min(120_000, finite(process.env.HELIUS_HOLDER_COOLDOWN_MS, 30_000)));
const TIMEOUT_MS = Math.max(1_500, Math.min(10_000, finite(process.env.HELIUS_HOLDER_TIMEOUT_MS, 4_000)));
const LIMIT = 1_000;

function amountOf(account = {}) {
  const raw = account.amount ?? account.token_amount ?? account.tokenAmount ?? account.balance ?? 0;
  const value = Number(raw);
  return Number.isFinite(value) && value > 0 ? value : 0;
}

export function holderProfileFromTokenAccounts(accounts = [], { complete = true, provider = 'helius-token-accounts' } = {}) {
  const byOwner = new Map();
  for (const account of Array.isArray(accounts) ? accounts : []) {
    const owner = String(account?.owner ?? account?.owner_address ?? account?.ownerAddress ?? '').trim();
    const amount = amountOf(account);
    if (!owner || !(amount > 0)) continue;
    byOwner.set(owner, (byOwner.get(owner) ?? 0) + amount);
  }

  const balances = [...byOwner.values()].filter((amount) => amount > 0).sort((a, b) => b - a);
  const observedSupply = balances.reduce((sum, amount) => sum + amount, 0);
  if (!(observedSupply > 0) || !balances.length) return null;

  const shares = balances.map((amount) => amount / observedSupply * 100);
  // Pump.fun bonding-curve custody is commonly the dominant token account early on.
  // Preserve the existing conservative heuristic: exclude only a clearly dominant
  // first account. If the provider response is truncated, never mark the profile safe.
  const curveExcluded = shares[0] >= 20;
  const userShares = curveExcluded ? shares.slice(1) : shares;
  const observedAccounts = userShares.filter((pct) => pct > 0).length;
  const topUserPct = userShares[0] || 0;
  const top5UsersPct = userShares.slice(0, 5).reduce((sum, pct) => sum + pct, 0);
  const top10UsersPct = userShares.slice(0, 10).reduce((sum, pct) => sum + pct, 0);
  const meaningfulWallets = userShares.filter((pct) => pct >= 0.35 && pct <= 8).length;

  const pass = complete
    && observedAccounts >= 4
    && topUserPct <= 12
    && top5UsersPct <= 30
    && top10UsersPct <= 45
    && meaningfulWallets >= 2;

  return {
    pass,
    provider,
    limitedEvidence: !complete,
    complete,
    curveExcluded,
    curveSharePct: curveExcluded ? shares[0] : 0,
    observedAccounts,
    topUserPct,
    top5UsersPct,
    top10UsersPct,
    meaningfulWallets,
    observedSupply
  };
}

export function holderProfileFromParsedProgramAccounts(rows = []) {
  const accounts = [];
  for (const row of Array.isArray(rows) ? rows : []) {
    const info = row?.account?.data?.parsed?.info ?? {};
    const owner = String(info?.owner ?? '').trim();
    const amount = info?.tokenAmount?.amount ?? info?.token_amount?.amount ?? 0;
    if (!owner || !(Number(amount) > 0)) continue;
    accounts.push({ owner, amount });
  }
  if (!accounts.length) return null;
  return holderProfileFromTokenAccounts(accounts, {
    complete: true,
    provider: 'solana-getProgramAccounts'
  });
}

export async function fetchHeliusHolderProfile(apiKey, mint) {
  const key = String(mint ?? '').trim();
  if (!apiKey || !key) return null;

  const now = Date.now();
  const cached = cache.get(key);
  if (cached && cached.expiresAt > now) return cached.value;

  const result = await sharedHeliusRpc(apiKey, 'getTokenAccounts', {
    page: 1,
    limit: LIMIT,
    displayOptions: {},
    mint: key
  }, {
    timeoutMs: TIMEOUT_MS,
    minIntervalMs: 700,
    cooldown429Ms: COOLDOWN_MS,
    maxCooldownMs: 120_000
  });

  const accounts = result?.token_accounts ?? result?.tokenAccounts ?? [];
  if (!Array.isArray(accounts) || !accounts.length) return null;

  // A full page can mean there are more accounts. In that case the profile is
  // useful telemetry but is never allowed to pass the safety gate.
  const complete = accounts.length < LIMIT;
  const profile = holderProfileFromTokenAccounts(accounts, { complete });
  if (profile) cache.set(key, { value: profile, expiresAt: Date.now() + CACHE_MS });
  return profile;
}
