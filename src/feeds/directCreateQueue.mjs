const KEY = '__SUMMECA_DIRECT_CREATE_QUEUE__';

const queue = () => {
  if (!globalThis[KEY]) globalThis[KEY] = new Map();
  return globalThis[KEY];
};

export function enqueueDirectCreate(candidate) {
  const address = String(candidate?.address ?? '').trim();
  if (!address) return null;
  const q = queue();
  const previous = q.get(address) ?? {};
  const listedAt = Number(previous.listedAt ?? candidate.listedAt ?? Date.now());
  const merged = {
    ...previous,
    ...candidate,
    address,
    listedAt: Number.isFinite(listedAt) && listedAt > 0 ? listedAt : Date.now(),
    observedAt: Number(candidate?.observedAt ?? Date.now())
  };
  q.set(address, merged);
  return merged;
}

export function drainDirectCreates(limit = 50) {
  const q = queue();
  const out = [];
  for (const [address, candidate] of q) {
    out.push(candidate);
    q.delete(address);
    if (out.length >= limit) break;
  }
  return out;
}

export function directCreateQueueSize() {
  return queue().size;
}
