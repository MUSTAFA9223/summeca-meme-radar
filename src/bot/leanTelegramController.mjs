import { env } from '../config/env.mjs';
import { telegramApi } from '../notifiers/telegram.mjs';
import { AppSettings } from '../storage/appSettings.mjs';

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const EVM = /^0x[0-9a-fA-F]{40}$/;

function parseWalletLabels() {
  return String(process.env.TRENCHES_WALLETS ?? '')
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean)
    .map((entry, index) => {
      const [left, right] = entry.includes('|') ? entry.split('|', 2) : entry.includes('=') ? entry.split('=', 2) : [entry, ''];
      if (EVM.test(left)) return String(right || `wallet-${index + 1}`).trim();
      if (EVM.test(right)) return String(left || `wallet-${index + 1}`).trim();
      return `wallet-${index + 1}`;
    });
}

export class LeanTelegramController {
  constructor() {
    this.settings = new AppSettings(env.supabaseUrl, env.supabaseSecretKey);
    this.chatId = '';
    this.language = env.telegramLanguage;
    this.offset = 0;
    this.stopped = true;
    this.walletLabels = parseWalletLabels();
  }

  #pick(ar, en) {
    if (this.language === 'en') return en;
    if (this.language === 'bilingual') return `${ar}\n\n────────────\n\n${en}`;
    return ar;
  }

  async #resolveChatId() {
    if (this.chatId) return this.chatId;
    if (env.telegramChatId) return (this.chatId = String(env.telegramChatId));
    if (this.settings.enabled) {
      this.chatId = String(await this.settings.get('telegram_chat_id').catch(() => '') || '');
      const language = String(await this.settings.get('telegram_language').catch(() => '') || '').toLowerCase();
      if (['ar', 'en', 'bilingual'].includes(language)) this.language = language;
    }
    return this.chatId;
  }

  async #send(text, keyboard) {
    const chatId = await this.#resolveChatId();
    if (!chatId) return null;
    return telegramApi(env.telegramBotToken, 'sendMessage', {
      chat_id: chatId,
      text,
      ...(keyboard ? { reply_markup: { inline_keyboard: keyboard } } : {})
    });
  }

  mainKeyboard() {
    return [
      [{ text: '📊 الحالة', callback_data: 'menu:status' }, { text: '👀 EARLY WATCH', callback_data: 'menu:trending' }],
      [{ text: '💎 TOP-TIER', callback_data: 'menu:signals' }, { text: '🧠 CONFIRMED', callback_data: 'menu:watchlist' }],
      [{ text: '🆕 PRE-LAUNCH', callback_data: 'menu:newcoins' }, { text: '👛 المحافظ', callback_data: 'menu:wallet' }],
      [{ text: '⚙️ الإعدادات', callback_data: 'menu:settings' }, { text: '🛡️ الحماية', callback_data: 'menu:safety' }],
      [{ text: '❓ المساعدة', callback_data: 'menu:help' }]
    ];
  }

  async showMainMenu() {
    return this.#send(this.#pick(
      '🤖 SUMMECA Meme Radar\n\nالمحرك الحالي: ARC ON-CHAIN TRENCHES\n👀 EARLY WATCH = أول دخول موثّق\n💎 TOP-TIER = تجمع محافظ قوي مبكر\n🧠 CONFIRMED = تأكيد السيولة/البيع/الأمان\n\nاختر من القائمة:',
      '🤖 SUMMECA Meme Radar\n\nCurrent engine: ARC ON-CHAIN TRENCHES\n👀 EARLY WATCH = first verified smart-wallet entry\n💎 TOP-TIER = strong early wallet cluster\n🧠 CONFIRMED = liquidity/sell/safety confirmation\n\nChoose an option:'
    ), this.mainKeyboard());
  }

  async #showStatus() {
    const wallets = this.walletLabels.length;
    return this.#send(this.#pick(
      `📊 حالة البوت\n\n🟢 الخدمة: تعمل\n⛓️ الشبكة: Arc\n🧠 المصدر: On-chain wallet driven\n👛 المحافظ المتتبعة: ${wallets}\n👀 PRE-LAUNCH: يعمل\n💎 TOP-TIER: يعمل\n✅ CONFIRMED: يعمل\n🛡️ Anti-spoof: مفعّل\n🚦 RPC Guard: مفعّل\n⚡ الشراء الحقيقي التلقائي: غير مفعّل`,
      `📊 Bot status\n\n🟢 Service: running\n⛓️ Network: Arc\n🧠 Source: on-chain wallet driven\n👛 Tracked wallets: ${wallets}\n👀 PRE-LAUNCH: active\n💎 TOP-TIER: active\n✅ CONFIRMED: active\n🛡️ Anti-spoof: enabled\n🚦 RPC Guard: enabled\n⚡ Automatic live buying: disabled`
    ), [[{ text: '⬅️ القائمة', callback_data: 'menu:home' }]]);
  }

  async #showSettings() {
    return this.#send(this.#pick(
      `⚙️ الإعدادات\n\nاللغة الحالية: ${this.language}\n\nتم حذف مفاتيح تشغيل/إيقاف الماسحات القديمة حتى لا توقف الرصد الجديد بالخطأ.`,
      `⚙️ Settings\n\nCurrent language: ${this.language}\n\nLegacy scanner on/off controls were removed so they cannot accidentally stop the new radar.`
    ), [
      [{ text: '🌐 اللغة', callback_data: 'settings:language' }],
      [{ text: '⬅️ القائمة', callback_data: 'menu:home' }]
    ]);
  }

  async #showLanguage() {
    return this.#send(this.#pick('🌐 اختر اللغة:', '🌐 Choose language:'), [
      [{ text: '🇸🇦 العربية', callback_data: 'lang:ar' }],
      [{ text: '🇬🇧 English', callback_data: 'lang:en' }],
      [{ text: '🌐 عربي + English', callback_data: 'lang:bilingual' }],
      [{ text: '⬅️ الإعدادات', callback_data: 'menu:settings' }]
    ]);
  }

  async #setLanguage(language) {
    if (!['ar', 'en', 'bilingual'].includes(language)) return;
    this.language = language;
    if (this.settings.enabled) await this.settings.set('telegram_language', language).catch(() => {});
    await this.#send(this.#pick('✅ تم تغيير اللغة.', '✅ Language changed.'), [[{ text: '🏠 القائمة', callback_data: 'menu:home' }]]);
  }

  async #showWallets() {
    const names = this.walletLabels.slice(0, 12).map((label, i) => `${i + 1}. ${label}`);
    return this.#send(this.#pick(
      `👛 محافظ Smart Money\n\nعدد المحافظ المتتبعة: ${this.walletLabels.length}\n${names.join('\n') || 'لا توجد محافظ مهيأة.'}\n\nالبوت لا يعتبر التحويل وحده شراءً؛ يلزم إثبات خروج قيمة من المحفظة.`,
      `👛 Smart Money wallets\n\nTracked wallets: ${this.walletLabels.length}\n${names.join('\n') || 'No wallets configured.'}\n\nA transfer alone is not counted as a buy; payer evidence is required.`
    ), [[{ text: '⬅️ القائمة', callback_data: 'menu:home' }]]);
  }

  async #showInfo(data) {
    const map = {
      'menu:trending': [
        '👀 EARLY WATCH\n\nيصل من أول شراء موثّق لمحفظة متتبعة في عقد جديد، حتى لا نفوّت البداية. وهو WATCH وليس تأكيد شراء.',
        '👀 EARLY WATCH\n\nSent from the first verified tracked-wallet buy into a new contract so the start is not missed. It is a watch alert, not a confirmed entry.'
      ],
      'menu:signals': [
        '💎 TOP-TIER\n\nترتفع العملة إلى هذا المستوى عند تجمع محافظ قوية مبكرًا أو وجود دخول كبير موثّق مع فلاتر السوق.',
        '💎 TOP-TIER\n\nA token reaches this level after a strong early wallet cluster or a large verified entry plus market filters.'
      ],
      'menu:watchlist': [
        '🧠 CONFIRMED\n\nأقوى مستوى لدينا: تحقق من المحافظ + السيولة + البيع الحقيقي + عدم التأخر + فحوص الأمان.',
        '🧠 CONFIRMED\n\nOur strongest level: wallet confirmation + liquidity + real sells + early-entry check + safety checks.'
      ],
      'menu:newcoins': [
        '🆕 PRE-LAUNCH\n\nيراقب العقود الجديدة على Arc قبل ظهورها على DEX عندما يكون ذلك ممكنًا، ثم يربطها بدخول المحافظ المتتبعة.',
        '🆕 PRE-LAUNCH\n\nWatches new Arc contracts before DEX appearance when possible, then links them to tracked-wallet activity.'
      ],
      'menu:safety': [
        '🛡️ الحماية\n\nAnti-spoof + إثبات الدفع + سيولة + بيع حقيقي + Market Cap + منع الدخول المتأخر + RPC rate-limit guard.',
        '🛡️ Safety\n\nAnti-spoof + payer proof + liquidity + real sells + market-cap checks + late-entry block + RPC rate-limit guard.'
      ],
      'menu:help': [
        '❓ المساعدة\n\n/start أو /menu — القائمة\n/status — حالة البوت\n/settings — الإعدادات\n/help — المساعدة\n/admin — لوحة المالك\n\nفي الإشارات: 📋 نسخ CA، 🟢 GMGN، 🔥 FOMO، و📊 DEX عند توفره.',
        '❓ Help\n\n/start or /menu — main menu\n/status — bot status\n/settings — settings\n/help — help\n/admin — owner panel\n\nSignal buttons include 📋 Copy CA, 🟢 GMGN, 🔥 FOMO, and 📊 DEX when available.'
      ],
      'menu:trades': [
        '🧪 الصفقات التجريبية القديمة ليست جزءًا من النسخة الخفيفة الحالية. الرادار يركز الآن على الإشارات والمتابعة فقط.',
        '🧪 Legacy paper trades are not part of the current lean build. The radar now focuses on signals and tracking.'
      ]
    };
    const pair = map[data] || map['menu:help'];
    return this.#send(this.#pick(pair[0], pair[1]), [[{ text: '⬅️ القائمة', callback_data: 'menu:home' }]]);
  }

  async #handleMessage(message) {
    if (String(message?.chat?.id ?? '') !== String(this.chatId)) return;
    const text = String(message?.text ?? '').trim();
    if (/^\/(start|menu)(?:@\w+)?\b/i.test(text)) return this.showMainMenu();
    if (/^\/status(?:@\w+)?\b/i.test(text)) return this.#showStatus();
    if (/^\/settings(?:@\w+)?\b/i.test(text)) return this.#showSettings();
    if (/^\/help(?:@\w+)?\b/i.test(text)) return this.#showInfo('menu:help');
  }

  async #handleCallback(callback) {
    const chatId = String(callback?.message?.chat?.id ?? '');
    if (!callback?.id || chatId !== String(this.chatId)) return;
    const data = String(callback?.data ?? '');
    await telegramApi(env.telegramBotToken, 'answerCallbackQuery', { callback_query_id: callback.id }).catch(() => {});

    if (data === 'menu:home') return this.showMainMenu();
    if (data === 'menu:status') return this.#showStatus();
    if (data === 'menu:settings') return this.#showSettings();
    if (data === 'settings:language') return this.#showLanguage();
    if (data === 'menu:wallet') return this.#showWallets();
    if (data.startsWith('lang:')) return this.#setLanguage(data.slice(5));
    if (['menu:trending', 'menu:signals', 'menu:watchlist', 'menu:newcoins', 'menu:safety', 'menu:help', 'menu:trades'].includes(data)) {
      return this.#showInfo(data);
    }

    if (data === 'settings:alerts' || data === 'settings:scanner') {
      return this.#send(this.#pick(
        'ℹ️ هذا زر من النسخة القديمة. في النسخة الجديدة لا نوقف محرك الرصد من تيليجرام حتى لا تضيع فرص العملات.',
        'ℹ️ This is a legacy control. The new build does not pause the radar from Telegram so opportunities are not missed.'
      ), [[{ text: '⬅️ الإعدادات', callback_data: 'menu:settings' }]]);
    }

    if (data.startsWith('paper:') || data.startsWith('live:')) {
      return this.#send(this.#pick(
        'ℹ️ زر تداول قديم. النسخة الحالية ترسل إشارات فقط ولا تنفذ شراءً حقيقيًا تلقائيًا.',
        'ℹ️ Legacy trading button. The current build sends signals only and does not execute automatic live buys.'
      ), [[{ text: '🏠 القائمة', callback_data: 'menu:home' }]]);
    }
  }

  async #loop() {
    while (!this.stopped) {
      try {
        const updates = await telegramApi(env.telegramBotToken, 'getUpdates', {
          offset: this.offset,
          timeout: 20,
          limit: 50,
          allowed_updates: ['message', 'callback_query']
        });
        for (const update of Array.isArray(updates) ? updates : []) {
          this.offset = Math.max(this.offset, Number(update?.update_id ?? 0) + 1);
          if (update?.callback_query) await this.#handleCallback(update.callback_query);
          else if (update?.message) await this.#handleMessage(update.message);
        }
      } catch (error) {
        console.warn('[telegram:lean-controller]', error.message);
        await wait(2_000);
      }
    }
  }

  async start() {
    if (!env.telegramBotToken) {
      console.warn('[telegram:lean-controller] disabled — TELEGRAM_BOT_TOKEN missing');
      return false;
    }
    await this.#resolveChatId();
    if (!this.chatId) {
      console.warn('[telegram:lean-controller] disabled — telegram chat id not configured');
      return false;
    }

    await telegramApi(env.telegramBotToken, 'setMyCommands', {
      commands: [
        { command: 'start', description: 'فتح قائمة SUMMECA' },
        { command: 'menu', description: 'القائمة الرئيسية' },
        { command: 'status', description: 'حالة البوت' },
        { command: 'settings', description: 'الإعدادات' },
        { command: 'help', description: 'المساعدة' },
        { command: 'admin', description: 'لوحة المالك' }
      ]
    }).catch((error) => console.warn('[telegram:set-commands]', error.message));

    this.stopped = false;
    console.log(`[telegram:lean-controller] active chat=${String(this.chatId).slice(0, 4)}… language=${this.language}`);
    void this.#loop();
    return true;
  }

  stop() { this.stopped = true; }
}

let singleton = null;
export async function startLeanTelegramController() {
  if (!singleton) singleton = new LeanTelegramController();
  await singleton.start();
  return singleton;
}
