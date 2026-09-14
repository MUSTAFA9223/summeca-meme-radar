import { env } from './config/env.mjs';
import { TelegramAccess } from './storage/telegramAccess.mjs';

const previousFetch = globalThis.fetch.bind(globalThis);
const access = new TelegramAccess(env.supabaseUrl, env.supabaseSecretKey);

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
  const chatId = await access.ownerChatId().catch(() => '');
  ownerCache = { chatId: String(chatId ?? ''), expiresAt: Date.now() + 60_000 };
  return ownerCache.chatId;
}

async function telegramCall(base, method, body = {}) {
  const response = await previousFetch(`${base}/${method}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body)
  });
  const payload = await response.json().catch(() => null);
  if (!response.ok || !payload?.ok) {
    throw new Error(payload?.description || `Telegram ${method} HTTP ${response.status}`);
  }
  return payload.result;
}

function hasCallback(markup, callbackData) {
  return Boolean(markup?.inline_keyboard?.some((row) =>
    Array.isArray(row) && row.some((button) => button?.callback_data === callbackData)
  ));
}

function withOwnerAdminButtons(payload, ownerId) {
  if (!payload || String(payload.chat_id ?? '') !== String(ownerId)) return payload;
  if (!hasCallback(payload.reply_markup, 'menu:status')) return payload;
  if (hasCallback(payload.reply_markup, 'admin:code')) return payload;

  const keyboard = Array.isArray(payload.reply_markup?.inline_keyboard)
    ? payload.reply_markup.inline_keyboard.map((row) => [...row])
    : [];

  keyboard.push([
    { text: '🔐 إنشاء كود تفعيل', callback_data: 'admin:code' },
    { text: '👥 المستخدمون', callback_data: 'admin:users' }
  ]);

  return {
    ...payload,
    reply_markup: { ...(payload.reply_markup ?? {}), inline_keyboard: keyboard }
  };
}

async function sendCodeMenu(base, ownerId) {
  return telegramCall(base, 'sendMessage', {
    chat_id: ownerId,
    text: '🔐 إنشاء كود تفعيل\n\nاختر مدة صلاحية المستخدم بعد تفعيل الكود:',
    reply_markup: {
      inline_keyboard: [
        [
          { text: '♾️ دائم', callback_data: 'admin:code:permanent' },
          { text: '7 أيام', callback_data: 'admin:code:7' }
        ],
        [
          { text: '30 يوم', callback_data: 'admin:code:30' },
          { text: '90 يوم', callback_data: 'admin:code:90' }
        ]
      ]
    }
  });
}

async function createActivationCode(base, ownerId, days) {
  const created = await access.createCode(ownerId, days == null ? null : days);
  const duration = created.accessDays ? `${created.accessDays} يوم` : 'دائم';
  return telegramCall(base, 'sendMessage', {
    chat_id: ownerId,
    text: `🔐 كود تفعيل جديد\n\n${created.code}\n\nالمدة بعد التفعيل: ${duration}\nالاستخدام: مرة واحدة فقط\n\nأرسل الكود للمستخدم، ثم يفتح البوت ويرسل:\n/activate ${created.code}`
  });
}

async function showUsers(base, ownerId) {
  const users = await access.listSubscribers(100);
  const lines = users.map((user) => {
    const name = user.username ? `@${user.username}` : user.first_name || 'بدون اسم';
    const state = user.active ? '✅' : '⛔';
    const expiry = user.access_expires_at ? new Date(user.access_expires_at).toISOString().slice(0, 10) : 'دائم';
    return `${state} ${name} | ${user.chat_id} | ${user.role} | ${expiry}`;
  });
  return telegramCall(base, 'sendMessage', {
    chat_id: ownerId,
    text: `👥 المستخدمون (${users.length})\n\n${lines.join('\n') || 'لا يوجد مستخدمون.'}`
  });
}

async function consumeOwnerCallback(update, base, ownerId) {
  const callback = update?.callback_query;
  const chatId = String(callback?.message?.chat?.id ?? '');
  const data = String(callback?.data ?? '');
  if (!callback || chatId !== String(ownerId) || !data.startsWith('admin:')) return false;

  try {
    await telegramCall(base, 'answerCallbackQuery', { callback_query_id: callback.id }).catch(() => {});

    if (data === 'admin:code') {
      await sendCodeMenu(base, ownerId);
      return true;
    }
    if (data === 'admin:users') {
      await showUsers(base, ownerId);
      return true;
    }
    if (data === 'admin:code:permanent') {
      await createActivationCode(base, ownerId, null);
      return true;
    }

    const match = data.match(/^admin:code:(7|30|90)$/);
    if (match) {
      await createActivationCode(base, ownerId, Number(match[1]));
      return true;
    }
  } catch (error) {
    await telegramCall(base, 'sendMessage', {
      chat_id: ownerId,
      text: `تعذر تنفيذ أمر الإدارة: ${error.message}`
    }).catch(() => {});
    return true;
  }

  return true;
}

async function filterOwnerCallbacks(response, base) {
  if (!access.enabled) return response;
  let payload;
  try {
    payload = await response.clone().json();
  } catch {
    return response;
  }
  if (!payload?.ok || !Array.isArray(payload.result)) return response;

  const ownerId = await ownerChatId();
  if (!ownerId) return response;

  const kept = [];
  const original = payload.result;
  const highestUpdateId = original.reduce((max, update) => Math.max(max, Number(update?.update_id ?? 0)), 0);

  for (const update of original) {
    if (await consumeOwnerCallback(update, base, ownerId)) continue;
    kept.push(update);
  }

  const highestKeptId = kept.reduce((max, update) => Math.max(max, Number(update?.update_id ?? 0)), 0);
  if (highestUpdateId > highestKeptId) kept.push({ update_id: highestUpdateId });
  payload.result = kept;

  const headers = new Headers(response.headers);
  headers.delete('content-length');
  headers.delete('content-encoding');
  return new Response(JSON.stringify(payload), {
    status: response.status,
    statusText: response.statusText,
    headers
  });
}

globalThis.fetch = async (input, init = {}) => {
  const url = typeof input === 'string' || input instanceof URL ? String(input) : String(input?.url ?? '');
  const method = telegramMethod(url);
  const base = telegramBase(url);

  if (method === 'getUpdates') {
    const response = await previousFetch(input, init);
    return filterOwnerCallbacks(response, base);
  }

  if (method === 'sendMessage' && typeof init?.body === 'string') {
    try {
      const payload = JSON.parse(init.body);
      const ownerId = await ownerChatId();
      const enhanced = withOwnerAdminButtons(payload, ownerId);
      if (enhanced !== payload) {
        return previousFetch(input, { ...init, body: JSON.stringify(enhanced) });
      }
    } catch {
      // Keep the original Telegram request if the payload is not JSON.
    }
  }

  return previousFetch(input, init);
};
