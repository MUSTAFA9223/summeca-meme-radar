import { env } from './config/env.mjs';
import { AppSettings } from './storage/appSettings.mjs';
import { TelegramAccess } from './storage/telegramAccess.mjs';

const previousFetch = globalThis.fetch.bind(globalThis);
const access = new TelegramAccess(env.supabaseUrl, env.supabaseSecretKey);
const settings = new AppSettings(env.supabaseUrl, env.supabaseSecretKey);

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
  let chatId = await access.ownerChatId().catch(() => '');
  if (!chatId && settings.enabled) {
    chatId = await settings.get('telegram_chat_id').catch(() => '');
  }
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

function adminKeyboard() {
  return {
    inline_keyboard: [
      [
        { text: '🔐 إنشاء كود تفعيل', callback_data: 'admin:code' },
        { text: '👥 المستخدمون', callback_data: 'admin:users' }
      ],
      [{ text: '🏠 القائمة الرئيسية', callback_data: 'menu:home' }]
    ]
  };
}

function withOwnerAdminButtons(payload, ownerId) {
  if (!payload || String(payload.chat_id ?? '') !== String(ownerId)) return payload;
  if (hasCallback(payload.reply_markup, 'admin:home')) return payload;

  const text = String(payload.text ?? payload.caption ?? '');
  const isMainMenu = hasCallback(payload.reply_markup, 'menu:status')
    || /SUMMECA Meme Radar/i.test(text);
  if (!isMainMenu) return payload;

  const keyboard = Array.isArray(payload.reply_markup?.inline_keyboard)
    ? payload.reply_markup.inline_keyboard.map((row) => [...row])
    : [];

  const adminButton = { text: '🛠️ الأدمن', callback_data: 'admin:home' };
  const helpRow = keyboard.find((row) =>
    Array.isArray(row) && row.some((button) => button?.callback_data === 'menu:help')
  );
  if (helpRow) helpRow.push(adminButton);
  else keyboard.push([adminButton]);

  return {
    ...payload,
    reply_markup: { ...(payload.reply_markup ?? {}), inline_keyboard: keyboard }
  };
}

async function sendOwnerPanel(base, ownerId) {
  return telegramCall(base, 'sendMessage', {
    chat_id: ownerId,
    text: '🛠️ لوحة الأدمن — SUMMECA\n\nإدارة أكواد التفعيل والمستخدمين:',
    reply_markup: adminKeyboard()
  });
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
        ],
        [{ text: '⬅️ لوحة الأدمن', callback_data: 'admin:home' }],
        [{ text: '🏠 القائمة الرئيسية', callback_data: 'menu:home' }]
      ]
    }
  });
}

async function createActivationCode(base, ownerId, days) {
  const created = await access.createCode(ownerId, days == null ? null : days);
  const duration = created.accessDays ? `${created.accessDays} يوم` : 'دائم';
  return telegramCall(base, 'sendMessage', {
    chat_id: ownerId,
    text: `🔐 كود تفعيل جديد\n\n${created.code}\n\nالمدة بعد التفعيل: ${duration}\nالاستخدام: مرة واحدة فقط\n\nاضغط «📋 نسخ الكود» وأرسله للمستخدم.`,
    reply_markup: {
      inline_keyboard: [
        [{ text: '📋 نسخ الكود', copy_text: { text: created.code } }],
        ...adminKeyboard().inline_keyboard
      ]
    }
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
    text: `👥 المستخدمون (${users.length})\n\n${lines.join('\n') || 'لا يوجد مستخدمون.'}`,
    reply_markup: adminKeyboard()
  });
}

async function consumeOwnerUpdate(update, base, ownerId) {
  const callback = update?.callback_query;
  const callbackChatId = String(callback?.message?.chat?.id ?? '');
  const data = String(callback?.data ?? '');

  if (callback && callbackChatId === String(ownerId) && data.startsWith('admin:')) {
    try {
      await telegramCall(base, 'answerCallbackQuery', { callback_query_id: callback.id }).catch(() => {});
      if (data === 'admin:home') await sendOwnerPanel(base, ownerId);
      else if (data === 'admin:code') await sendCodeMenu(base, ownerId);
      else if (data === 'admin:users') await showUsers(base, ownerId);
      else if (data === 'admin:code:permanent') await createActivationCode(base, ownerId, null);
      else {
        const match = data.match(/^admin:code:(7|30|90)$/);
        if (match) await createActivationCode(base, ownerId, Number(match[1]));
      }
    } catch (error) {
      await telegramCall(base, 'sendMessage', {
        chat_id: ownerId,
        text: `تعذر تنفيذ أمر الإدارة: ${error.message}`
      }).catch(() => {});
    }
    return true;
  }

  const message = update?.message ?? update?.edited_message;
  const messageChatId = String(message?.chat?.id ?? '');
  const text = String(message?.text ?? '').trim();
  if (message && messageChatId === String(ownerId) && /^\/admin(?:@\w+)?\s*$/i.test(text)) {
    await sendOwnerPanel(base, ownerId).catch((error) => console.error('[telegram:owner-panel]', error.message));
    return true;
  }

  return false;
}

async function filterOwnerUpdates(response, base) {
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
    if (await consumeOwnerUpdate(update, base, ownerId)) continue;
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
    return filterOwnerUpdates(response, base);
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
      // Preserve the original Telegram request on parsing or lookup errors.
    }
  }

  return previousFetch(input, init);
};

async function pushOwnerPanelOnStartup() {
  if (!env.telegramBotToken || !access.enabled) return;
  const ownerId = await ownerChatId();
  if (!ownerId) {
    console.warn('[telegram:owner-panel] owner chat not resolved');
    return;
  }
  const base = `https://api.telegram.org/bot${env.telegramBotToken}`;
  await telegramCall(base, 'sendMessage', {
    chat_id: ownerId,
    text: '✅ SUMMECA Meme Radar يعمل الآن.\n\nافتح القائمة الرئيسية وستجد زر 🛠️ الأدمن مع بقية الأزرار.',
    reply_markup: {
      inline_keyboard: [[
        { text: '🏠 فتح القائمة', callback_data: 'menu:home' },
        { text: '🛠️ الأدمن', callback_data: 'admin:home' }
      ]]
    }
  });
  console.log('[telegram:owner-panel] startup controls sent');
}

const startupTimer = setTimeout(() => {
  void pushOwnerPanelOnStartup().catch((error) => console.error('[telegram:owner-panel]', error.message));
}, 2500);
startupTimer.unref?.();
