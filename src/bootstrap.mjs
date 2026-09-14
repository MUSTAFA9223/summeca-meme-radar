import './telegramBoldFetch.mjs';
import './telegramOwnerMenu.mjs';
import { env } from './config/env.mjs';
import './index.mjs';
import { telegramApi } from './notifiers/telegram.mjs';
import { startEvmRadarWorker } from './signals/evmRadarWorker.mjs';
import { AppSettings } from './storage/appSettings.mjs';
import { startMomentumAlertWorker } from './signals/momentumAlertWorker.mjs';
import { runLiveConfigSmoke } from './trading/liveConfigSmoke.mjs';
import { startLiveAutomation } from './trading/liveAutomation.mjs';

async function sendOwnerAdminPanel() {
  if (!env.telegramBotToken) {
    console.warn('[telegram:owner-panel] skipped — bot token missing');
    return;
  }

  let chatId = String(env.telegramChatId ?? '').trim();
  if (!chatId) {
    const settings = new AppSettings(env.supabaseUrl, env.supabaseSecretKey);
    if (settings.enabled) {
      chatId = String(await settings.get('telegram_chat_id').catch((error) => {
        console.error(`[telegram:owner-panel] settings lookup failed — ${error.message}`);
        return '';
      }) ?? '').trim();
    }
  }

  if (!chatId) {
    console.warn('[telegram:owner-panel] skipped — linked owner chat not found');
    return;
  }

  await telegramApi(env.telegramBotToken, 'sendMessage', {
    chat_id: chatId,
    text: '🛠️ لوحة المالك — SUMMECA\n\nإدارة أكواد التفعيل والمستخدمين:',
    reply_markup: {
      inline_keyboard: [[
        { text: '🔐 إنشاء كود تفعيل', callback_data: 'admin:code' },
        { text: '👥 المستخدمون', callback_data: 'admin:users' }
      ]]
    }
  });
  console.log('[telegram:owner-panel] startup panel sent to linked owner');
}

await sendOwnerAdminPanel().catch((error) => {
  console.error(`[telegram:owner-panel] send failed — ${error.message}`);
});

const liveConfigReady = [
  env.privyAppId,
  env.privyAppSecret,
  env.privyWalletId,
  env.privyWalletAddress,
  env.privyAuthorizationPrivateKey,
  env.jupiterApiKey,
  env.heliusApiKey
].every((value) => String(value ?? '').trim());

if (!env.liveTradingEnabled && liveConfigReady) {
  try {
    await runLiveConfigSmoke(env);
    console.log('[live-config-smoke] PASS — read-only, no signing, no transaction sent');
  } catch (error) {
    console.error(`[live-config-smoke] FAIL — ${error.message}`);
  }
} else if (!env.liveTradingEnabled) {
  console.log('[live-config-smoke] SKIPPED — secure live configuration is incomplete');
}

await startMomentumAlertWorker();
await startEvmRadarWorker();
await startLiveAutomation();
