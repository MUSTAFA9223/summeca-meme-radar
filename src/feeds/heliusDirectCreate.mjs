import { sharedHeliusRpc, sharedSolanaPublicRpc } from '../infra/solanaRpcManager.mjs';

const PUMP_FUN_PROGRAM_ID = '6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P';
const SOLANA_ADDRESS = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
const HELIUS_BACKOFF_MS = 180_000;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, Math.max(0, ms)));
let lastFallbackWarningAt = 0;

const pubkey = (value) => {
  if (typeof value === 'string') return value;
  if (value && typeof value.pubkey === 'string') return value.pubkey;
  return '';
};

export function extractPumpCreateMint(transaction, programId = PUMP_FUN_PROGRAM_ID) {
  const message = transaction?.transaction?.message ?? transaction?.message ?? {};
  const keys = Array.isArray(message.accountKeys) ? message.accountKeys.map(pubkey) : [];
  const instructions = Array.isArray(message.instructions) ? message.instructions : [];

  for (const ix of instructions) {
    const ixProgram = pubkey(ix?.programId)
      || (Number.isInteger(ix?.programIdIndex) ? keys[ix.programIdIndex] : '');
    if (ixProgram !== programId) continue;

    const accounts = Array.isArray(ix?.accounts)
      ? ix.accounts.map((account) => Number.isInteger(account) ? keys[account] : pubkey(account))
      : [];
    const mint = String(accounts[0] ?? '');
    if (SOLANA_ADDRESS.test(mint) && mint !== programId) return mint;
  }

  const post = Array.isArray(transaction?.meta?.postTokenBalances) ? transaction.meta.postTokenBalances : [];
  const preMints = new Set((Array.isArray(transaction?.meta?.preTokenBalances) ? transaction.meta.preTokenBalances : [])
    .map((row) => String(row?.mint ?? ''))
    .filter((mint) => SOLANA_ADDRESS.test(mint)));
  const newMint = post
    .map((row) => String(row?.mint ?? ''))
    .find((mint) => SOLANA_ADDRESS.test(mint) && !preMints.has(mint));
  return newMint ?? null;
}

const isTransientRpcError = (error) =>
  /HTTP 429|HTTP 5\d\d|fetch failed|aborted|timeout|cooling down/i.test(String(error?.message ?? error));

async function publicReadRpc(method, params, timeoutMs = 6000) {
  return sharedSolanaPublicRpc(method, params, {
    purpose: 'critical',
    timeoutMs,
    minIntervalMs: 350,
    maxAttempts: 3
  });
}

async function rpc(apiKey, method, params, timeoutMs = 6000) {
  if (!apiKey) return publicReadRpc(method, params, timeoutMs);

  try {
    return await sharedHeliusRpc(apiKey, method, params, {
      timeoutMs,
      minIntervalMs: 350,
      cooldown429Ms: HELIUS_BACKOFF_MS,
      maxCooldownMs: HELIUS_BACKOFF_MS
    });
  } catch (error) {
    if (!isTransientRpcError(error)) throw error;
    const message = String(error?.message ?? error);
    const now = Date.now();
    if (now - lastFallbackWarningAt > 10_000) {
      lastFallbackWarningAt = now;
      console.warn(`[direct-create:rpc-fallback] ${message}; using shared throttled public RPC pool`);
    }
    return publicReadRpc(method, params, timeoutMs);
  }
}

export async function resolvePumpCreateMint(apiKey, signature, {
  retries = 3,
  retryDelayMs = 350,
  programId = PUMP_FUN_PROGRAM_ID
} = {}) {
  const sig = String(signature ?? '').trim();
  if (!sig) return null;

  let lastError = null;
  for (let attempt = 0; attempt < retries; attempt += 1) {
    try {
      const transaction = await rpc(apiKey, 'getTransaction', [sig, {
        encoding: 'jsonParsed',
        commitment: 'confirmed',
        // Fresh Pump.fun creates can be versioned. Accept v0 and v1 so fallback
        // providers do not reject otherwise valid transactions.
        maxSupportedTransactionVersion: 1
      }]);
      if (transaction) {
        const mint = extractPumpCreateMint(transaction, programId);
        if (mint) return mint;
      }
    } catch (error) {
      lastError = error;
    }
    if (attempt < retries - 1) await sleep(retryDelayMs * (attempt + 1));
  }

  if (lastError) throw lastError;
  return null;
}

export { PUMP_FUN_PROGRAM_ID };
