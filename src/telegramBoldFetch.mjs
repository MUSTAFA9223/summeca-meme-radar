import { env } from './config/env.mjs';
import { TelegramAccess } from './storage/telegramAccess.mjs';

const nativeFetch = globalThis.fetch.bind(globalThis);
const access = new TelegramAccess(env.supabaseUrl, env.supabaseSecretKey);

const escapeHtml = (value) => String(value ?? '')
  .replaceAll('&', '&amp;')
  .replaceAll('<', '&lt;')
  .replaceAll('>', '&gt;');

const bold = (value) => `<b>${escapeHtml(value)}</b>`;

const TELEGRAM_BOLD_METHODS = new Set([
  'sendMessage',
  'editMessageText',
  'sendPhoto',
  'editMessageCaption'
]);

const TELEGRAM_BROADCAST_METHODS = new Set(['sendMessage', 'sendPhoto']);

function telegramMethod(url) {
  const match = String(url ?? '').match(/^https:\/\/api\.telegram\.org\/bot[^/]+\/([^?]+)/i);
  return match?.[1] ?? '';
}

function telegramBase(url) {
  const match = String(url ?? '').match(/^(https:\/\/api\.telegram\.org\/bot[^/]+)\//i);
  return match?.[1] ?? '';
}

function withBoldTelegramPayload(input, init = {}) {
  const url = typeof input === 'string' || input instanceof URL ? String(input) : String(input?.url ?? '');
  const method = telegramMethod(url);
  if (!TELEGRAM_BOLD_METHODS.has(method) || typeof init?.body !== 'string') return init;

  let payload;
  try {
    payload = JSON.parse(init.body);
  } catch {
    return init;
  }

  if (payload?.parse_mode) return init;

  let changed = false;
  if ((method === 'sendMessage' || method === 'editMessageText') && typeof payload?.text === 'string' && payload.text.length) {
    payload.text = bold(payload.text);
    payload.parse_mode = 'HTML';
    changed = true;
  }
  if ((method === 'sendPhoto' || method === 'editMessageCaption') && typeof payload?.caption === 'string' && payload.caption.length) {
    payload.caption = bold(payload.caption);
    payload.parse_mode = 'HTML';
    changed = true;
  }

  return changed ? { ...init, body: JSON.stringify(payload) } : init;
}

const stripHtml = (value) => String(value ?? '').replace(/<[^>]*>/g, '');

function isBroadcastAlert(payload = {}) {
  const text = stripHtml(payload.text ?? payload.caption ?? '');
  if (!text) return false;
  return /SUMMECA TRENDING|APPROVED ENTRY SIGNAL|إشارة دخول معتمدة|SUMMECA EARLY MOMENTUM|SAFETY PENDING|الأمان قيد التحقق|Tracking reference set|بدأ مرجع المتابعة|update\s*[—-]\s*crossed|تحديث\s+\$.*تجاوز|RISK EMERGENCY|طوارئ مخاطرة|WATCHLIST RISK|تحذير مخاطرة|زخم انفجاري|الزخم يتسارع|متابعة\s*[—-]\s*حركة صاعدة/i.test(text);
}

function subscriberReplyMarkup(replyMarkup) {
  if (!replyMarkup?.inline_keyboard || !Array.isArray(replyMarkup.inline_keyboard)) return undefined;
  const inlineKeyboard = replyMarkup.inline_keyboard
    .map((row) => (Array.isArray(row) ? row : []).filter((button) => button?.url || button?.copy_text))
    .filter((row) => row.length > 0);
  return inlineKeyboard.length ? { inline_keyboard: inlineKeyboard } : undefined;
}

async function telegramNative(base, method, body) {
  if (!base) return null;
  const response = await nativeFetch(`${base}/${method}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body ?? {})
  });
  const payload = await response.json().catch(() => null);
  if (!response.ok || !payload?.ok) {
    const error = new Error(payload?.description || `Telegram ${method} HTTP ${response.status}`);
    error.status = response.status;
    throw error;
  }
  return payload.result;
}

async function directMessage(base, chatId, text) {
  return telegramNative(base, 'sendMessage', { chat_id: String(chatId), text });
}

async function answerCallback(base, callbackId, text) {
  if (!callbackId) return;
  await telegramNative(base, 'answerCallbackQuery', {
    callback_query_id: callbackId,
    text,
    show_alert: true
  }).catch(() => {});
}

function updateMessage(update) {
  return update?.message ?? update?.edited_message ?? null;
}

function updateChatId(update) {
  return String(update?.message?.chat?.id ?? update?.callback_query?.message?.chat?.id ?? '');
}

async function processAccessUpdate(update, base, ownerChatId) {
  const chatId = updateChatId(update);
  if (!chatId || chatId === String(ownerChatId)) {
    const message = updateMessage(update);
    const text = String(message?.text ?? '').trim();
    if (!message || chatId !== String(ownerChatId)) return { keep: true };

    const codeMatch = text.match(/^\/(?:newcode|code)(?:@\w+)?(?:\s+(\d{1,4}))?\s*$/i);
    if (codeMatch) {
      try {
        const created = await access.createCode(ownerChatId, codeMatch[1] || null);
        const duration = created.accessDays ? `${created.accessDays} يوم` : 'دائم';
        await directMessage(base, ownerChatId,
          `🔐 كود تفعيل جديد\n\n${created.code}\n\nالمدة بعد التفعيل: ${duration}\nالاستخدام: مرة واحدة فقط\n\nأرسل الكود للمستخدم، ثم يفتح البوت ويرسل:\n/activate ${created.code}`
        );
      } catch (error) {
        await directMessage(base, ownerChatId, `تعذر إنشاء كود التفعيل: ${error.message}`);
      }
      return { keep: false };
    }

    if (/^\/users(?:@\w+)?\s*$/i.test(text)) {
      const users = await access.listSubscribers(100).catch(() => []);
      const lines = users.map((user) => {
        const name = user.username ? `@${user.username}` : user.first_name || 'بدون اسم';
        const state = user.active ? '✅' : '⛔';
        const expiry = user.access_expires_at ? new Date(user.access_expires_at).toISOString().slice(0, 10) : 'دائم';
        return `${state} ${name} | ${user.chat_id} | ${user.role} | ${expiry}`;
      });
      await directMessage(base, ownerChatId, `👥 المستخدمون (${users.length})\n\n${lines.join('\n') || 'لا يوجد مستخدمون.'}`);
      return { keep: false };
    }

    const revokeMatch = text.match(/^\/revoke(?:@\w+)?\s+(-?\d+)\s*$/i);
    if (revokeMatch) {
      await access.revoke(revokeMatch[1]);
      await directMessage(base, ownerChatId, `⛔ تم إلغاء تفعيل المستخدم ${revokeMatch[1]}.`);
      return { keep: false };
    }

    return { keep: true };
  }

  const callback = update?.callback_query;
  if (callback) {
    const subscriber = await access.subscriber(chatId).catch(() => null);
    await answerCallback(base, callback.id, subscriber?.authorized
      ? 'حسابك مفعل لاستقبال إشارات SUMMECA. أدوات التداول والإدارة خاصة بالمالك.'
      : 'هذا البوت خاص. فعّل حسابك أولًا بكود صالح.'
    );
    return { keep: false };
  }

  const message = updateMessage(update);
  if (!message || message?.chat?.type !== 'private') return { keep: false };
  const text = String(message?.text ?? '').trim();
  const subscriber = await access.subscriber(chatId).catch(() => null);

  const activateMatch = text.match(/^\/(?:activate|تفعيل)(?:@\w+)?\s+(\S+)\s*$/i)
    || text.match(/^\/start(?:@\w+)?\s+(SMC-[A-Z0-9]{4}-[A-Z0-9]{4})\s*$/i)
    || text.match(/^(SMC-[A-Z0-9]{4}-[A-Z0-9]{4})$/i);

  if (activateMatch) {
    try {
      const result = await access.activate(activateMatch[1], message);
      if (result?.ok) {
        const expiry = result.permanent || !result.access_expires_at
          ? 'دائم'
          : new Date(result.access_expires_at).toISOString().slice(0, 10);
        await directMessage(base, chatId,
          `✅ تم تفعيل SUMMECA Meme Radar بنجاح.\n\nستصلك إشارات العملات والتنبيهات تلقائيًا.\nصلاحية الوصول: ${expiry}\n\nأدوات الإدارة والتداول الحساسة تبقى خاصة بالمالك.`
        );
      } else {
        const reason = {
          invalid: 'الكود غير صحيح.',
          revoked: 'تم إلغاء هذا الكود.',
          expired_code: 'انتهت صلاحية الكود.',
          used: 'هذا الكود استُخدم مسبقًا.'
        }[result?.reason] || 'تعذر تفعيل الكود.';
        await directMessage(base, chatId, `❌ ${reason}`);
      }
    } catch (error) {
      await directMessage(base, chatId, `❌ تعذر التفعيل الآن: ${error.message}`);
    }
    return { keep: false };
  }

  if (/^\/start(?:@\w+)?(?:\s|$)/i.test(text)) {
    if (subscriber?.authorized) {
      await directMessage(base, chatId,
        '✅ حسابك مفعل في SUMMECA Meme Radar.\n\nستصلك الإشارات والتنبيهات تلقائيًا. أدوات الإدارة والتداول الحساسة خاصة بالمالك.'
      );
    } else {
      await directMessage(base, chatId,
        '🔒 SUMMECA Meme Radar خاص.\n\nللدخول تحتاج كود تفعيل من المالك. بعد استلامه أرسله هكذا:\n/activate SMC-XXXX-XXXX'
      );
    }
    return { keep: false };
  }

  if (subscriber?.authorized) {
    await directMessage(base, chatId,
      '✅ حسابك مفعل لاستقبال إشارات SUMMECA تلقائيًا.\n\nأدوات التحكم والتداول الحساسة خاصة بالمالك.'
    );
  } else {
    await directMessage(base, chatId,
      '🔒 البوت خاص. اطلب كود تفعيل من المالك ثم استخدم /activate متبوعًا بالكود.'
    );
  }
  return { keep: false };
}

async function filterTelegramUpdates(response, base) {
  if (!access.enabled) return response;
  let payload;
  try {
    payload = await response.clone().json();
  } catch {
    return response;
  }
  if (!payload?.ok || !Array.isArray(payload.result)) return response;

  const ownerChatId = await access.ownerChatId().catch(() => '');
  if (!ownerChatId) return response;

  const original = payload.result;
  const highestUpdateId = original.reduce((max, update) => Math.max(max, Number(update?.update_id ?? 0)), 0);
  const kept = [];
  for (const update of original) {
    try {
      const result = await processAccessUpdate(update, base, ownerChatId);
      if (result.keep) kept.push(update);
    } catch (error) {
      console.error('[telegram:access-update]', error.message);
    }
  }
  const highestKeptId = kept.reduce((max, update) => Math.max(max, Number(update?.update_id ?? 0)), 0);
  if (highestUpdateId > highestKeptId) kept.push({ update_id: highestUpdateId });
  payload.result = kept;

  const headers = new Headers(response.headers);
  headers.delete('content-length');
  headers.delete('content-encoding');
  return new Response(JSON.stringify(payload), { status: response.status, statusText: response.statusText, headers });
}

async function broadcastAlert(base, method, payload, ownerChatId) {
  if (!access.enabled || !ownerChatId || !isBroadcastAlert(payload)) return;
  const recipients = await access.activeRecipients({ excludeChatId: ownerChatId }).catch((error) => {
    console.error('[telegram:broadcast-recipients]', error.message);
    return [];
  });
  if (!recipients.length) return;

  const safeMarkup = subscriberReplyMarkup(payload.reply_markup);
  for (const recipient of recipients) {
    const copy = {
      ...payload,
      chat_id: String(recipient.chat_id)
    };
    delete copy.reply_parameters;
    if (safeMarkup) copy.reply_markup = safeMarkup;
    else delete copy.reply_markup;
    try {
      await telegramNative(base, method, copy);
    } catch (error) {
      console.warn(`[telegram:broadcast] chat=${recipient.chat_id} ${error.message}`);
      if (error.status === 403) await access.markInactive(recipient.chat_id);
    }
  }
}

globalThis.fetch = async (input, init = {}) => {
  const url = typeof input === 'string' || input instanceof URL ? String(input) : String(input?.url ?? '');
  const method = telegramMethod(url);
  const base = telegramBase(url);
  const transformed = withBoldTelegramPayload(input, init);

  if (method === 'getUpdates') {
    const response = await nativeFetch(input, transformed);
    return filterTelegramUpdates(response, base);
  }

  if (!TELEGRAM_BROADCAST_METHODS.has(method) || typeof transformed?.body !== 'string') {
    return nativeFetch(input, transformed);
  }

  let payload;
  try {
    payload = JSON.parse(transformed.body);
  } catch {
    return nativeFetch(input, transformed);
  }

  const response = await nativeFetch(input, transformed);
  if (!response.ok || !payload?.chat_id || !isBroadcastAlert(payload)) return response;

  const ownerChatId = await access.ownerChatId().catch(() => '');
  if (ownerChatId && String(payload.chat_id) === String(ownerChatId)) {
    await broadcastAlert(base, method, payload, ownerChatId).catch((error) => console.error('[telegram:broadcast]', error.message));
  }
  return response;
};
