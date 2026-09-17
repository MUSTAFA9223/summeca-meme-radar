const nativeFetch = globalThis.fetch.bind(globalThis);

const finite = (value, fallback) => Number.isFinite(Number(value)) ? Number(value) : fallback;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, Math.max(0, ms)));
const normalizeUrl = (value) => String(value ?? '').trim().replace(/\/$/, '');

const config = {
  rpcUrl: normalizeUrl(process.env.TRENCHES_RPC_URL || 'https://rpc.mainnet.arc.io'),
  minGapMs: Math.max(100, finite(process.env.ARC_RPC_MIN_GAP_MS, 550)),
  baseBackoffMs: Math.max(1_000, finite(process.env.ARC_RPC_429_BASE_MS, 5_000)),
  maxBackoffMs: Math.max(5_000, finite(process.env.ARC_RPC_429_MAX_MS, 60_000)),
  maxRetries: Math.max(1, Math.floor(finite(process.env.ARC_RPC_MAX_RETRIES, 6))),
  cacheMs: Math.max(0, finite(process.env.ARC_RPC_CACHE_MS, 1_200))
};

let installed = false;
let queueTail = Promise.resolve();
let nextAllowedAt = 0;
let blockedUntil = 0;
const inflight = new Map();
const cache = new Map();

function requestUrl(input) {
  if (typeof input === 'string' || input instanceof URL) return normalizeUrl(input);
  return normalizeUrl(input?.url);
}

function parseRpcBody(init) {
  const raw = typeof init?.body === 'string' ? init.body : '';
  if (!raw) return { raw: '', method: 'unknown' };
  try {
    const parsed = JSON.parse(raw);
    return { raw, method: String(parsed?.method ?? 'unknown') };
  } catch {
    return { raw, method: 'unknown' };
  }
}

function cacheable(method) {
  return method === 'eth_getLogs' || method === 'eth_blockNumber' || method === 'eth_getTransactionByHash' || method === 'eth_getTransactionReceipt';
}

function cloneResponse(snapshot) {
  return new Response(snapshot.text, {
    status: snapshot.status,
    statusText: snapshot.statusText,
    headers: snapshot.headers
  });
}

async function snapshotResponse(response) {
  return {
    status: response.status,
    statusText: response.statusText,
    headers: [...response.headers.entries()],
    text: await response.text()
  };
}

function retryAfterMs(response) {
  const value = response.headers.get('retry-after');
  if (!value) return 0;
  const seconds = Number(value);
  if (Number.isFinite(seconds)) return Math.max(0, seconds * 1_000);
  const at = Date.parse(value);
  return Number.isFinite(at) ? Math.max(0, at - Date.now()) : 0;
}

async function serialize(task) {
  const previous = queueTail;
  let release;
  queueTail = new Promise((resolve) => { release = resolve; });
  await previous;
  try {
    return await task();
  } finally {
    release();
  }
}

async function guardedRpcFetch(input, init, method) {
  return serialize(async () => {
    for (let attempt = 0; attempt <= config.maxRetries; attempt += 1) {
      const now = Date.now();
      const waitMs = Math.max(0, nextAllowedAt - now, blockedUntil - now);
      if (waitMs > 0) await sleep(waitMs);

      nextAllowedAt = Date.now() + config.minGapMs;
      const response = await nativeFetch(input, init);

      if (response.status !== 429) {
        if (response.status >= 500 && response.status <= 504 && attempt < 2) {
          const delay = 1_000 * (attempt + 1);
          blockedUntil = Math.max(blockedUntil, Date.now() + delay);
          console.warn(`[arc-rpc:retry] method=${method} status=${response.status} delay=${delay}ms`);
          continue;
        }
        return response;
      }

      if (attempt >= config.maxRetries) return response;

      const serverDelay = retryAfterMs(response);
      const exponential = Math.min(config.maxBackoffMs, config.baseBackoffMs * (2 ** attempt));
      const jitter = Math.floor(Math.random() * 500);
      const delay = Math.min(config.maxBackoffMs, Math.max(serverDelay, exponential) + jitter);
      blockedUntil = Math.max(blockedUntil, Date.now() + delay);
      console.warn(`[arc-rpc:429] method=${method} retry=${attempt + 1}/${config.maxRetries} delay=${delay}ms`);
    }

    return nativeFetch(input, init);
  });
}

export function installArcRpcGuard() {
  if (installed) return config;
  installed = true;

  globalThis.fetch = async (input, init = {}) => {
    const url = requestUrl(input);
    if (url !== config.rpcUrl || String(init?.method ?? 'GET').toUpperCase() !== 'POST') {
      return nativeFetch(input, init);
    }

    const { raw, method } = parseRpcBody(init);
    const key = `${url}:${raw}`;
    const now = Date.now();
    const cached = cache.get(key);
    if (cached && cached.expiresAt > now) return cloneResponse(cached.snapshot);
    if (cached) cache.delete(key);

    if (inflight.has(key)) {
      const snapshot = await inflight.get(key);
      return cloneResponse(snapshot);
    }

    const work = (async () => {
      const response = await guardedRpcFetch(input, init, method);
      const snapshot = await snapshotResponse(response);
      if (snapshot.status >= 200 && snapshot.status < 300 && cacheable(method) && config.cacheMs > 0) {
        cache.set(key, { snapshot, expiresAt: Date.now() + config.cacheMs });
      }
      if (cache.size > 500) {
        const cutoff = Date.now();
        for (const [cacheKey, item] of cache) if (item.expiresAt <= cutoff) cache.delete(cacheKey);
      }
      return snapshot;
    })();

    inflight.set(key, work);
    try {
      return cloneResponse(await work);
    } finally {
      inflight.delete(key);
    }
  };

  console.log(`ARC RPC GUARD: minGap=${config.minGapMs}ms backoff=${config.baseBackoffMs}-${config.maxBackoffMs}ms retries=${config.maxRetries} cache=${config.cacheMs}ms`);
  return config;
}
