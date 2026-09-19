const finite = (value, fallback = 0) => Number.isFinite(Number(value)) ? Number(value) : fallback;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, Math.max(0, ms)));

const TRACKER_RPC = 'https://rpc.solanatracker.io/public';
const PUBLICNODE_RPC = 'https://solana-rpc.publicnode.com';
const MAINNET_RPC = 'https://api.mainnet-beta.solana.com';

const numEnv = (name, fallback, min, max) =>
  Math.max(min, Math.min(max, finite(process.env[name], fallback)));

export function solanaRpcCooldownMs(status, {
  retryAfterSec = 0,
  attempt = 0,
  base429Ms = 30_000,
  authCooldownMs = 300_000,
  maxCooldownMs = 120_000
} = {}) {
  const code = Math.floor(finite(status));
  if (code === 401 || code === 403) return Math.max(30_000, finite(authCooldownMs, 300_000));
  if (code !== 429) return 0;
  const retryMs = Math.max(0, finite(retryAfterSec)) * 1_000;
  const base = Math.max(5_000, finite(base429Ms, 30_000));
  const cap = Math.max(base, finite(maxCooldownMs, 120_000));
  if (retryMs > 0) return Math.min(cap, Math.max(5_000, retryMs));
  return Math.min(cap, base * (Math.max(0, Math.floor(finite(attempt))) + 1));
}

export function solanaPublicRpcEndpoints(customUrl = process.env.SOLANA_PROFILE_RPC_URL || '') {
  const candidates = [
    { key: 'custom', url: String(customUrl || '').trim(), provider: 'Custom Solana RPC' },
    { key: 'tracker', url: TRACKER_RPC, provider: 'Solana Tracker Public RPC' },
    { key: 'publicnode', url: PUBLICNODE_RPC, provider: 'PublicNode Solana RPC' },
    { key: 'mainnet', url: MAINNET_RPC, provider: 'Public Solana RPC' }
  ];
  const seen = new Set();
  return candidates.filter((row) => {
    if (!row.url || seen.has(row.url)) return false;
    seen.add(row.url);
    return true;
  });
}

export class SharedSolanaRpcManager {
  constructor({
    fetchImpl = globalThis.fetch,
    nowFn = () => Date.now(),
    sleepImpl = sleep
  } = {}) {
    this.fetchImpl = fetchImpl;
    this.nowFn = nowFn;
    this.sleepImpl = sleepImpl;
    this.lanes = new Map();
    this.publicCursor = 0;
    this.id = 0;
  }

  lane(key) {
    if (!this.lanes.has(key)) {
      this.lanes.set(key, {
        tail: Promise.resolve(),
        nextAt: 0,
        endpointCooldownUntil: 0,
        methodCooldownUntil: new Map()
      });
    }
    return this.lanes.get(key);
  }

