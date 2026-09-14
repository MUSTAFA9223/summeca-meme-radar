export const TOKEN_PROGRAM_ID = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';
export const TOKEN_2022_PROGRAM_ID = 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb';

const PUBLICNODE_SOLANA_RPC = 'https://solana-rpc.publicnode.com';
const PUBLIC_SOLANA_RPC = 'https://api.mainnet-beta.solana.com';
const SAFE_MINT_CACHE_MS = 10 * 60 * 1000;
const UNSAFE_MINT_CACHE_MS = 20 * 1000;
const PUBLIC_SECURITY_MIN_INTERVAL_MS = 300;
const HELIUS_SECURITY_BACKOFF_MS = 60_000;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const extensionKey = (value) => String(value ?? '').replace(/[^a-z0-9]/gi, '').toLowerCase();

const extensionName = (extension) => {
  if (typeof extension === 'string') return extension;
  return extension?.extension ?? extension?.type ?? extension?.name ?? '';
};

const dangerousToken2022Extension = (name) => {
  const key = extensionKey(name);
  return [
    'transferfeeconfig',
    'nontransferable',
    'permanentdelegate',
    'transferhook',
    'defaultaccountstate',
    'pausable',
    'confidentialtransfermint',
    'confidentialtransferfeeconfig'
  ].includes(key);
};

export function parseMintSecurityAccount(result) {
  const account = result?.value ?? result ?? null;
  if (!account) throw new Error('mint account not found');
  const owner = String(account.owner ?? '');
  if (![TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID].includes(owner)) {
    throw new Error(`mint account is not owned by a supported token program: ${owner || 'unknown'}`);
  }

  const parsed = account?.data?.parsed;
  if (!parsed || String(parsed.type ?? '').toLowerCase() !== 'mint') {
    throw new Error('mint account did not parse as a token mint');
  }
  const info = parsed.info ?? {};
  if (!Object.prototype.hasOwnProperty.call(info, 'mintAuthority')) throw new Error('mint authority missing from parsed mint');
  if (!Object.prototype.hasOwnProperty.call(info, 'freezeAuthority')) throw new Error('freeze authority missing from parsed mint');

  const isToken2022 = owner === TOKEN_2022_PROGRAM_ID || String(parsed.program ?? '').toLowerCase().includes('2022');
  const rawExtensions = Array.isArray(info.extensions)
    ? info.extensions
    : Array.isArray(parsed.extensions)
      ? parsed.extensions
      : null;
  const extensionNames = Array.isArray(rawExtensions)
    ? rawExtensions.map(extensionName).filter(Boolean)
    : [];
  const unsafeExtensions = extensionNames.filter(dangerousToken2022Extension);
  const extensionsVerified = !isToken2022 || Array.isArray(rawExtensions);

  return {
    mintAuthorityDisabled: info.mintAuthority === null,
    freezeAuthorityDisabled: info.freezeAuthority === null,
    isToken2022,
    token2022ExtensionsVerified: extensionsVerified,
    token2022Extensions: extensionNames,
    token2022UnsafeExtensions: unsafeExtensions,
    nonTransferable: isToken2022 ? extensionNames.some((name) => extensionKey(name) === 'nontransferable') : false,
    transferFeeEnable: isToken2022 ? extensionNames.some((name) => extensionKey(name) === 'transferfeeconfig') : false,
    onchainSecurityVerified: info.mintAuthority === null
      && info.freezeAuthority === null
      && extensionsVerified
      && unsafeExtensions.length === 0,
    securitySource: 'solana-rpc'
  };
}

export class SolanaRpcClient {
  constructor({ heliusApiKey }) {
    this.apiKey = String(heliusApiKey ?? '').trim();
    this.endpoint = this.apiKey
      ? `https://mainnet.helius-rpc.com/?api-key=${encodeURIComponent(this.apiKey)}`
      : PUBLIC_SOLANA_RPC;
    this.mintSecurityCache = new Map();
    this.publicSecurityTail = Promise.resolve();
    this.publicSecurityNextAt = 0;
    this.heliusSecurityRateLimitedUntil = 0;
  }

