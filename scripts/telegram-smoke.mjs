import { AppSettings } from '../src/storage/appSettings.mjs';

const token = process.env.TELEGRAM_BOT_TOKEN ?? '';
const supabaseUrl = process.env.SUPABASE_URL ?? '';
const supabaseSecretKey = process.env.SUPABASE_SECRET_KEY ?? '';
const explicitChatId = process.env.TELEGRAM_CHAT_ID ?? '';

if (!token) throw new Error('TELEGRAM_BOT_TOKEN is missing');

async function telegram(method, body = undefined) {
  const response = await fetch(`https://api.telegram.org/bot${token}/${method}`, {
    method: body ? 'POST' : 'GET',
    headers: body ? { 'content-type': 'application/json' } : undefined,
    ...(body ? { body: JSON.stringify(body) } : {})
  });
  const payload = await response.json().catch(() => null);
  if (!response.ok || !payload?.ok) {
    throw new Error(payload?.description || `Telegram ${method} HTTP ${response.status}`);
  }
  return payload.result;
}

const me = await telegram('getMe');
const settings = new AppSettings(supabaseUrl, supabaseSecretKey);
let chatId = explicitChatId;
if (!chatId && settings.enabled) chatId = await settings.get('telegram_chat_id') ?? '';

let chatVerified = false;
if (chatId) {
  await telegram('getChat', { chat_id: String(chatId) });
  chatVerified = true;
}

console.log(JSON.stringify({
  ok: true,
  provider: 'telegram',
  botAuthenticated: Boolean(me?.id),
  chatLinked: Boolean(chatId),
  chatVerified,
  testMessageSent: false,
  mode: 'read-only'
}));
