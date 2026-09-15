import {
  STARTUP_ALERT_MUTE_MS,
  STARTUP_SUPPRESSED_TOKEN_TTL_MS,
  isTelegramRadarAlert,
  telegramAlertTokenKey
} from './bot/telegramNotificationPolicy.mjs';

const nativeFetch = globalThis.fetch.bind(globalThis);
const startedAt = Date.now();
const suppressedTokens = new Map();

function telegramMethod(url) {
  const match = String(url ?? '').match(/^https:\/\/api\.telegram\.org\/bot[^/]+\/([^?]+)/i);
  return match?.[1] ?? '';
}

function fakeTelegramResponse(payload = {}, method = 'sendMessage') {
  const result = {
    message_id: 0,
    date: Math.floor(Date.now() / 1000),
    chat: { id: payload.chat_id ?? 0, type: 'private' }
  };
  if (method === 'sendPhoto') result.caption = payload.caption ?? '';
  else result.text = payload.text ?? '';
  return new Response(JSON.stringify({ ok: true, result }), {
    status: 200,
    headers: { 'content-type': 'application/json' }
  });
}

function cleanupSuppressed(now) {
  for (const [key, expiresAt] of suppressedTokens) {
    if (expiresAt <= now) suppressedTokens.delete(key);
  }
}

globalThis.fetch = async function deploySafeTelegramFetch(input, init = {}) {
  const url = typeof input === 'string' || input instanceof URL ? String(input) : String(input?.url ?? '');
  const method = telegramMethod(url);
  if (!['sendMessage', 'sendPhoto'].includes(method) || typeof init?.body !== 'string') {
    return nativeFetch(input, init);
  }

  let payload;
  try {
    payload = JSON.parse(init.body);
  } catch {
    return nativeFetch(input, init);
  }

  if (!isTelegramRadarAlert(payload)) return nativeFetch(input, init);

  const now = Date.now();
  cleanupSuppressed(now);
  const key = telegramAlertTokenKey(payload);
  const startupMuted = now - startedAt < STARTUP_ALERT_MUTE_MS;

  if (startupMuted) {
    if (key) suppressedTokens.set(key, now + STARTUP_SUPPRESSED_TOKEN_TTL_MS);
    console.log(`[telegram:deploy-mute] suppressed startup radar alert${key ? ` token=${key.slice(0, 10)}…` : ''}`);
    return fakeTelegramResponse(payload, method);
  }

  if (key && suppressedTokens.has(key)) {
    console.log(`[telegram:deploy-mute] suppressed replayed radar alert token=${key.slice(0, 10)}…`);
    return fakeTelegramResponse(payload, method);
  }

  return nativeFetch(input, init);
};
