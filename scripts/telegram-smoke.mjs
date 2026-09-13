import { discoverPrivateStartChat, TelegramNotifier } from '../src/notifiers/telegram.mjs';
import { AppSettings } from '../src/storage/appSettings.mjs';

const token = process.env.TELEGRAM_BOT_TOKEN ?? '';
const supabaseUrl = process.env.SUPABASE_URL ?? '';
const supabaseSecretKey = process.env.SUPABASE_SECRET_KEY ?? '';
const explicitChatId = process.env.TELEGRAM_CHAT_ID ?? '';

if (!token) throw new Error('TELEGRAM_BOT_TOKEN is missing');

const settings = new AppSettings(supabaseUrl, supabaseSecretKey);
let chatId = explicitChatId;

if (!chatId && settings.enabled) {
  chatId = await settings.get('telegram_chat_id') ?? '';
}

if (!chatId) {
  chatId = await discoverPrivateStartChat(token);
  if (settings.enabled) await settings.set('telegram_chat_id', chatId);
}

const notifier = new TelegramNotifier(token, chatId);
await notifier.test();

console.log(JSON.stringify({
  ok: true,
  provider: 'telegram',
  chatLinked: true,
  testMessageSent: true
}));
