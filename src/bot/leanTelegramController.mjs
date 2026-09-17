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
      [{ text: '📊 الحالة', callback_data: 'menu:status' }, { text: '🌐 الشبكات', callback_data: 'menu:networks' }],
      [{ text: '👀 EARLY WATCH', callback_data: 'menu:trending' }, { text: '💎 TOP-TIER', callback_data: 'menu:signals' }],
      [{ text: '🧠 CONFIRMED', callback_data: 'menu:watchlist' }, { text: '🆕 PRE-LAUNCH', callback_data: 'menu:newcoins' }],
      [{ text: '👛 المحافظ', callback_data: 'menu:wallet' }, { text: '🛡️ الحماية', callback_data: 'menu:safety' }],
      [{ text: '⚙️ الإعدادات', callback_data: 'menu:settings' }, { text: '❓ المساعدة', callback_data: 'menu:help' }]
    ];
  }

  async showMainMenu() {
    return this.#send(this.#pick(
      '🤖 SUMMECA Meme Radar\n\n🌐 المحرك: MULTICHAIN LEAN\n⛓️ Arc + Solana + BNB Chain + Robinhood Chain\n👀 EARLY WATCH = رصد البداية\n💎 TOP-TIER = شروط أقوى مبكرًا\n🧠 CONFIRMED = تأكيد السيولة/البيع/الأمان حيث تتوفر بيانات التأكيد\n\nاختر من القائمة:',
      '🤖 SUMMECA Meme Radar\n\n🌐 Engine: MULTICHAIN LEAN\n⛓️ Arc + Solana + BNB Chain + Robinhood Chain\n👀 EARLY WATCH = detect the start\n💎 TOP-TIER = stronger early conditions\n🧠 CONFIRMED = liquidity/sell/safety confirmation where confirmation data is available\n\nChoose an option:'
    ), this.mainKeyboard());
  }

  async #showStatus() {
    const wallets = this.walletLabels.length;
    return this.#send(this.#pick(
      `📊 حالة البوت\n\n🟢 الخدمة: تعمل\n🌐 الشبكات: 4\n✅ Arc — On-chain + PRE-LAUNCH + Smart Wallet\n✅ Solana — Pump.fun launch stream + DEX market confirmation\n✅ BNB Chain — Smart Wallet + Early Market\n✅ Robinhood Chain — Smart Wallet + Early Market\n👛 محافظ EVM الأساسية: ${wallets}\n🛡️ Anti-spoof: مفعّل للمحافظ\n🚦 Rate-limit guards: مفعّلة\n⚡ الشراء الحقيقي التلقائي: غير مفعّل`,
      `📊 Bot status\n\n🟢 Service: running\n🌐 Networks: 4\n✅ Arc — on-chain + PRE-LAUNCH + Smart Wallet\n✅ Solana — Pump.fun launch stream + DEX market confirmation\n✅ BNB Chain — Smart Wallet + Early Market\n✅ Robinhood Chain — Smart Wallet + Early Market\n👛 Base EVM wallets: ${wallets}\n🛡️ Anti-spoof: enabled for wallet signals\n🚦 Rate-limit guards: enabled\n⚡ Automatic live buying: disabled`
    ), [[{ text: '⬅️ القائمة', callback_data: 'menu:home' }]]);
  }

  async #showSettings() {
    return this.#send(this.#pick(
      `⚙️ الإعدادات\n\nاللغة الحالية: ${this.language}\n\nالمحركات القديمة الثقيلة غير محمّلة. الشبكات الأربع تعمل عبر النسخة الخفيفة الجديدة.`,
      `⚙️ Settings\n\nCurrent language: ${this.language}\n\nLegacy heavy scanners are not loaded. The four networks run through the new lean build.`
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
      `👛 محافظ Smart Money\n\nمحافظ EVM الأساسية: ${this.walletLabels.length}\n${names.join('\n') || 'لا توجد محافظ مهيأة.'}\n\nتُراقب على Arc وBNB وRobinhood مع Anti-spoof.\nSolana تستخدم حاليًا رصد Pump.fun المباشر + تأكيد السوق؛ ولن نسمي أي حركة فيها Smart Wallet قبل إضافة/إثبات محافظ Solana مستقلة.`,
      `👛 Smart Money wallets\n\nBase EVM wallets: ${this.walletLabels.length}\n${names.join('\n') || 'No wallets configured.'}\n\nThey are monitored on Arc, BNB and Robinhood with anti-spoof checks.\nSolana currently uses direct Pump.fun launch detection + market confirmation; it is not labeled Smart Wallet until separate Solana wallets are verified.`
    ), [[{ text: '⬅️ القائمة', callback_data: 'menu:home' }]]);
  }

  async #showInfo(data) {
    const map = {
      'menu:networks': [
        '🌐 الشبكات\n\n🔷 Arc: عقود جديدة + محافظ + PRE-DEX + CONFIRMED\n🟣 Solana: إنشاء Pump.fun لحظيًا + فحص DexScreener مجمّع + EARLY/TOP-TIER\n🟡 BNB Chain: محافظ EVM + Anti-spoof + أسواق جديدة\n🟢 Robinhood Chain: محافظ EVM + Anti-spoof + أسواق جديدة\n\nكل إشارة تكتب اسم الشبكة بوضوح.',
        '🌐 Networks\n\n🔷 Arc: new contracts + wallets + PRE-DEX + CONFIRMED\n🟣 Solana: live Pump.fun creates + batched DexScreener validation + EARLY/TOP-TIER\n🟡 BNB Chain: EVM wallets + anti-spoof + new markets\n🟢 Robinhood Chain: EVM wallets + anti-spoof + new markets\n\nEvery alert clearly labels its network.'
      ],
      'menu:trending': [
        '👀 EARLY WATCH\n\nيصل عند ظهور دليل مبكر مناسب للشبكة: شراء محفظة موثّق في شبكات EVM، أو إطلاق Solana جديد بدأ يحقق نشاط سوق حقيقي.',
        '👀 EARLY WATCH\n\nSent when a network-appropriate early signal appears: verified wallet participation on EVM networks, or a fresh Solana launch with real market activity.'
      ],
      'menu:signals': [
        '💎 TOP-TIER\n\nيتطلب شروطًا أقوى مثل تجمع محافظ أو سيولة/شراء/بيع أقوى مع بقاء العملة مبكرة.',
        '💎 TOP-TIER\n\nRequires stronger evidence such as a wallet cluster or stronger liquidity/buy/sell activity while the token is still early.'
      ],
      'menu:watchlist': [
        '🧠 CONFIRMED\n\nأقوى تأكيد عندما تتوفر بيانات كافية: محافظ + سيولة + بيع حقيقي + منع الدخول المتأخر + فحوص الأمان.',
        '🧠 CONFIRMED\n\nStrongest confirmation where enough data exists: wallets + liquidity + real sells + late-entry checks + safety filters.'
      ],
      'menu:newcoins': [
        '🆕 PRE-LAUNCH / NEW LAUNCH\n\nArc يرصد العقود قبل DEX عندما يمكن ذلك. Solana يلتقط إنشاءات Pump.fun مباشرة. BNB وRobinhood يراقبان الأسواق الجديدة إضافة إلى نشاط المحافظ.',
        '🆕 PRE-LAUNCH / NEW LAUNCH\n\nArc watches contracts before DEX appearance when possible. Solana catches Pump.fun creates directly. BNB and Robinhood watch new markets plus wallet activity.'
      ],
      'menu:safety': [
        '🛡️ الحماية\n\nAnti-spoof للمحافظ + إثبات مشاركة الدافع + سيولة + بيع حقيقي + Market Cap + منع الدخول المتأخر + Rate-limit guards.\n\nلا يوجد فلتر يضمن الربح.',
        '🛡️ Safety\n\nWallet anti-spoof + payer participation proof + liquidity + real sells + market cap + late-entry protection + rate-limit guards.\n\nNo filter guarantees profit.'
      ],
      'menu:help': [
        '❓ المساعدة\n\n/start أو /menu — القائمة\n/status — حالة البوت والشبكات\n/settings — الإعدادات\n/help — المساعدة\n/admin — لوحة المالك\n\nالإشارات تعرض الشبكة وCA قابلًا للنسخ وروابط السوق المناسبة عند توفرها.',
        '❓ Help\n\n/start or /menu — main menu\n/status — bot/network status\n/settings — settings\n/help — help\n/admin — owner panel\n\nAlerts show the network, copyable CA, and appropriate market links when available.'
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
    if (['menu:networks', 'menu:trending', 'menu:signals', 'menu:watchlist', 'menu:newcoins', 'menu:safety', 'menu:help', 'menu:trades'].includes(data)) {
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
