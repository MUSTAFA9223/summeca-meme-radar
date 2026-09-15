import { enqueueDirectCreate } from './directCreateQueue.mjs';
import { fetchHeliusAssetMetadata } from './heliusAsset.mjs';
import { PUMP_FUN_PROGRAM_ID, resolvePumpCreateMint } from './heliusDirectCreate.mjs';

export { PUMP_FUN_PROGRAM_ID };

const PUBLIC_SOLANA_WS = 'wss://api.mainnet-beta.solana.com';
export const DEFAULT_CREATE_HYDRATION_CONCURRENCY = 4;
export const DEFAULT_CREATE_HYDRATION_BACKLOG = 96;

const boundedInt = (value, fallback, min, max) => {
  const n = Number(value);
  return Number.isFinite(n) ? Math.max(min, Math.min(max, Math.floor(n))) : fallback;
};

export class BoundedTaskPool {
  constructor({ concurrency = 4, maxQueued = 96, onDrop = () => {} } = {}) {
    this.concurrency = boundedInt(concurrency, 4, 1, 16);
    this.maxQueued = boundedInt(maxQueued, 96, this.concurrency, 512);
    this.onDrop = onDrop;
    this.active = 0;
    this.queue = [];
    this.dropped = 0;
  }

  get queued() { return this.queue.length; }
  get pending() { return this.active + this.queue.length; }

  submit(task, meta = null) {
    if (typeof task !== 'function') throw new TypeError('task must be a function');

    if (this.queue.length >= this.maxQueued) {
      const dropped = this.queue.shift();
      this.dropped += 1;
      try { this.onDrop(dropped?.meta ?? null, this.dropped); } catch {}
    }

    this.queue.push({ task, meta });
    this.#drain();
    return true;
  }

  #drain() {
    while (this.active < this.concurrency && this.queue.length) {
      const job = this.queue.shift();
      this.active += 1;
      Promise.resolve()
        .then(job.task)
        .catch(() => undefined)
        .finally(() => {
          this.active = Math.max(0, this.active - 1);
          this.#drain();
        });
    }
  }
}

export function createHeliusWsUrl(apiKey) {
  if (!apiKey) throw new Error('HELIUS_API_KEY is required for WebSocket streaming');
  return `wss://mainnet.helius-rpc.com/?api-key=${encodeURIComponent(apiKey)}`;
}

export function createPublicSolanaWsUrl() {
  return PUBLIC_SOLANA_WS;
}

export function buildLogsSubscribeRequest(programId, id = 1, commitment = 'processed') {
  if (!programId) throw new Error('programId is required');
  return {
    jsonrpc: '2.0',
    id,
    method: 'logsSubscribe',
    params: [
      { mentions: [programId] },
      { commitment }
    ]
  };
}

export function classifyProgramLogs(logs = []) {
  const text = (Array.isArray(logs) ? logs : []).join('\n').toLowerCase();
  if (text.includes('instruction: create')) return 'create';
  if (text.includes('instruction: migrate')) return 'migrate';
  if (text.includes('instruction: buy')) return 'buy';
  if (text.includes('instruction: sell')) return 'sell';
  return 'activity';
}

export class HeliusProgramStream {
  constructor({
    apiKey,
    programIds = [PUMP_FUN_PROGRAM_ID],
    commitment = 'processed',
    onEvent = () => {},
    logger = console,
    reconnectMinMs = 1000,
    reconnectMaxMs = 30_000,
    staleAfterMs = 75_000,
    hydrationConcurrency = DEFAULT_CREATE_HYDRATION_CONCURRENCY,
    hydrationBacklog = DEFAULT_CREATE_HYDRATION_BACKLOG
  }) {
    this.apiKey = apiKey;
    this.programIds = [...new Set(programIds.filter(Boolean))];
    this.commitment = commitment;
    this.onEvent = onEvent;
    this.logger = logger;
    this.reconnectMinMs = reconnectMinMs;
    this.reconnectMaxMs = reconnectMaxMs;
    this.staleAfterMs = staleAfterMs;
    this.active = false;
    this.ws = null;
    this.reconnectTimer = null;
    this.watchdogTimer = null;
    this.reconnectAttempt = 0;
    this.lastMessageAt = 0;
    this.requestToProgram = new Map();
    this.subscriptionToProgram = new Map();
    this.directSeen = new Set();
    this.usePublicFallback = true;
    this.currentProvider = 'solana-public';
    this.lastBacklogWarningAt = 0;
    this.hydrationPool = new BoundedTaskPool({
      concurrency: hydrationConcurrency,
      maxQueued: hydrationBacklog,
      onDrop: (meta, dropped) => {
        const now = Date.now();
        if (now - this.lastBacklogWarningAt > 10_000) {
          this.lastBacklogWarningAt = now;
          const sig = String(meta?.signature ?? '').slice(0, 10);
          this.logger.warn(`[direct-create] hydration backlog saturated; dropped oldest queued launch${sig ? ` sig=${sig}…` : ''}; dropped=${dropped} queued=${this.hydrationPool?.queued ?? 0}`);
        }
      }
    });
  }

