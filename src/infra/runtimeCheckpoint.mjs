import { HardeningStore } from '../storage/hardeningStore.mjs';

const store = new HardeningStore();
const MAX_REPLAY_BLOCKS = Math.max(25, Math.min(2_000, Number(process.env.RUNTIME_MAX_REPLAY_BLOCKS || 500)));
const SAVE_MS = Math.max(5_000, Math.min(60_000, Number(process.env.RUNTIME_CHECKPOINT_MS || 15_000)));
const PENDING_MAX_AGE_MS = Math.max(60_000, Math.min(60 * 60_000, Number(process.env.RUNTIME_PENDING_MAX_AGE_MS || 15 * 60_000)));

const hasOwnState = (worker) => Boolean(
  worker && typeof worker === 'object' && (
    (Number.isFinite(Number(worker.lastBlock)) && Number(worker.lastBlock) > 0) ||
    worker.seenSignatures instanceof Set ||
    worker.pending instanceof Map
  )
);

function primitivePendingState(state) {
  if (!state || typeof state !== 'object') return null;
  const safe = {};
  for (const key of [
    'createdAt', 'signature', 'initialBuy', 'lastMarketAt', 'lastProfileAt', 'rootMessageId',
    'launchSent', 'qualifiedSent', 'topSent', 'firstPriceUsd', 'lastPriceUsd', 'marketLiveSent'
  ]) {
    const value = state[key];
    if (['string', 'number', 'boolean'].includes(typeof value)) safe[key] = value;
  }
  if (state.profile && typeof state.profile === 'object') {
    safe.profile = {};
    for (const [key, value] of Object.entries(state.profile)) {
      if (['string', 'number', 'boolean'].includes(typeof value) || value === null) safe.profile[key] = value;
    }
  }
  return safe;
}

function snapshotWorker(worker) {
  const out = { savedAt: Date.now() };
  if (Number.isFinite(Number(worker?.lastBlock)) && Number(worker.lastBlock) > 0) out.lastBlock = Number(worker.lastBlock);
  if (worker?.seenSignatures instanceof Set) out.seenSignatures = [...worker.seenSignatures].slice(-300);
  if (worker?.pending instanceof Map) {
    const cutoff = Date.now() - PENDING_MAX_AGE_MS;
    out.pending = [...worker.pending.entries()]
      .filter(([, state]) => Number(state?.createdAt || 0) >= cutoff)
      .slice(-120)
      .map(([key, state]) => [key, primitivePendingState(state)])
      .filter(([, state]) => state);
  }
  return out;
}

function restoreWorker(worker, value, name) {
  if (!worker || !value || typeof value !== 'object') return;
  if (Number.isFinite(Number(value.lastBlock)) && Number(value.lastBlock) > 0 && Number.isFinite(Number(worker.lastBlock)) && Number(worker.lastBlock) > 0) {
    const current = Number(worker.lastBlock);
    const saved = Number(value.lastBlock);
    const replayFrom = Math.max(0, current - MAX_REPLAY_BLOCKS, Math.min(current, saved));
    if (replayFrom < current) {
      worker.lastBlock = replayFrom;
      console.log(`[checkpoint] ${name} replay ${current - replayFrom} blocks from persisted cursor=${saved}`);
    }
  }
  if (worker.seenSignatures instanceof Set && Array.isArray(value.seenSignatures)) {
    for (const signature of value.seenSignatures.slice(-300)) if (signature) worker.seenSignatures.add(String(signature));
  }
  if (worker.pending instanceof Map && Array.isArray(value.pending)) {
    const cutoff = Date.now() - PENDING_MAX_AGE_MS;
    let restored = 0;
    for (const entry of value.pending) {
      if (!Array.isArray(entry) || entry.length !== 2) continue;
      const [key, state] = entry;
      if (!key || !state || Number(state.createdAt || 0) < cutoff || worker.pending.has(key)) continue;
      worker.pending.set(String(key), state);
      restored += 1;
    }
    if (restored) console.log(`[checkpoint] ${name} restored pending=${restored}`);
  }
}

async function attachSingle(name, worker) {
  if (!hasOwnState(worker) || !store.enabled) return;
  const checkpointKey = `worker:${name}`;
  try {
    const row = await store.loadCheckpoint(checkpointKey);
    if (row?.value) restoreWorker(worker, row.value, name);
  } catch (error) {
    console.warn(`[checkpoint] ${name} restore failed: ${String(error?.message ?? error).slice(0, 140)}`);
  }

  const save = async () => {
    try { await store.saveCheckpoint(checkpointKey, snapshotWorker(worker)); }
    catch (error) { console.warn(`[checkpoint] ${name} save failed: ${String(error?.message ?? error).slice(0, 140)}`); }
  };
  setInterval(() => void save(), SAVE_MS).unref?.();
  setTimeout(() => void save(), 1_000).unref?.();
}

export async function attachRuntimeCheckpoint(name, worker) {
  if (!worker || !store.enabled) return worker;
  await attachSingle(name, worker);
  if (Array.isArray(worker.evmWorkers)) {
    await Promise.all(worker.evmWorkers.map((child, index) => attachSingle(`${name}:evm:${child?.config?.key || index}`, child)));
  }
  if (worker.solana && typeof worker.solana === 'object') await attachSingle(`${name}:solana`, worker.solana);
  if (worker.discovery && typeof worker.discovery === 'object') await attachSingle(`${name}:discovery`, worker.discovery);
  return worker;
}

console.log(`RUNTIME CHECKPOINTS: durable state active interval=${SAVE_MS}ms maxReplayBlocks=${MAX_REPLAY_BLOCKS}`);
