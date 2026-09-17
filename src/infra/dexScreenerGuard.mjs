const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, Math.max(0, ms)));
const finite = (value, fallback = 0) => Number.isFinite(Number(value)) ? Number(value) : fallback;

let installed = false;

export function installDexScreenerGuard() {
  if (installed) return;
  installed = true;

  const previousFetch = globalThis.fetch.bind(globalThis);
  const minGapMs = Math.max(750, Math.min(5_000, finite(process.env.DEXSCREENER_MIN_GAP_MS, 1_100)));
  const baseBackoffMs = Math.max(1_500, Math.min(15_000, finite(process.env.DEXSCREENER_429_BACKOFF_MS, 3_000)));
  const maxBackoffMs = Math.max(baseBackoffMs, Math.min(60_000, finite(process.env.DEXSCREENER_429_MAX_BACKOFF_MS, 30_000)));
  const maxRetries = Math.max(1, Math.min(8, Math.floor(finite(process.env.DEXSCREENER_429_RETRIES, 5))));

  let tail = Promise.resolve();
  let nextAt = 0;

  globalThis.fetch = async (input, init = {}) => {
    const url = typeof input === 'string' || input instanceof URL ? String(input) : String(input?.url ?? '');
    if (!/^https:\/\/api\.dexscreener\.com\//i.test(url)) return previousFetch(input, init);

    const task = tail.then(async () => {
      let lastResponse = null;
      for (let attempt = 0; attempt <= maxRetries; attempt += 1) {
        const waitMs = Math.max(0, nextAt - Date.now());
        if (waitMs) await sleep(waitMs);
        nextAt = Date.now() + minGapMs;

        const response = await previousFetch(input, init);
        if (response.status !== 429) return response;
        lastResponse = response;
        try { await response.body?.cancel(); } catch {}

        if (attempt >= maxRetries) break;
        const retryAfterHeader = Number(response.headers?.get?.('retry-after') ?? 0);
        const retryAfterMs = Number.isFinite(retryAfterHeader) && retryAfterHeader > 0 ? retryAfterHeader * 1_000 : 0;
        const exponential = Math.min(maxBackoffMs, baseBackoffMs * (2 ** attempt));
        const jitter = Math.floor(Math.random() * Math.min(750, Math.max(100, exponential * 0.15)));
        const delay = Math.max(retryAfterMs, exponential + jitter);
        console.warn(`[dexscreener:429] retry=${attempt + 1}/${maxRetries} delay=${delay}ms`);
        await sleep(delay);
      }
      return lastResponse || previousFetch(input, init);
    });

    tail = task.catch(() => undefined);
    return task;
  };

  console.log(`DEXSCREENER GUARD: minGap=${minGapMs}ms backoff=${baseBackoffMs}-${maxBackoffMs}ms retries=${maxRetries}`);
}
