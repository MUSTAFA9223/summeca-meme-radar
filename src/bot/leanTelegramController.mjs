import { env } from '../config/env.mjs';
import { telegramApi } from '../notifiers/telegram.mjs';
import { AppSettings } from '../storage/appSettings.mjs';
import { TradingTerminal } from './tradingTerminal.mjs';
import { handlePhase8Callback, handlePhase8Message } from './phase8OwnerFlows.mjs';

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
    this.terminal = new TradingTerminal(this.settings);
    this.chatId = '';
    this.language = 'ar';
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
      this.language = 'ar';
    }
    return this.chatId;
  }

  async #send(text, keyboard) {
    const chatId = await this.#resolveChatId();
    if (!chatId) return null;
    return telegramApi(env.telegramBotToken, 'sendMessage', {
      chat_id: chatId,
      text,
      ...(Array.isArray(keyboard) && keyboard.length ? { reply_markup: { inline_keyboard: keyboard } } : {})
    });
  }

  async #sendTerminal(result) {
    if (!result?.text) return null;
    return this.#send(result.text, result.keyboard);
  }

  async #runTerminalAction(data) {
    const result = await this.terminal.handle(data);
    if (result?.handled) return this.#sendTerminal(result);
    return null;
  }

  mainKeyboard() {
    return [
      [{ text: '📊 حالة البوت', callback_data: 'menu:status' }, { text: '🌐 الشبكات', callback_data: 'menu:networks' }],
      [{ text: '👀 مراقبة مبكرة', callback_data: 'menu:trending' }, { text: '💎 أقوى الإشارات', callback_data: 'menu:signals' }],
      [{ text: '🧠 إشارات مؤكدة', callback_data: 'menu:watchlist' }, { text: '🆕 عملات جديدة', callback_data: 'menu:newcoins' }],
      [{ text: '💱 التداول', callback_data: 'menu:trading' }, { text: '📊 المراكز', callback_data: 'term:p' }],
      [{ text: '📋 الأوامر', callback_data: 'p3:o' }, { text: '🧠 نسخ التداول', callback_data: 'p8:copy' }],
      [{ text: '👀 قائمة المتابعة', callback_data: 'p8:watch' }, { text: '👛 محفظتي', callback_data: 'p8:wallets' }],
      [{ text: '🛡️ الحماية', callback_data: 'menu:safety' }, { text: '⚙️ الإعدادات', callback_data: 'menu:settings' }],
      [{ text: '❓ المساعدة', callback_data: 'menu:help' }]
    ];
  }

  async showMainMenu() {
    return this.#send(this.#pick(
      '🤖 رادار SUMMECA للتداول\n\n🌐 Arc + Solana + BNB Chain + Robinhood Chain\n⚡ رصد مبكر + فلترة جودة + محافظ ذكية\n🔎 تحليل العقد من داخل تيليجرام\n💱 معاينة شراء/بيع مع تأكيد نهائي\n🎯 أوامر محددة + شراء دوري + فحص القنص\n📊 المراكز وإدارة الربح والخسارة التجريبية\n\n👛 يمكنك إنشاء محفظة تداول داخل البوت من زر «محفظتي».\n🔒 لا يتم إرسال أي صفقة حقيقية دون بوابات الأمان والتأكيد الحالية.',
      '🤖 SUMMECA Trading Radar\n\n🌐 Arc + Solana + BNB Chain + Robinhood Chain\n⚡ Early detection + quality filters + محفظة ذكية\n🔎 In-Telegram token analysis\n💱 Buy/Sell preview with final confirmation\n🎯 Limit + DCA + Sniper Check\n📊 Positions and TP/SL/Trailing in Paper Mode\n\n🔒 Live execution from the safe Terminal is currently disabled.'
    ), this.mainKeyboard());
  }

  async #showStatus() {
    const wallets = this.walletLabels.length;
    return this.#send(this.#pick(
      `📊 حالة البوت\n\n🟢 الخدمة: تعمل\n🌐 الشبكات: 4\n✅ Arc — PRE-LAUNCH + محفظة ذكية\n✅ Solana — Pump.fun Ultra-Early + Quality Filter\n✅ BNB Chain — محفظة ذكية + block scan\n✅ Robinhood Chain — محفظة ذكية + Early Market\n👛 محافظ EVM الأساسية: ${wallets}\n🛡️ Anti-spoof: مفعّل\n🚦 Rate-limit guards: مفعّلة\n💱 منصة التداول: تحليل + Paper + Limit/DCA/Sniper\n🔒 Live execution: ${env.liveTradingEnabled ? 'المحرك مهيأ لكن Terminal الآمن لا ينفذ معاملات' : 'مقفل'}`,
      `📊 Bot status\n\n🟢 Service: running\n🌐 Networks: 4\n✅ Arc — PRE-LAUNCH + محفظة ذكية\n✅ Solana — Pump.fun Ultra-Early + Quality Filter\n✅ BNB Chain — محفظة ذكية + block scan\n✅ Robinhood Chain — محفظة ذكية + Early Market\n👛 Base EVM wallets: ${wallets}\n🛡️ Anti-spoof: enabled\n🚦 Rate-limit guards: enabled\n💱 منصة التداول: analysis + Paper + Limit/DCA/Sniper\n🔒 Live execution: ${env.liveTradingEnabled ? 'engine configured, but safe Terminal does not broadcast transactions' : 'locked'}`
    ), [[{ text: '📊 المراكز', callback_data: 'term:p' }, { text: '📋 الأوامر', callback_data: 'p3:o' }], [{ text: '⬅️ القائمة', callback_data: 'menu:home' }]]);
  }

  async #showTrading() {
    return this.#send(this.#pick(
      '💱 منصة التداول داخل SUMMECA\n\nمن أي إشارة عملة ستجد:\n🔎 تحليل — السعر والسيولة والقيمة السوقية والشراء/البيع وتركيز الحيازة\n🟢 شراء / 🔴 بيع — معاينة ثم تأكيد\n🎯 جني الربح / وقف الخسارة / الوقف المتحرك\n🎯 أمر محدد / 📆 شراء دوري — أوامر تجريبية تتم مراقبتها آليًا\n⚡ القنص — فحص نجاح/فشل ثم تأكيد يدوي\n🧠 نسخ التداول — محافظ متتبعة + مبلغ ثابت أو نسبة\n\nأي تنفيذ حقيقي يظل خاضعًا لبوابات الأمان والتأكيد.',
      '💱 SUMMECA منصة التداول\n\nEvery token alert can provide:\n🔎 Analysis — price, liquidity, MC, Buy/Sell and Solana top-account concentration\n🟢 Buy / 🔴 Sell — Paper preview + confirmation\n🎯 TP/SL/Trailing — Paper risk management\n🎯 Limit / 📆 DCA — monitored Paper orders\n⚡ Sniper — Pass/Fail check then manual confirmation\n🧠 Copy Trading — dynamic tracked wallets + fixed/percentage sizing\n\nNo real transaction is signed or broadcast from this interface.'
    ), [
      [{ text: '📊 المراكز', callback_data: 'term:p' }, { text: '📋 الأوامر', callback_data: 'p3:o' }],
      [{ text: '🧠 نسخ التداول', callback_data: 'p8:copy' }, { text: '👛 محفظتي', callback_data: 'p8:wallets' }],
      [{ text: '⬅️ القائمة', callback_data: 'menu:home' }]
    ]);
  }

  async #showSettings() {
    return this.#send(this.#pick(
      '⚙️ الإعدادات\n\nاللغة: العربية\nالرادار يعمل دائمًا في الخلفية حتى لا تضيع الفرص.\nمنصة التداول تستخدم طبقات الأمان والتأكيد الحالية.',
      `⚙️ Settings\n\nCurrent language: ${this.language}\nThe radar remains active in the background so opportunities are not missed.\nمنصة التداول currently uses Paper/Safe Mode for testing.`
    ), [
      [{ text: '🌐 اللغة', callback_data: 'settings:language' }],
      [{ text: '⚙️ مبالغ الشراء', callback_data: 'adv:pre' }, { text: '📋 الأوامر', callback_data: 'p3:o' }],
      [{ text: '⬅️ القائمة', callback_data: 'menu:home' }]
    ]);
  }

  async #showLanguage() {
    return this.#send('🇸🇦 لغة البوت مضبوطة على العربية بالكامل.', [
      [{ text: '⬅️ الإعدادات', callback_data: 'menu:settings' }]
    ]);
  }

  async #setLanguage() {
    this.language = 'ar';
    if (this.settings.enabled) await this.settings.set('telegram_language', 'ar').catch(() => {});
    return this.#send('✅ لغة البوت هي العربية.', [[{ text: '🏠 القائمة', callback_data: 'menu:home' }]]);
  }

  async #showWallets() {
    const names = this.walletLabels.slice(0, 12).map((label, i) => `${i + 1}. ${label}`);
    return this.#send(this.#pick(
      `👛 الأموال الذكية\n\nمحافظ EVM المتتبعة: ${this.walletLabels.length}\n${names.join('\n') || 'لا توجد محافظ مهيأة.'}\n\nArc وBNB وRobinhood تستخدم Anti-spoof.\nSolana تعتمد حاليًا Pump.fun Ultra-Early + تحليل السوق والحيازة، ولن نسمي حسابًا محفظة ذكية دون سجل مثبت.`,
      `👛 الأموال الذكية\n\nTracked EVM wallets: ${this.walletLabels.length}\n${names.join('\n') || 'No wallets configured.'}\n\nArc, BNB and Robinhood use anti-spoof checks.\nSolana currently uses Pump.fun Ultra-Early + market/holder analysis; no account is labeled محفظة ذكية without evidence.`
    ), [[{ text: '🧠 Copy Dashboard', callback_data: 'p3:c' }, { text: '👛 Wallet', callback_data: 'adv:w' }], [{ text: '⬅️ القائمة', callback_data: 'menu:home' }]]);
  }

  async #showInfo(data) {
    const map = {
      'menu:networks': [
        '🌐 الشبكات\n\n🔷 Arc: عقود جديدة + محفظة ذكية + PRE-DEX\n🟣 Solana: Pump.fun لحظيًا + فلتر جودة وحيازة\n🟡 BNB Chain: محفظة ذكية + block scan\n🟢 Robinhood Chain: محفظة ذكية + Early Market\n\nكل إشارة تكتب اسم الشبكة بوضوح.',
        '🌐 Networks\n\n🔷 Arc: new contracts + محفظة ذكية + PRE-DEX\n🟣 Solana: live Pump.fun + quality/holder filter\n🟡 BNB Chain: محفظة ذكية + block scan\n🟢 Robinhood Chain: محفظة ذكية + Early Market\n\nEvery alert clearly labels its network.'
      ],
      'menu:trending': [
        '👀 EARLY WATCH\n\nرصد مبكر بعد ظهور أدلة سوق أو محافظ كافية، مع إبقاء العقود الأضعف تحت المراقبة بصمت.',
        '👀 EARLY WATCH\n\nEarly monitoring after enough market/wallet evidence appears; weaker contracts remain silently monitored.'
      ],
      'menu:signals': [
        '💎 TOP-TIER\n\nأقوى طبقة إشارات لدينا: شروط جودة أعلى مع بقاء العملة مبكرة. لا تعني ضمان الصعود.',
        '💎 TOP-TIER\n\nOur strongest signal tier: higher-quality evidence while the token is still early. It is not a guarantee of price appreciation.'
      ],
      'menu:watchlist': [
        '🧠 CONFIRMED\n\nتأكيد إضافي عندما تتوفر بيانات كافية: سيولة وبيع حقيقي ومحافظ وفحوص أمان.',
        '🧠 CONFIRMED\n\nAdditional confirmation when enough data exists: liquidity, real sells, wallets and safety checks.'
      ],
      'menu:newcoins': [
        '🆕 PRE-LAUNCH / NEW LAUNCH\n\nالرادار يلتقط العقود في الخلفية مبكرًا، لكن تيليجرام لا يرسل كل عقد خام حتى لا يغرقك بالإشعارات.',
        '🆕 PRE-LAUNCH / NEW LAUNCH\n\nThe radar catches contracts early in the background, but Telegram does not send every raw contract to avoid notification spam.'
      ],
      'menu:safety': [
        '🛡️ الحماية\n\nAnti-spoof + السيولة + Buy/Sell + Market Cap + منع الدخول المتأخر + تركّز حيازة Solana + Rate-limit guards.\n\nالفلاتر تقلل المخاطر لكنها لا تضمن الربح.',
        '🛡️ Safety\n\nAnti-spoof + liquidity + Buy/Sell + market cap + late-entry protection + Solana concentration checks + rate-limit guards.\n\nFilters reduce risk but do not guarantee profit.'
      ],
      'menu:help': [
        '❓ المساعدة\n\n/start أو /menu — القائمة الرئيسية\n/status — حالة البوت\n/trade — منصة التداول\n/positions — المراكز\n/orders — الأوامر المحددة والشراء الدوري\n/copy — نسخ التداول\n/watch — العملات تحت المتابعة\n/wallets — محفظتي ومحافظ التداول\n/settings — الإعدادات\n/admin — لوحة المالك\n\nافتح أي إشارة واستخدم تحليل / شراء / بيع / جني الربح ووقف الخسارة / أمر محدد / شراء دوري / قنص.',
        '❓ Help\n\n/start or /menu — main menu\n/status — bot status\n/trade — منصة التداول\n/positions — المراكز التجريبية\n/orders — Limit/DCA Orders\n/copy — نسخ التداول\n/watch — tracked tokens\n/wallets — trading wallets\n/settings — settings\n/admin — owner panel\n\nOpen any alert and use Analyse / Buy / Sell / TP-SL / Limit / DCA / Sniper directly.'
      ]
    };
    const pair = map[data] || map['menu:help'];
    return this.#send(this.#pick(pair[0], pair[1]), [[{ text: '⬅️ القائمة', callback_data: 'menu:home' }]]);
  }

  async #handleMessage(message) {
    if (String(message?.chat?.id ?? '') !== String(this.chatId)) return;
    const text = String(message?.text ?? '').trim();
    const phase8 = await handlePhase8Message(message, this.terminal).catch((error) => ({ handled: true, text: `❌ خطأ في إدارة المتابعة والمحافظ: ${String(error?.message ?? error).slice(0, 180)}`, keyboard: [] }));
    if (phase8?.handled) return this.#sendTerminal(phase8);
    if (/^\/(start|menu)(?:@\w+)?\b/i.test(text)) return this.showMainMenu();
    if (/^\/status(?:@\w+)?\b/i.test(text)) return this.#showStatus();
    if (/^\/settings(?:@\w+)?\b/i.test(text)) return this.#showSettings();
    if (/^\/help(?:@\w+)?\b/i.test(text)) return this.#showInfo('menu:help');
    if (/^\/trade(?:@\w+)?\b/i.test(text)) return this.#showTrading();
    if (/^\/positions(?:@\w+)?\b/i.test(text)) return this.#sendTerminal(await this.terminal.positions());
    if (/^\/orders(?:@\w+)?\b/i.test(text)) return this.#runTerminalAction('p3:o');
    if (/^\/copy(?:@\w+)?\b/i.test(text)) return this.#runTerminalAction('p3:c');
  }

  async #handleCallback(callback) {
    const chatId = String(callback?.message?.chat?.id ?? '');
    if (!callback?.id || chatId !== String(this.chatId)) return;
    const data = String(callback?.data ?? '');
    await telegramApi(env.telegramBotToken, 'answerCallbackQuery', { callback_query_id: callback.id }).catch(() => {});

    if (data.startsWith('watch:add:') || data.startsWith('p8:') || data.startsWith('p8f:') || data.startsWith('p8p:') || data.startsWith('p8s:')) {
      const result = await handlePhase8Callback(callback, this.terminal).catch((error) => ({ handled: true, text: `❌ خطأ في إدارة المتابعة والمحافظ: ${String(error?.message ?? error).slice(0, 180)}`, keyboard: [] }));
      if (result?.handled) return this.#sendTerminal(result);
    }

    if (data.startsWith('term:') || data.startsWith('adv:') || data.startsWith('p3:')) {
      const result = await this.terminal.handle(data);
      if (result?.handled) return this.#sendTerminal(result);
    }

    if (data === 'menu:home') return this.showMainMenu();
    if (data === 'menu:status') return this.#showStatus();
    if (data === 'menu:trading') return this.#showTrading();
    if (data === 'menu:settings') return this.#showSettings();
    if (data === 'settings:language') return this.#showLanguage();
    if (data === 'menu:wallet') return this.#showWallets();
    if (data.startsWith('lang:')) return this.#setLanguage(data.slice(5));
    if (['menu:networks', 'menu:trending', 'menu:signals', 'menu:watchlist', 'menu:newcoins', 'menu:safety', 'menu:help'].includes(data)) {
      return this.#showInfo(data);
    }

    if (data === 'menu:trades') return this.#sendTerminal(await this.terminal.positions());

    if (data === 'settings:alerts' || data === 'settings:scanner') {
      return this.#send(this.#pick(
        'ℹ️ الرادار لا يُوقف من تيليجرام في النسخة الحالية حتى لا تضيع العقود المبكرة.',
        'ℹ️ The radar is not paused from Telegram in the current build so early contracts are not missed.'
      ), [[{ text: '⬅️ الإعدادات', callback_data: 'menu:settings' }]]);
    }

    if (data.startsWith('paper:') || data.startsWith('live:')) {
      return this.#send(this.#pick(
        'ℹ️ هذا زر من النسخة القديمة. استخدم منصة التداول الجديد؛ التداول الحقيقي من Terminal ما زال مقفولًا، وPaper Mode متاح للاختبار.',
        'ℹ️ This is a legacy button. Use the new منصة التداول; live execution is locked, while Paper Mode is available for testing.'
      ), [[{ text: '💱 التداول', callback_data: 'menu:trading' }, { text: '📊 المراكز', callback_data: 'term:p' }]]);
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
        { command: 'trade', description: 'منصة التداول' },
        { command: 'positions', description: 'المراكز والمحفظة' },
        { command: 'orders', description: 'الأوامر المحددة والشراء الدوري' },
        { command: 'copy', description: 'نسخ التداول' },
        { command: 'copywallet', description: 'إضافة ومتابعة محافظ المتداولين' },
        { command: 'watch', description: 'قائمة العملات تحت المتابعة' },
        { command: 'wallets', description: 'محافظ التداول داخل البوت' },
        { command: 'settings', description: 'الإعدادات' },
        { command: 'help', description: 'المساعدة' },
        { command: 'admin', description: 'لوحة المالك' }
      ]
    }).catch((error) => console.warn('[telegram:set-commands]', error.message));

    this.stopped = false;
    console.log(`[telegram:lean-controller] active chat=${String(this.chatId).slice(0, 4)}… language=${this.language} terminal=on callbacks=term+adv+p3 liveBroadcast=off`);
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
