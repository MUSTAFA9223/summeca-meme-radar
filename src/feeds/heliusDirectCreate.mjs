const PUMP_FUN_PROGRAM_ID = '6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P';
const SOLANA_ADDRESS = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
const SOLANA_TRACKER_PUBLIC_RPC = 'https://rpc.solanatracker.io/public';
const PUBLICNODE_SOLANA_RPC = 'https://solana-rpc.publicnode.com';
const PUBLIC_SOLANA_RPC = 'https://api.mainnet-beta.solana.com';
const HELIUS_BACKOFF_MS = 180_000;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const publicRpcLanes = [
  {
    endpoint: SOLANA_TRACKER_PUBLIC_RPC,
    provider: 'Solana Tracker Public RPC',
    minIntervalMs: 300,
    tail: Promise.resolve(),
    nextAt: 0
  },
  {
    endpoint: PUBLICNODE_SOLANA_RPC,
    provider: 'PublicNode Solana RPC',
    minIntervalMs: 300,
    tail: Promise.resolve(),
    nextAt: 0
  },
  {
    endpoint: PUBLIC_SOLANA_RPC,
    provider: 'Public Solana RPC',
    minIntervalMs: 350,
    tail: Promise.resolve(),
    nextAt: 0
  }
];
let publicRpcCursor = 0;
let heliusRateLimitedUntil = 0;
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

async function rpcAt(endpoint, method, params, timeoutMs = 6000, provider = 'Solana RPC') {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(endpoint, {
      method: 'POST',
      signal: controller.signal,
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 'summeca-direct-create', method, params })
    });
    if (!response.ok) throw new Error(`${provider} ${method} HTTP ${response.status}`);
    const body = await response.json();
    if (body?.error) throw new Error(`${provider} ${method} ${body.error.code}: ${body.error.message}`);
    return body?.result ?? null;
  } finally {
    clearTimeout(timer);
  }
}

function queuedLaneRpc(lane, method, params, timeoutMs) {
  const task = lane.tail.then(async () => {
    const waitMs = Math.max(0, lane.nextAt - Date.now());
    if (waitMs) await sleep(waitMs);
    lane.nextAt = Date.now() + lane.minIntervalMs;
    return rpcAt(lane.endpoint, method, params, timeoutMs, lane.provider);
  });
  lane.tail = task.catch(() => undefined);
  return task;
}

const isTransientRpcError = (error) => /HTTP 429|HTTP 5\d\d|fetch failed|aborted|timeout/i.test(String(error?.message ?? error));

async function publicReadRpc(method, params, timeoutMs = 6000) {
  const start = publicRpcCursor++ % publicRpcLanes.length;
  const primary = publicRpcLanes[start];
  const fallback = publicRpcLanes[(start + 1) % publicRpcLanes.length];

  try {
    return await queuedLaneRpc(primary, method, params, timeoutMs);
  } catch (error) {
    if (!isTransientRpcError(error)) throw error;
    return queuedLaneRpc(fallback, method, params, timeoutMs);
  }
}

async function rpc(apiKey, method, params, timeoutMs = 6000) {
  if (!apiKey || Date.now() < heliusRateLimitedUntil) {
    return publicReadRpc(method, params, timeoutMs);
  }

  const helius = `https://mainnet.helius-rpc.com/?api-key=${encodeURIComponent(apiKey)}`;
  try {
    return await rpcAt(helius, method, params, timeoutMs, 'Helius');
  } catch (error) {
    if (!isTransientRpcError(error)) throw error;
    const message = String(error?.message ?? error);
    if (/HTTP 429/i.test(message)) heliusRateLimitedUntil = Date.now() + HELIUS_BACKOFF_MS;
    const now = Date.now();
    if (now - lastFallbackWarningAt > 10_000) {
      lastFallbackWarningAt = now;
      console.warn(`[direct-create:rpc-fallback] ${message}; using dual throttled read-only RPC lanes`);
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