  async callEndpoint({
    key,
    url,
    provider = 'Solana RPC',
    method,
    params = [],
    timeoutMs = 6_000,
    minIntervalMs = 650,
    attempt = 0,
    cooldown429Ms = numEnv('SOLANA_RPC_429_COOLDOWN_MS', 30_000, 5_000, 180_000),
    authCooldownMs = numEnv('SOLANA_RPC_AUTH_COOLDOWN_MS', 300_000, 30_000, 900_000),
    maxCooldownMs = 180_000
  }) {
    const lane = this.lane(String(key || provider));
    const methodKey = String(method || '');
    const task = lane.tail.then(async () => {
      const now = this.nowFn();
      const blockedUntil = Math.max(
        finite(lane.endpointCooldownUntil),
        finite(lane.methodCooldownUntil.get(methodKey))
      );
      if (blockedUntil > now) {
        const error = new Error(`${provider} ${methodKey} provider cooling down`);
        error.code = 'SOLANA_RPC_COOLDOWN';
        throw error;
      }

      const waitMs = Math.max(0, finite(lane.nextAt) - now);
      if (waitMs) await this.sleepImpl(waitMs);
      lane.nextAt = this.nowFn() + Math.max(0, finite(minIntervalMs, 650));

      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), Math.max(1_000, finite(timeoutMs, 6_000)));
      let response;
      try {
        response = await this.fetchImpl(url, {
          method: 'POST',
          signal: controller.signal,
          headers: { 'content-type': 'application/json', accept: 'application/json' },
          body: JSON.stringify({ jsonrpc: '2.0', id: ++this.id, method: methodKey, params })
        });
      } catch (error) {
        const message = error?.name === 'AbortError' ? 'timeout' : String(error?.message ?? error);
        throw new Error(`${provider} ${methodKey} ${message}`);
      } finally {
        clearTimeout(timer);
      }

      if ([401, 403, 429].includes(response.status)) {
        const cooldownMs = solanaRpcCooldownMs(response.status, {
          retryAfterSec: finite(response.headers.get('retry-after'), 0),
          attempt,
          base429Ms: cooldown429Ms,
          authCooldownMs,
          maxCooldownMs
        });
        if (response.status === 429) lane.endpointCooldownUntil = this.nowFn() + cooldownMs;
        else lane.methodCooldownUntil.set(methodKey, this.nowFn() + cooldownMs);
        const error = new Error(`${provider} ${methodKey} HTTP ${response.status}`);
        error.status = response.status;
        throw error;
      }

      if (response.status >= 500) {
        lane.endpointCooldownUntil = this.nowFn() + 5_000;
      }
      if (!response.ok) throw new Error(`${provider} ${methodKey} HTTP ${response.status}`);

      const body = await response.json();
      if (body?.error) {
        const code = finite(body.error.code);
        const message = String(body.error.message || 'RPC error');
        if (code === -32005 || /rate limit|too many requests/i.test(message)) {
          lane.endpointCooldownUntil = this.nowFn() + solanaRpcCooldownMs(429, {
            attempt,
            base429Ms: cooldown429Ms,
            maxCooldownMs
          });
        }
        throw new Error(`${provider} ${methodKey} ${body.error.code}: ${message}`);
      }

      lane.methodCooldownUntil.delete(methodKey);
      if (lane.endpointCooldownUntil <= this.nowFn()) lane.endpointCooldownUntil = 0;
      return body?.result ?? null;
    });

    lane.tail = task.catch(() => undefined);
    return task;
  }

  async callPublic(method, params = [], {
    purpose = 'normal',
    timeoutMs = 6_000,
    minIntervalMs = null,
    maxAttempts = null
  } = {}) {
    const endpoints = solanaPublicRpcEndpoints();
    if (!endpoints.length) throw new Error(`Solana public RPC ${method} has no endpoints`);

    const interval = minIntervalMs ?? (
      purpose === 'critical'
        ? numEnv('SOLANA_RPC_CRITICAL_MIN_INTERVAL_MS', 350, 100, 5_000)
        : purpose === 'background'
          ? numEnv('SOLANA_RPC_BACKGROUND_MIN_INTERVAL_MS', 900, 250, 10_000)
          : numEnv('SOLANA_RPC_PUBLIC_MIN_INTERVAL_MS', 700, 250, 10_000)
    );

    const start = this.publicCursor++ % endpoints.length;
    const limit = Math.max(1, Math.min(
      endpoints.length,
      maxAttempts == null ? endpoints.length : Math.floor(finite(maxAttempts, endpoints.length))
    ));
    let lastError = null;

    for (let attempt = 0; attempt < limit; attempt += 1) {
      const endpoint = endpoints[(start + attempt) % endpoints.length];
      try {
        return await this.callEndpoint({
          key: `public:${endpoint.key}`,
          url: endpoint.url,
          provider: endpoint.provider,
          method,
          params,
          timeoutMs,
          minIntervalMs: interval,
          attempt
        });
      } catch (error) {
        lastError = error;
      }
    }

    throw lastError || new Error(`Solana public RPC ${method} failed`);
  }

  async callHelius(apiKey, method, params = [], {
    timeoutMs = 6_000,
    minIntervalMs = 650,
    cooldown429Ms = numEnv('HELIUS_HOLDER_COOLDOWN_MS', 30_000, 5_000, 180_000),
    maxCooldownMs = 180_000
  } = {}) {
    const key = String(apiKey || '').trim();
    if (!key) throw new Error(`Helius ${method} missing API key`);
    return this.callEndpoint({
      key: 'helius-mainnet',
      url: `https://mainnet.helius-rpc.com/?api-key=${encodeURIComponent(key)}`,
      provider: 'Helius',
      method,
      params,
      timeoutMs,
      minIntervalMs,
      cooldown429Ms,
      maxCooldownMs
    });
  }
}

export const sharedSolanaRpcManager = new SharedSolanaRpcManager();

export const sharedSolanaPublicRpc = (method, params = [], options = {}) =>
  sharedSolanaRpcManager.callPublic(method, params, options);

export const sharedHeliusRpc = (apiKey, method, params = [], options = {}) =>
  sharedSolanaRpcManager.callHelius(apiKey, method, params, options);
