import { ensureRawCoinContractCopy } from './bot/rawCoinContractCopy.mjs';

const previousFetch = globalThis.fetch.bind(globalThis);
const TELEGRAM_METHODS = new Set(['sendMessage', 'sendPhoto']);

function telegramMethod(input) {
  const url = typeof input === 'string' || input instanceof URL ? String(input) : String(input?.url ?? '');
  return url.match(/^https:\/\/api\.telegram\.org\/bot[^/]+\/([^?]+)/i)?.[1] ?? '';
}

globalThis.fetch = async function telegramRawContractCopyFetch(input, init = {}) {
  const method = telegramMethod(input);
  if (!TELEGRAM_METHODS.has(method) || typeof init?.body !== 'string') {
    return previousFetch(input, init);
  }

  let payload;
  try {
    payload = JSON.parse(init.body);
  } catch {
    return previousFetch(input, init);
  }

  const nextPayload = ensureRawCoinContractCopy(payload);
  if (nextPayload === payload) return previousFetch(input, init);
  return previousFetch(input, { ...init, body: JSON.stringify(nextPayload) });
};