  start() {
    if (this.active) return;
    if (!this.apiKey) throw new Error('HELIUS_API_KEY is required for HeliusProgramStream');
    if (!this.programIds.length) throw new Error('At least one Solana program id is required');
    if (typeof WebSocket === 'undefined') throw new Error('Global WebSocket is unavailable; Node.js 22+ is required');
    this.active = true;
    this.#connect();
  }

  stop() {
    this.active = false;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    if (this.watchdogTimer) clearInterval(this.watchdogTimer);
    this.reconnectTimer = null;
    this.watchdogTimer = null;
    if (this.ws && (this.ws.readyState === WebSocket.OPEN || this.ws.readyState === WebSocket.CONNECTING)) {
      this.ws.close(1000, 'shutdown');
    }
    this.ws = null;
  }

  #rememberSignature(signature) {
    if (!signature || this.directSeen.has(signature)) return false;
    this.directSeen.add(signature);
    if (this.directSeen.size > 4000) {
      const oldest = this.directSeen.values().next().value;
      if (oldest) this.directSeen.delete(oldest);
    }
    return true;
  }

  async #hydrateDirectCreate(eventPayload) {
    if (eventPayload.kind !== 'create' || eventPayload.err || !eventPayload.signature) return eventPayload;

    try {
      const mint = await resolvePumpCreateMint(this.apiKey, eventPayload.signature, {
        programId: eventPayload.programId ?? PUMP_FUN_PROGRAM_ID
      });
      if (!mint) {
        this.logger.warn(`[direct-create] mint not resolved sig=${eventPayload.signature.slice(0, 10)}…`);
        return eventPayload;
      }

      const base = {
        address: mint,
        symbol: 'NEW',
        name: 'New Pump.fun coin',
        source: 'pump_fun_direct',
        observedAt: eventPayload.observedAt,
        listedAt: eventPayload.observedAt,
        priceUsd: 0,
        liquidityUsd: 0,
        directCreate: true,
        createSignature: eventPayload.signature
      };
      enqueueDirectCreate(base);
      eventPayload.mint = mint;
      eventPayload.directCreate = true;
      const lagMs = Math.max(0, Date.now() - Number(eventPayload.observedAt ?? Date.now()));
      this.logger.log(`[direct-create] detected mint=${mint.slice(0, 8)}… slot=${eventPayload.slot} via=${eventPayload.provider} lag=${lagMs}ms`);

      void fetchHeliusAssetMetadata(this.apiKey, mint)
        .then((metadata) => {
          if (metadata && Object.keys(metadata).length) {
            enqueueDirectCreate({ ...base, ...metadata, observedAt: Date.now() });
          }
        })
        .catch((error) => this.logger.warn(`[direct-create:metadata] ${error?.message ?? error}`));
    } catch (error) {
      this.logger.warn(`[direct-create] resolve failed: ${error?.message ?? error}`);
    }
    return eventPayload;
  }

  #queueCreate(eventPayload) {
    if (!eventPayload?.signature || !this.#rememberSignature(eventPayload.signature)) return;

    const submittedAt = Date.now();
    this.hydrationPool.submit(async () => {
      const waitMs = Math.max(0, Date.now() - submittedAt);
      if (waitMs > 3000) {
        this.logger.warn(`[direct-create] hydration wait=${waitMs}ms queued=${this.hydrationPool.queued} active=${this.hydrationPool.active}`);
      }
      try {
        const hydrated = await this.#hydrateDirectCreate(eventPayload);
        await Promise.resolve(this.onEvent(hydrated));
      } catch (error) {
        this.logger.error('[direct-create] queued hydration failed', error?.message ?? error);
      }
    }, { signature: eventPayload.signature, observedAt: eventPayload.observedAt });
  }

  #connect() {
    if (!this.active) return;
    this.requestToProgram.clear();
    this.subscriptionToProgram.clear();

    const usingPublic = this.usePublicFallback;
    const provider = usingPublic ? 'solana-public' : 'helius';
    const wsUrl = usingPublic ? createPublicSolanaWsUrl() : createHeliusWsUrl(this.apiKey);
    const ws = new WebSocket(wsUrl);
    this.ws = ws;
    this.currentProvider = provider;

    ws.addEventListener('open', () => {
      this.reconnectAttempt = 0;
      this.lastMessageAt = Date.now();
      this.logger.log(`[helius-ws] connected provider=${provider}; subscribing to ${this.programIds.length} program(s); hydration concurrency=${this.hydrationPool.concurrency} backlog=${this.hydrationPool.maxQueued}`);

      this.programIds.forEach((programId, index) => {
        const id = 100 + index;
        this.requestToProgram.set(id, programId);
        ws.send(JSON.stringify(buildLogsSubscribeRequest(programId, id, this.commitment)));
      });

      if (this.watchdogTimer) clearInterval(this.watchdogTimer);
      this.watchdogTimer = setInterval(() => {
        if (!this.active || this.ws !== ws) return;
        if (Date.now() - this.lastMessageAt > this.staleAfterMs) {
          this.logger.warn(`[helius-ws] stream stale provider=${provider}; reconnecting`);
          ws.close(4000, 'stale stream');
        }
      }, Math.max(10_000, Math.floor(this.staleAfterMs / 3)));
    });

    ws.addEventListener('message', (event) => {
      this.lastMessageAt = Date.now();
      let message;
      try {
        message = JSON.parse(String(event.data));
      } catch {
        return;
      }

      if (message?.id !== undefined && typeof message?.result === 'number') {
        const programId = this.requestToProgram.get(Number(message.id));
        if (programId) {
          this.subscriptionToProgram.set(message.result, programId);
          this.logger.log(`[helius-ws] subscribed provider=${provider} ${programId.slice(0, 8)}… id=${message.result}`);
        }
        return;
      }

      if (message?.id !== undefined && message?.error) {
        this.logger.warn(`[helius-ws] subscription error provider=${provider}: ${message.error.message ?? 'unknown error'}`);
        try { ws.close(4001, 'subscription error'); } catch {}
        return;
      }

      if (message?.method !== 'logsNotification') return;
      const subscriptionId = message?.params?.subscription;
      const programId = this.subscriptionToProgram.get(subscriptionId) ?? null;
      const value = message?.params?.result?.value ?? {};
      const logs = Array.isArray(value.logs) ? value.logs : [];
      const eventPayload = {
        provider,
        programId,
        subscriptionId,
        signature: value.signature ?? '',
        slot: message?.params?.result?.context?.slot ?? 0,
        err: value.err ?? null,
        logs,
        kind: classifyProgramLogs(logs),
        observedAt: Date.now()
      };

      if (eventPayload.kind === 'create' && !eventPayload.err) {
        this.#queueCreate(eventPayload);
        return;
      }

      Promise.resolve(this.onEvent(eventPayload)).catch((error) => {
        this.logger.error('[helius-ws] onEvent failed', error?.message ?? error);
      });
    });

    ws.addEventListener('error', () => {
      this.logger.warn(`[helius-ws] connection error provider=${provider}`);
      try { ws.close(4002, 'connection error'); } catch {}
    });

    ws.addEventListener('close', (event) => {
      if (this.watchdogTimer) clearInterval(this.watchdogTimer);
      this.watchdogTimer = null;
      if (!this.active || this.ws !== ws) return;
      this.ws = null;
      this.usePublicFallback = !usingPublic;
      const delay = Math.min(this.reconnectMaxMs, this.reconnectMinMs * (2 ** this.reconnectAttempt));
      this.reconnectAttempt += 1;
      const nextProvider = this.usePublicFallback ? 'solana-public' : 'helius';
      this.logger.warn(`[helius-ws] closed provider=${provider} code=${event.code}; next=${nextProvider} in ${delay}ms`);
      this.reconnectTimer = setTimeout(() => this.#connect(), delay);
    });
  }
}
