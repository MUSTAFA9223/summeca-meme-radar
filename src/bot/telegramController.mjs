import { normalizeTelegramLanguage, telegramApi } from '../notifiers/telegram.mjs';

const SOLANA_ADDRESS = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
const short = (value) => value ? `${value.slice(0, 5)}…${value.slice(-5)}` : '—';
const yesNo = (value, ar = true) => ar ? (value ? 'نعم' : 'لا') : (value ? 'Yes' : 'No');

export class TelegramController {
  constructor({ token, chatId, notifier, settings, store, runtime, heliusApiKey }) {
    this.token = token;
    this.chatId = String(chatId ?? '');
    this.notifier = notifier;
    this.settings = settings;
    this.store = store;
    this.runtime = runtime;
    this.heliusApiKey = heliusApiKey ?? '';
    this.offset = 0;
    this.stopped = true;
    this.awaitingWallet = false;
  }

  get enabled() { return Boolean(this.token && this.chatId); }

  #pick(ar, en) {
    if (this.runtime.language === 'en') return en;
    if (this.runtime.language === 'bilingual') return `${ar}\n\n────────────\n\n${en}`;
    return ar;
  }

  async #send(text, inlineKeyboard) {
    const body = { chat_id: this.chatId, text };
    if (inlineKeyboard) body.reply_markup = { inline_keyboard: inlineKeyboard };
    return telegramApi(this.token, 'sendMessage', body);
  }

  async #answerCallback(id, text = '') {
    if (!id) return;
    await telegramApi(this.token, 'answerCallbackQuery', { callback_query_id: id, text }).catch(() => {});
  }

  mainKeyboard() {
    return [
      [{ text: '📊 الحالة', callback_data: 'menu:status' }, { text: '🔥 آخر الإشارات', callback_data: 'menu:signals' }],
      [{ text: '🧪 الصفقات التجريبية', callback_data: 'menu:trades' }, { text: '👛 المحفظة', callback_data: 'menu:wallet' }],
      [{ text: '⚙️ الإعدادات', callback_data: 'menu:settings' }, { text: '🛡️ الحماية', callback_data: 'menu:safety' }],
      [{ text: '❓ المساعدة', callback_data: 'menu:help' }]
    ];
  }

  async showMainMenu() {
    return this.#send(this.#pick(
      '🤖 SUMMECA Meme Radar\n\nاختر من لوحة التحكم:',
      '🤖 SUMMECA Meme Radar\n\nChoose from the control panel:'
    ), this.mainKeyboard());
  }

  async #showStatus() {
    const ar = [
      '📊 حالة الرادار', '',
      `الرادار: ${this.runtime.scannerPaused ? '⏸️ متوقف مؤقتًا' : '🟢 يعمل'}`,
      `التنبيهات: ${this.runtime.alertsEnabled ? '🔔 مفعلة' : '🔕 متوقفة'}`,
      `اللغة: ${this.runtime.language}`,
      `التداول الحقيقي: 🔒 مغلق`,
      `الوضع: 🧪 تداول تجريبي فقط`,
      `المحفظة مرتبطة: ${yesNo(Boolean(this.runtime.walletAddress))}`,
      `المحفظة: ${short(this.runtime.walletAddress)}`
    ].join('\n');
    const en = [
      '📊 Radar status', '',
      `Scanner: ${this.runtime.scannerPaused ? '⏸️ Paused' : '🟢 Running'}`,
      `Alerts: ${this.runtime.alertsEnabled ? '🔔 Enabled' : '🔕 Disabled'}`,
      `Language: ${this.runtime.language}`,
      'Live trading: 🔒 Locked',
      'Mode: 🧪 Paper trading only',
      `Wallet linked: ${yesNo(Boolean(this.runtime.walletAddress), false)}`,
      `Wallet: ${short(this.runtime.walletAddress)}`
    ].join('\n');
    return this.#send(this.#pick(ar, en), [[{ text: '⬅️ القائمة', callback_data: 'menu:home' }]]);
  }

  async #showSettings() {
    const text = this.#pick(
      '⚙️ الإعدادات\n\nيمكنك تغيير اللغة، التنبيهات، وتشغيل/إيقاف الرادار من هنا.',
      '⚙️ Settings\n\nChange language, alerts, and pause/resume the scanner here.'
    );
    return this.#send(text, [
      [{ text: '🌐 اللغة', callback_data: 'settings:language' }],
      [{ text: this.runtime.alertsEnabled ? '🔕 إيقاف التنبيهات' : '🔔 تشغيل التنبيهات', callback_data: 'settings:alerts' }],
      [{ text: this.runtime.scannerPaused ? '▶️ تشغيل الرادار' : '⏸️ إيقاف الرادار مؤقتًا', callback_data: 'settings:scanner' }],
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

  async #showWallet() {
    const linked = Boolean(this.runtime.walletAddress);
    let balance = null;
    if (linked && this.heliusApiKey) {
      try { balance = await this.#getSolBalance(this.runtime.walletAddress); } catch {}
    }
    const ar = [
      '👛 المحفظة', '',
      `الحالة: ${linked ? '✅ مرتبطة للقراءة فقط' : '❌ غير مرتبطة'}`,
      linked ? `العنوان: ${this.runtime.walletAddress}` : '',
      balance != null ? `الرصيد: ${balance.toFixed(5)} SOL` : '',
      '',
      '🔒 لا ترسل Seed Phrase أو Private Key للبوت مطلقًا.',
      'ربط العنوان الحالي للعرض والمراقبة فقط؛ التداول الحقيقي ما زال مقفولًا.'
    ].filter(Boolean).join('\n');
    const en = [
      '👛 Wallet', '',
      `Status: ${linked ? '✅ Linked read-only' : '❌ Not linked'}`,
      linked ? `Address: ${this.runtime.walletAddress}` : '',
      balance != null ? `Balance: ${balance.toFixed(5)} SOL` : '',
      '',
      '🔒 Never send a seed phrase or private key to the bot.',
      'This wallet link is read-only; live trading remains locked.'
    ].filter(Boolean).join('\n');
    return this.#send(this.#pick(ar, en), [
      [{ text: linked ? '🔄 تغيير المحفظة' : '🔗 ربط محفظة', callback_data: 'wallet:link' }],
      [{ text: '🔄 تحديث الرصيد', callback_data: 'wallet:show' }],
      ...(linked ? [[{ text: '❌ فصل المحفظة', callback_data: 'wallet:disconnect' }]] : []),
      [{ text: '🔒 التداول الحقيقي', callback_data: 'wallet:live' }],
      [{ text: '⬅️ القائمة', callback_data: 'menu:home' }]
    ]);
  }

  async #getSolBalance(address) {
    const endpoint = `https://mainnet.helius-rpc.com/?api-key=${encodeURIComponent(this.heliusApiKey)}`;
    const response = await fetch(endpoint, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'getBalance', params: [address] })
    });
    if (!response.ok) throw new Error(`Helius HTTP ${response.status}`);
    const body = await response.json();
    if (body.error) throw new Error(body.error.message);
    return Number(body?.result?.value ?? 0) / 1_000_000_000;
  }

  async #showSignals() {
    let rows = [];
    try { rows = await this.store.listRecentSignals(5); } catch {}
    if (!rows.length) {
      return this.#send(this.#pick('🔥 لا توجد إشارات محفوظة بعد.', '🔥 No stored signals yet.'), [[{ text: '⬅️ القائمة', callback_data: 'menu:home' }]]);
    }
    const lines = rows.map((row, i) => {
      const token = row.tokens ?? {};
      return `${i + 1}. ${token.symbol ?? 'TOKEN'} | Entry ${row.entry_score ?? '—'} | Moon ${row.moon_score ?? '—'} | Risk ${row.risk_score ?? '—'}`;
    });
    return this.#send(`🔥 ${this.#pick('آخر الإشارات', 'Recent signals')}\n\n${lines.join('\n')}`, [[{ text: '⬅️ القائمة', callback_data: 'menu:home' }]]);
  }

  async #showTrades() {
    let rows = [];
    try { rows = await this.store.listRecentPaperTrades(5); } catch {}
    if (!rows.length) {
      return this.#send(this.#pick('🧪 لا توجد صفقات تجريبية محفوظة بعد.', '🧪 No stored paper trades yet.'), [[{ text: '⬅️ القائمة', callback_data: 'menu:home' }]]);
    }
    const lines = rows.map((row, i) => {
      const token = row.tokens ?? {};
      const pnl = row.pnl_pct == null ? 'مفتوحة' : `${Number(row.pnl_pct).toFixed(1)}%`;
      return `${i + 1}. ${token.symbol ?? 'TOKEN'} | ${row.status} | ${pnl}`;
    });
    return this.#send(`🧪 ${this.#pick('آخر الصفقات التجريبية', 'Recent paper trades')}\n\n${lines.join('\n')}`, [[{ text: '⬅️ القائمة', callback_data: 'menu:home' }]]);
  }

  async #showSafety() {
    return this.#send(this.#pick(
      '🛡️ الحماية\n\n• التداول الحقيقي مقفول.\n• لا يتم تخزين Seed Phrase أو Private Key.\n• المحفظة الحالية للقراءة فقط.\n• يوجد وقف خسارة وتجربة Paper Trading قبل أي تفعيل مالي.',
      '🛡️ Safety\n\n• Live trading is locked.\n• Seed phrases/private keys are never stored.\n• Linked wallet is read-only.\n• Stop-loss and paper validation come before any live execution.'
    ), [[{ text: '⬅️ القائمة', callback_data: 'menu:home' }]]);
  }

  async #showHelp() {
    return this.#send(this.#pick(
      '❓ المساعدة\n\n/start أو /menu لفتح لوحة التحكم.\nيمكنك ربط عنوان Solana العام من قسم المحفظة. لا ترسل أي مفتاح خاص أو كلمات الاسترداد.',
      '❓ Help\n\nUse /start or /menu to open the control panel. You can link a public Solana address from Wallet. Never send a private key or recovery phrase.'
    ), [[{ text: '⬅️ القائمة', callback_data: 'menu:home' }]]);
  }

  async #saveSetting(key, value) {
    if (this.settings?.enabled) await this.settings.set(key, String(value));
  }

  async #handleCallback(callback) {
    if (String(callback?.message?.chat?.id ?? '') !== this.chatId) return;
    const data = String(callback?.data ?? '');
    await this.#answerCallback(callback.id);

    if (data === 'menu:home') return this.showMainMenu();
    if (data === 'menu:status') return this.#showStatus();
    if (data === 'menu:signals') return this.#showSignals();
    if (data === 'menu:trades') return this.#showTrades();
    if (data === 'menu:wallet') return this.#showWallet();
    if (data === 'menu:settings') return this.#showSettings();
    if (data === 'menu:safety') return this.#showSafety();
    if (data === 'menu:help') return this.#showHelp();
    if (data === 'settings:language') return this.#showLanguage();

    if (data.startsWith('lang:')) {
      const language = normalizeTelegramLanguage(data.slice(5));
      this.runtime.language = language;
      this.notifier.setLanguage(language);
      await this.#saveSetting('telegram_language', language);
      await this.#send(this.#pick('✅ تم تغيير اللغة.', '✅ Language changed.'));
      return this.#showSettings();
    }

    if (data === 'settings:alerts') {
      this.runtime.alertsEnabled = !this.runtime.alertsEnabled;
      await this.#saveSetting('alerts_enabled', this.runtime.alertsEnabled);
      return this.#showSettings();
    }

    if (data === 'settings:scanner') {
      this.runtime.scannerPaused = !this.runtime.scannerPaused;
      await this.#saveSetting('scanner_paused', this.runtime.scannerPaused);
      return this.#showSettings();
    }

    if (data === 'wallet:show') return this.#showWallet();
    if (data === 'wallet:link') {
      this.awaitingWallet = true;
      return this.#send(this.#pick(
        '🔗 أرسل الآن عنوان محفظة Solana العام فقط.\n\nمثال: عنوان Phantom العام.\n⚠️ لا ترسل Seed Phrase أو Private Key.',
        '🔗 Send only your public Solana wallet address now.\n\nFor example, your public Phantom address.\n⚠️ Never send a seed phrase or private key.'
      ), [[{ text: '❌ إلغاء', callback_data: 'wallet:cancel' }]]);
    }
    if (data === 'wallet:cancel') { this.awaitingWallet = false; return this.#showWallet(); }
    if (data === 'wallet:disconnect') {
      this.runtime.walletAddress = '';
      await this.#saveSetting('wallet_address', '');
      return this.#showWallet();
    }
    if (data === 'wallet:live') {
      return this.#send(this.#pick(
        '🔒 التداول الحقيقي ما زال مقفولًا. سنفعّله فقط بعد تشغيل 24/7، نجاح Paper Trading، ومحفظة تداول منفصلة بحد مالي صغير.',
        '🔒 Live trading is still locked. It will only be considered after 24/7 operation, paper validation, and a separate low-balance trading wallet.'
      ), [[{ text: '⬅️ المحفظة', callback_data: 'menu:wallet' }]]);
    }
  }

  async #handleMessage(message) {
    if (String(message?.chat?.id ?? '') !== this.chatId || message?.chat?.type !== 'private') return;
    const text = String(message?.text ?? '').trim();
    if (/^\/(start|menu)(?:\s|$)/i.test(text)) return this.showMainMenu();

    if (this.awaitingWallet) {
      this.awaitingWallet = false;
      if (!SOLANA_ADDRESS.test(text)) {
        return this.#send(this.#pick(
          '❌ هذا لا يبدو عنوان Solana صالحًا. أعد المحاولة من زر المحفظة. ولا ترسل أي مفتاح خاص.',
          '❌ That does not look like a valid Solana public address. Try again from Wallet. Never send a private key.'
        ), [[{ text: '👛 المحفظة', callback_data: 'menu:wallet' }]]);
      }
      this.runtime.walletAddress = text;
      await this.#saveSetting('wallet_address', text);
      await this.#send(this.#pick('✅ تم ربط عنوان المحفظة للقراءة والمراقبة.', '✅ Wallet address linked for read-only monitoring.'));
      return this.#showWallet();
    }
  }

  async start() {
    if (!this.enabled || !this.stopped) return;
    this.stopped = false;
    await telegramApi(this.token, 'setMyCommands', {
      commands: [
        { command: 'menu', description: 'Open SUMMECA control panel' },
        { command: 'start', description: 'Start / show menu' }
      ]
    }).catch(() => {});
    void this.#loop();
  }

  stop() { this.stopped = true; }

  async #loop() {
    while (!this.stopped) {
      try {
        const updates = await telegramApi(this.token, 'getUpdates', {
          offset: this.offset,
          timeout: 20,
          limit: 50,
          allowed_updates: ['message', 'callback_query']
        });
        for (const update of Array.isArray(updates) ? updates : []) {
          this.offset = Math.max(this.offset, Number(update.update_id ?? 0) + 1);
          if (update.callback_query) await this.#handleCallback(update.callback_query);
          else if (update.message) await this.#handleMessage(update.message);
        }
      } catch (error) {
        console.error('[telegram:controller]', error.message);
        await new Promise((resolve) => setTimeout(resolve, 2000));
      }
    }
  }
}
