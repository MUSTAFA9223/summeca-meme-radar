const PUMP_FUN_PROGRAM_ID = '6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P';
const SOLANA_ADDRESS = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
const PUBLIC_SOLANA_RPC = 'https://api.mainnet-beta.solana.com';
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

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

async function rpc(apiKey, method, params, timeoutMs = 6000) {
  if (!apiKey) return rpcAt(PUBLIC_SOLANA_RPC, method, params, timeoutMs, 'Public Solana RPC');
  const helius = `https://mainnet.helius-rpc.com/?api-key=${encodeURIComponent(apiKey)}`;
  try {
    return await rpcAt(helius, method, params, timeoutMs, 'Helius');
  } catch (error) {
    const message = String(error?.message ?? error);
    const transient = /HTTP 429|HTTP 5\d\d|fetch failed|aborted|timeout/i.test(message);
    if (!transient) throw error;
    console.warn(`[direct-create:rpc-fallback] ${message}; using public Solana RPC`);
    return rpcAt(PUBLIC_SOLANA_RPC, method, params, timeoutMs, 'Public Solana RPC');
  }
}

export async function resolvePumpCreateMint(apiKey, signature, {
  retries = 7,
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
        maxSupportedTransactionVersion: 0
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
