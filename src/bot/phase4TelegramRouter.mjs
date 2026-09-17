import { env } from '../config/env.mjs';
import { AppSettings } from '../storage/appSettings.mjs';
import { TradingTerminal } from './tradingTerminal.mjs';

const previousFetch = globalThis.fetch.bind(globalThis);
const settings = new AppSettings(env.supabaseUrl, env.supabaseSecretKey);
const terminal = new TradingTerminal(settings);
let ownerCache = { chatId: '', expiresAt: 0 };

function telegramMethod(url) {
  const match = String(url ?? '').match(/^https:\/\/api\.telegram\.org\/bot[^/]+\/([^?]+)/i);
  return match?.[1] ?? '';
}
function telegramBase(url) {
  const match = String(url ?? '').match(/^(https:\/\/api\.telegram\.org\/bot[^/]+)\//i);
  return match?.[1] ?? '';
}
async function ownerChatId() {
  if (ownerCache.expiresAt > Date.now() && ownerCache.chatId) return ownerCache.chatId;
  let chatId = String(env.telegramChatId || '');
  if (!chatId && settings.enabled) chatId = String(await settings.get('telegram_chat_id').catch(() => '') || '');
  ownerCache = { chatId, expiresAt: Date.now() + 60_000 };
  return chatId;
}
async function telegramCall(base, method, body = {}) {
  const response = await previousFetch(`${base}/${method}`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body)
  });
  const payload = await response.json().catch(() => null);
  if (!response.ok || !payload?.ok) throw new Error(payload?.description || `Telegram ${method} HTTP ${response.status}`);
  return payload.result;
}
async function sendResult(base, chatId, result) {
  if (!result?.text) return;
  await telegramCall(base, 'sendMessage', {
    chat_id: chatId,
    text: result.text,
    ...(Array.isArray(result.keyboard) && result.keyboard.length ? { reply_markup: { inline_keyboard: result.keyboard } } : {})
  });
}
async function consume(update, base, ownerId) {
  const callback = update?.callback_query;
  const callbackChat = String(callback?.message?.chat?.id ?? '');
  const data = String(callback?.data ?? '');
  if (callback && callbackChat === ownerId && (data.startsWith('p4:') || data.startsWith('p5:'))) {
    await telegramCall(base, 'answerCallbackQuery', { callback_query_id: callback.id }).catch(() => {});
    const result = await terminal.handle(data).catch((error) => ({ handled: true, text: `❌ Terminal extension: ${String(error?.message ?? error).slice(0, 180)}`, keyboard: [] }));
    if (result?.handled) await sendResult(base, ownerId, result).catch(() => {});
    return true;
  }
  const message = update?.message ?? update?.edited_message;
  const chatId = String(message?.chat?.id ?? '');
  const text = String(message?.text ?? '').trim();
  if (message && chatId === ownerId && /^\/leaderboard(?:@\w+)?\b/i.test(text)) {
    const result = await terminal.handle('p4:lb').catch(() => null);
    if (result?.handled) await sendResult(base, ownerId, result).catch(() => {});
    return true;
  }
  return false;
}
async function filterUpdates(response, base) {
  let payload;
  try { payload = await response.clone().json(); } catch { return response; }
  if (!payload?.ok || !Array.isArray(payload.result)) return response;
  const ownerId = await ownerChatId();
  if (!ownerId) return response;
  const kept = [];
  const highest = payload.result.reduce((m, u) => Math.max(m, Number(u?.update_id ?? 0)), 0);
  for (const update of payload.result) {
    if (await consume(update, base, ownerId)) continue;
    kept.push(update);
  }
  const highestKept = kept.reduce((m, u) => Math.max(m, Number(u?.update_id ?? 0)), 0);
  if (highest > highestKept) kept.push({ update_id: highest });
  payload.result = kept;
  const headers = new Headers(response.headers);
  headers.delete('content-length');
  headers.delete('content-encoding');
  return new Response(JSON.stringify(payload), { status: response.status, statusText: response.statusText, headers });
}
function appendCommands(init) {
  if (typeof init?.body !== 'string') return init;
  try {
    const body = JSON.parse(init.body);
    if (!Array.isArray(body?.commands)) return init;
    if (!body.commands.some((c) => c?.command === 'leaderboard')) {
      body.commands.splice(Math.max(0, body.commands.length - 3), 0, { command: 'leaderboard', description: 'Smart-Wallet Performance Leaderboard' });
    }
    return { ...init, body: JSON.stringify(body) };
  } catch { return init; }
}

globalThis.fetch = async (input, init = {}) => {
  const url = typeof input === 'string' || input instanceof URL ? String(input) : String(input?.url ?? '');
  const method = telegramMethod(url);
  const base = telegramBase(url);
  if (method === 'getUpdates') {
    const response = await previousFetch(input, init);
    return filterUpdates(response, base);
  }
  if (method === 'setMyCommands') return previousFetch(input, appendCommands(init));
  return previousFetch(input, init);
};

console.log('SUMMECA EXTENSION TELEGRAM ROUTER: p4+p5 callbacks + /leaderboard on shared getUpdates stream');