  async #rpcAt(endpoint, method, params = []) {
    const response = await fetch(endpoint, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params })
    });
    const payload = await response.json().catch(() => null);
    if (!response.ok) throw new Error(`Solana RPC ${method} HTTP ${response.status}`);
    if (payload?.error) throw new Error(`Solana RPC ${method}: ${payload.error.message ?? JSON.stringify(payload.error)}`);
    return payload?.result;
  }

  async rpc(method, params = []) {
    return this.#rpcAt(this.endpoint, method, params);
  }

  #queuedPublicSecurity(endpoint, method, params) {
    const task = this.publicSecurityTail.then(async () => {
      const waitMs = Math.max(0, this.publicSecurityNextAt - Date.now());
      if (waitMs) await sleep(waitMs);
      this.publicSecurityNextAt = Date.now() + PUBLIC_SECURITY_MIN_INTERVAL_MS;
      return this.#rpcAt(endpoint, method, params);
    });
    this.publicSecurityTail = task.catch(() => undefined);
    return task;
  }

  async #readOnlySecurityRpc(method, params) {
    try {
      return await this.#queuedPublicSecurity(PUBLICNODE_SOLANA_RPC, method, params);
    } catch (error) {
      const transient = /HTTP 429|HTTP 5\d\d|fetch failed|timeout/i.test(String(error?.message ?? error));
      if (!transient) throw error;
      return this.#queuedPublicSecurity(PUBLIC_SOLANA_RPC, method, params);
    }
  }

  async getMintSecurity(mint) {
    const key = String(mint ?? '').trim();
    const cached = this.mintSecurityCache.get(key);
    if (cached && cached.expiresAt > Date.now()) return cached.value;

    const params = [key, { encoding: 'jsonParsed', commitment: 'confirmed' }];
    let result;

    if (this.apiKey && Date.now() >= this.heliusSecurityRateLimitedUntil) {
      try {
        result = await this.rpc('getAccountInfo', params);
      } catch (error) {
        const message = String(error?.message ?? error);
        const isHeliusRateLimit = /getAccountInfo HTTP 429/i.test(message);
        if (!isHeliusRateLimit) throw error;
        this.heliusSecurityRateLimitedUntil = Date.now() + HELIUS_SECURITY_BACKOFF_MS;
        console.warn(`[solana:rpc-fallback] Helius rate limited mint=${key.slice(0, 8)}…; using throttled read-only RPC fallback`);
      }
    }

    if (!result) result = await this.#readOnlySecurityRpc('getAccountInfo', params);

    const parsed = parseMintSecurityAccount(result);
    const ttlMs = parsed.onchainSecurityVerified ? SAFE_MINT_CACHE_MS : UNSAFE_MINT_CACHE_MS;
    this.mintSecurityCache.set(key, { value: parsed, expiresAt: Date.now() + ttlMs });
    return parsed;
  }

  async getSolBalanceLamports(address) {
    const result = await this.rpc('getBalance', [address, { commitment: 'confirmed' }]);
    return BigInt(result?.value ?? 0);
  }

  async getTokenBalanceAtomic(owner, mint) {
    const result = await this.rpc('getTokenAccountsByOwner', [
      owner,
      { mint },
      { encoding: 'jsonParsed', commitment: 'confirmed' }
    ]);
    let total = 0n;
    for (const item of result?.value ?? []) {
      const amount = item?.account?.data?.parsed?.info?.tokenAmount?.amount;
      if (/^\d+$/.test(String(amount ?? ''))) total += BigInt(amount);
    }
    return total;
  }

  async sendSignedTransaction(signedBase64) {
    const signature = await this.rpc('sendTransaction', [signedBase64, {
      encoding: 'base64',
      skipPreflight: false,
      preflightCommitment: 'confirmed',
      maxRetries: 3
    }]);
    if (!signature) throw new Error('Solana RPC returned no transaction signature');
    return String(signature);
  }

  async waitForSignature(signature, { timeoutMs = 45_000, pollMs = 1200 } = {}) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const result = await this.rpc('getSignatureStatuses', [[signature], { searchTransactionHistory: true }]);
      const status = result?.value?.[0];
      if (status?.err) throw new Error(`Transaction failed: ${JSON.stringify(status.err)}`);
      if (status?.confirmationStatus === 'confirmed' || status?.confirmationStatus === 'finalized') return status;
      await new Promise((resolve) => setTimeout(resolve, pollMs));
    }
    throw new Error(`Transaction confirmation timed out: ${signature}`);
  }
}
