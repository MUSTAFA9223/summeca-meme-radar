import { fetchHeliusAssetMetadata } from '../feeds/heliusAsset.mjs';
import { normalizeTelegramLanguage, telegramApi } from '../notifiers/telegram.mjs';

const SOLANA_ADDRESS = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
const short = (value) => value ? `${value.slice(0, 5)}…${value.slice(-5)}` : '—';
const yesNo = (value, ar = true) => ar ? (value ? 'نعم' : 'لا') : (value ? 'Yes' : 'No');
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export class TelegramController {
  constructor({ token, chatId, notifier, settings, store, runtime, heliusApiKey, onPaperBuy, onPaperSell, getRecentCreates }) {
    this.token = token;
    this.chatId = String(chatId ?? '');
    this.notifier = notifier;
    this.settings = settings;
    this.store = store;
    this.runtime = runtime;
    this.heliusApiKey = heliusApiKey ?? '';
    this.onPaperBuy = typeof onPaperBuy === 'function' ? onPaperBuy : null;
    this.onPaperSell = typeof onPaperSell === 'function' ? onPaperSell : null;
    this.getRecentCreates = typeof getRecentCreates === 'function' ? getRecentCreates : (() => []);
    this.offset = 0;
    this.stopped = true;
    this.awaitingWallet = false;
    this.awaitingPaperAmountFor = '';
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
      [{ text: '🆕 العملات الجديدة', callback_data: 'menu:newcoins' }],
      [{ text: '🧪 الصفقات التجريبية', callback_data: 'menu:trades' }, { text: '👛 المحفظة', callback_data: 'menu:wallet' }],
      [{ text: '⚙️ الإعدادات', callback_data: 'menu:settings' }, { text: '🛡️ الحماية', callback_data: 'menu:safety' }],
      [{ text: '❓ المساعدة', callback_data: 'menu:help' }]
    ];
  }

  async showMainMenu() {
    return this.#send(this.#pick(
      '🤖 SUMMECA Meme Radar\n\nالتنبيهات التلقائية مخصصة للزخم/الدخول القوي. العملات الجديدة تجدها يدويًا من زر «🆕 العملات الجديدة».',
      '🤖 SUMMECA Meme Radar\n\nAutomatic alerts are reserved for strong momentum/entry signals. Browse raw new launches from “🆕 New coins”.'
    ), this.mainKeyboard());
  }

  async #showStatus() {
    const ar = [
      '📊 حالة الرادار', '',
      `الرادار: ${this.runtime.scannerPaused ? '⏸️ متوقف مؤقتًا' : '🟢 يعمل'}`,
      `تنبيهات الزخم: ${this.runtime.alertsEnabled ? '🔔 مفعلة' : '🔕 متوقفة'}`,
      'تنبيهات إنشاء العملات: 🔇 مخفية — داخل قسم العملات الجديدة',
      `اللغة: ${this.runtime.language}`,
      `التداول الحقيقي: 🔒 مغلق`,
      `الوضع: 🧪 تداول تجريبي فقط`,
      `المحفظة مرتبطة: ${yesNo(Boolean(this.runtime.walletAddress))}`,
      `المحفظة: ${short(this.runtime.walletAddress)}`
    ].join('\n');
    const en = [
      '📊 Radar status', '',
      `Scanner: ${this.runtime.scannerPaused ? '⏸️ Paused' : '🟢 Running'}`,
      `Momentum alerts: ${this.runtime.alertsEnabled ? '🔔 Enabled' : '🔕 Disabled'}`,
      'Raw create alerts: 🔇 Hidden — browse them under New coins',
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
      '⚙️ الإعدادات\n\nيمكنك تغيير اللغة، تنبيهات الزخم، وتشغيل/إيقاف الرادار من هنا.',
      '⚙️ Settings\n\nChange language, momentum alerts, and pause/resume the scanner here.'
    );
    return this.#send(text, [
      [{ text: '🌐 اللغة', callback_data: 'settings:language' }],
      [{ text: this.runtime.alertsEnabled ? '🔕 إيقاف تنبيهات الزخم' : '🔔 تشغيل تنبيهات الزخم', callback_data: 'settings:alerts' }],
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
      '🧪 أزرار الشراء والبيع داخل البوت تعمل حاليًا على Paper Trading فقط.',
      '🔒 لا ترسل Seed Phrase أو Private Key للبوت مطلقًا.',
      'ربط العنوان الحالي للعرض والمراقبة فقط؛ التداول الحقيقي ما زال مقفولًا.'
    ].filter(Boolean).join('\n');
    const en = [
      '👛 Wallet', '',
      `Status: ${linked ? '✅ Linked read-only' : '❌ Not linked'}`,
      linked ? `Address: ${this.runtime.walletAddress}` : '',
      balance != null ? `Balance: ${balance.toFixed(5)} SOL` : '',
      '',
      '🧪 In-bot buy/sell buttons currently execute PAPER trades only.',
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

  async #showNewCoins() {
    const rows = this.getRecentCreates().slice(0, 5);
    if (!rows.length) {
      return this.#send(this.#pick(
        '🆕 لا توجد عملات إنشاء جديدة محفوظة منذ آخر تشغيل.',
        '🆕 No recent create events have been captured since the last restart.'
      ), [[{ text: '⬅️ القائمة', callback_data: 'menu:home' }]]);
    }

    await this.#send(this.#pick(
      '🆕 أحدث العملات التي تم إنشاؤها\n\nهذه قائمة خام للعرض عند الطلب فقط، وليست إشارات دخول. التنبيه التلقائي سيصلك فقط إذا ظهر زخم قوي.',
      '🆕 Latest created coins\n\nThis is an on-demand raw list, not entry signals. Automatic alerts are only sent after strong momentum appears.'
    ), [[{ text: '🔄 تحديث', callback_data: 'menu:newcoins' }, { text: '⬅️ القائمة', callback_data: 'menu:home' }]]);

    for (const row of rows) {
      const address = String(row.address ?? '');
      if (!SOLANA_ADDRESS.test(address)) continue;
      let meta = {};
      if (this.heliusApiKey) {
        try { meta = await fetchHeliusAssetMetadata(this.heliusApiKey, address); } catch {}
      }
      const symbol = meta.symbol ?? row.symbol ?? 'NEW';
      const name = meta.name ?? row.name ?? 'New Pump.fun coin';
      const ageSec = Math.max(0, Math.round((Date.now() - Number(row.createdAt ?? Date.now())) / 1000));
      const caption = this.#pick(
        `🆕 ${symbol} — ${name}\nالعمر: ${ageSec}ث\nالحالة: لم تعتمد كإشارة دخول\nCA: ${address}`,
        `🆕 ${symbol} — ${name}\nAge: ${ageSec}s\nStatus: not approved as an entry signal\nCA: ${address}`
      );
      const keyboard = {
        inline_keyboard: [
          [{ text: this.runtime.language === 'en' ? '📋 Copy CA' : '📋 نسخ CA', copy_text: { text: address } }],
          [{ text: this.runtime.language === 'en' ? '📄 Send CA only' : '📄 إرسال CA فقط', callback_data: `token:ca:${address}` }],
          [
            { text: '⚡ Pump.fun', url: `https://pump.fun/coin/${encodeURIComponent(address)}` },
            { text: '👻 Phantom', url: `https://phantom.com/tokens/solana/${encodeURIComponent(address)}` }
          ]
        ]
      };
      if (meta.imageUrl) {
        try {
          await telegramApi(this.token, 'sendPhoto', {
            chat_id: this.chatId,
            photo: meta.imageUrl,
            caption,
            reply_markup: keyboard
          });
        } catch {
          await telegramApi(this.token, 'sendMessage', { chat_id: this.chatId, text: caption, reply_markup: keyboard });
        }
      } else {
        await telegramApi(this.token, 'sendMessage', { chat_id: this.chatId, text: caption, reply_markup: keyboard });
      }
      await wait(250);
    }
  }

  async #showSignals() {
    let rows = [];
    try { rows = await this.store.listRecentSignals(5); } catch {}
    if (!rows.length) {
      return this.#send(this.#pick('🔥 لا توجد إشارات زخم محفوظة بعد.', '🔥 No stored momentum signals yet.'), [[{ text: '⬅️ القائمة', callback_data: 'menu:home' }]]);
    }
    const lines = rows.map((row, i) => {
      const token = row.tokens ?? {};
      return `${i + 1}. ${token.symbol ?? 'TOKEN'} | Entry ${row.entry_score ?? '—'} | Moon ${row.moon_score ?? '—'} | Risk ${row.risk_score ?? '—'}`;
    });
    return this.#send(`🔥 ${this.#pick('آخر إشارات الزخم/الدخول', 'Recent momentum/entry signals')}\n\n${lines.join('\n')}`, [[{ text: '⬅️ القائمة', callback_data: 'menu:home' }]]);
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
      '🛡️ الحماية\n\n• التداول الحقيقي مقفول.\n• لا يتم تخزين Seed Phrase أو Private Key.\n• المحفظة الحالية للقراءة فقط.\n• أزرار الشراء والبيع تنفذ Paper Trading فقط.\n• وقف الخسارة الحالي -10% وحماية الربح تستهدف +20% بعد بلوغ +30%.',
      '🛡️ Safety\n\n• Live trading is locked.\n• Seed phrases/private keys are never stored.\n• Linked wallet is read-only.\n• Buy/sell buttons execute PAPER trades only.\n• Current paper stop is -10%; profit lock targets +20% after reaching +30%.'
    ), [[{ text: '⬅️ القائمة', callback_data: 'menu:home' }]]);
  }

  async #showHelp() {
    return this.#send(this.#pick(
      '❓ المساعدة\n\n/start أو /menu لفتح لوحة التحكم.\n«🆕 العملات الجديدة» يعرض العقود الخام عند الطلب ولا يرسلها كتنبيهات.\nالتنبيه الرئيسي مخصص للعملات ذات الزخم/الدخول القوي، ومنه تستطيع الشراء أو البيع Paper مباشرة.\nلا ترسل أي مفتاح خاص أو كلمات الاسترداد.',
      '❓ Help\n\nUse /start or /menu to open the control panel.\n“🆕 New coins” shows raw creates on demand and does not push them as alerts.\nMain alerts are reserved for strong momentum/entry signals, with direct PAPER buy/sell controls.\nNever send a private key or recovery phrase.'
    ), [[{ text: '⬅️ القائمة', callback_data: 'menu:home' }]]);
  }

  async #saveSetting(key, value) {
    if (this.settings?.enabled) await this.settings.set(key, String(value));
  }

  async #showPaperSizing(address) {
    if (!SOLANA_ADDRESS.test(address)) {
      return this.#send(this.#pick('❌ عنوان العملة غير صالح.', '❌ Invalid token address.'));
    }
    return this.#send(this.#pick(
      `🟢 شراء تجريبي من البوت\n\nاختر الحجم لـ ${short(address)}.\nالنسبة تُحسب من الرصيد التجريبي المتاح وقت التنفيذ.\nإذا لم يظهر السعر بعد، سيبقى الطلب معلقًا حتى أول سعر صالح.`,
      `🟢 In-bot PAPER buy\n\nChoose size for ${short(address)}.\nPercentages use currently available paper cash.\nIf price is not available yet, the order waits for the first valid price.`
    ), [
      [
        { text: '10%', callback_data: `paper:buy:p10:${address}` },
        { text: '20%', callback_data: `paper:buy:p20:${address}` },
        { text: '50%', callback_data: `paper:buy:p50:${address}` },
        { text: '100%', callback_data: `paper:buy:p100:${address}` }
      ],
      [
        { text: '$10', callback_data: `paper:buy:d10:${address}` },
        { text: '$25', callback_data: `paper:buy:d25:${address}` },
        { text: '$50', callback_data: `paper:buy:d50:${address}` },
        { text: '$100', callback_data: `paper:buy:d100:${address}` }
      ],
      [{ text: this.runtime.language === 'en' ? '💵 Custom USD amount' : '💵 مبلغ دولار آخر', callback_data: `paper:custom:${address}` }]
    ]);
  }

  async #showPaperSell(address) {
    if (!SOLANA_ADDRESS.test(address)) {
      return this.#send(this.#pick('❌ عنوان العملة غير صالح.', '❌ Invalid token address.'));
    }
    return this.#send(this.#pick(
      `🔴 بيع تجريبي من البوت\n\nاختر نسبة البيع من الصفقة المفتوحة لـ ${short(address)}.\n25% و50% بيع جزئي، و100% يغلق الصفقة بالكامل.`,
      `🔴 In-bot PAPER sell\n\nChoose how much of the open position to sell for ${short(address)}.\n25% and 50% are partial exits; 100% closes the position.`
    ), [[
      { text: '25%', callback_data: `paper:sell:p25:${address}` },
      { text: '50%', callback_data: `paper:sell:p50:${address}` },
      { text: '100%', callback_data: `paper:sell:p100:${address}` }
    ]]);
  }

  async #executePaperBuy(address, mode, value) {
    if (!this.onPaperBuy) {
      return this.#send(this.#pick('❌ خدمة الشراء التجريبي غير متاحة حاليًا.', '❌ Paper buy service is currently unavailable.'));
    }
    try {
      const result = await this.onPaperBuy({ address, mode, value });
      if (result?.status === 'filled') {
        const p = result.position;
        const warning = Array.isArray(result.warnings) && result.warnings.length
          ? `\n⚠️ ${result.warnings.join('، ')}`
          : '';
        return this.#send(this.#pick(
          `✅ تم الشراء التجريبي\n\n${p.symbol ?? 'TOKEN'}\nالحجم: $${Number(p.usdSize).toFixed(2)}\nالسعر: ${p.entryPriceUsd}\nالستوب: -10%\nحماية الربح: تستهدف +20% بعد بلوغ +30%${warning}`,
          `✅ PAPER buy filled\n\n${p.symbol ?? 'TOKEN'}\nSize: $${Number(p.usdSize).toFixed(2)}\nPrice: ${p.entryPriceUsd}\nStop: -10%\nProfit lock: targets +20% after reaching +30%${warning}`
        ), [[{ text: this.runtime.language === 'en' ? '🔴 Sell this position' : '🔴 بيع هذه الصفقة', callback_data: `paper:sellmenu:${address}` }]]);
      }
      if (result?.status === 'queued') {
        return this.#send(this.#pick(
          `⏳ تم حجز طلب الشراء التجريبي لـ ${short(address)}.\nسيتم تنفيذه تلقائيًا عند أول سعر صالح.`,
          `⏳ PAPER buy queued for ${short(address)}.\nIt will execute automatically at the first valid price.`
        ));
      }
      const reason = result?.reason ?? 'unknown';
      return this.#send(this.#pick(
        `❌ لم يتم تنفيذ الشراء التجريبي: ${reason}`,
        `❌ PAPER buy was not executed: ${reason}`
      ));
    } catch (error) {
      return this.#send(this.#pick(
        `❌ تعذر تنفيذ الشراء التجريبي: ${error.message}`,
        `❌ Could not execute PAPER buy: ${error.message}`
      ));
    }
  }

  async #executePaperSell(address, percent) {
    if (!this.onPaperSell) {
      return this.#send(this.#pick('❌ خدمة البيع التجريبي غير متاحة حاليًا.', '❌ Paper sell service is currently unavailable.'));
    }
    try {
      const result = await this.onPaperSell({ address, percent });
      if (result?.status === 'sold') {
        const pnlSign = Number(result.legPnlUsd ?? 0) >= 0 ? '+' : '';
        const remaining = Number(result.remainingUsdSize ?? 0);
        const ar = [
          result.closed ? '✅ تم إغلاق الصفقة التجريبية بالكامل' : `✅ تم بيع ${Number(result.sellPct).toFixed(0)}% من الصفقة التجريبية`,
          '',
          `${result.symbol ?? 'TOKEN'}`,
          `السعر: ${result.priceUsd}`,
          `نتيجة الجزء المباع: ${pnlSign}$${Number(result.legPnlUsd ?? 0).toFixed(2)} (${Number(result.legPnlPct ?? 0).toFixed(1)}%)`,
          result.closed ? `النتيجة الإجمالية: ${Number(result.totalPnlPct ?? 0).toFixed(1)}%` : `المتبقي من رأس المال داخل الصفقة: $${remaining.toFixed(2)}`
        ].join('\n');
        const en = [
          result.closed ? '✅ PAPER position fully closed' : `✅ Sold ${Number(result.sellPct).toFixed(0)}% of PAPER position`,
          '',
          `${result.symbol ?? 'TOKEN'}`,
          `Price: ${result.priceUsd}`,
          `Sold-leg result: ${pnlSign}$${Number(result.legPnlUsd ?? 0).toFixed(2)} (${Number(result.legPnlPct ?? 0).toFixed(1)}%)`,
          result.closed ? `Total result: ${Number(result.totalPnlPct ?? 0).toFixed(1)}%` : `Remaining paper cost basis: $${remaining.toFixed(2)}`
        ].join('\n');
        return this.#send(this.#pick(ar, en), result.closed ? undefined : [[{ text: this.runtime.language === 'en' ? '🔴 Sell more' : '🔴 بيع المزيد', callback_data: `paper:sellmenu:${address}` }]]);
      }
      const reason = result?.reason ?? 'unknown';
      return this.#send(this.#pick(
        `❌ لم يتم تنفيذ البيع التجريبي: ${reason}`,
        `❌ PAPER sell was not executed: ${reason}`
      ));
    } catch (error) {
      return this.#send(this.#pick(
        `❌ تعذر تنفيذ البيع التجريبي: ${error.message}`,
        `❌ Could not execute PAPER sell: ${error.message}`
      ));
    }
  }

  async #handleCallback(callback) {
    if (String(callback?.message?.chat?.id ?? '') !== this.chatId) return;
    const data = String(callback?.data ?? '');
    await this.#answerCallback(callback.id);

    if (data === 'menu:home') return this.showMainMenu();
    if (data === 'menu:status') return this.#showStatus();
    if (data === 'menu:newcoins') return this.#showNewCoins();
    if (data === 'menu:signals') return this.#showSignals();
    if (data === 'menu:trades') return this.#showTrades();
    if (data === 'menu:wallet') return this.#showWallet();
    if (data === 'menu:settings') return this.#showSettings();
    if (data === 'menu:safety') return this.#showSafety();
    if (data === 'menu:help') return this.#showHelp();
    if (data === 'settings:language') return this.#showLanguage();

    if (data.startsWith('paper:menu:')) {
      const address = data.slice('paper:menu:'.length);
      return this.#showPaperSizing(address);
    }

    if (data.startsWith('paper:sellmenu:')) {
      const address = data.slice('paper:sellmenu:'.length);
      return this.#showPaperSell(address);
    }

    if (data.startsWith('paper:buy:')) {
      const match = data.match(/^paper:buy:([pd])(\d+(?:\.\d+)?):([1-9A-HJ-NP-Za-km-z]{32,44})$/);
      if (!match) return this.#send(this.#pick('❌ خيار الشراء غير صالح.', '❌ Invalid buy option.'));
      const [, kind, rawValue, address] = match;
      return this.#executePaperBuy(address, kind === 'p' ? 'percent' : 'usd', Number(rawValue));
    }

    if (data.startsWith('paper:sell:')) {
      const match = data.match(/^paper:sell:p(25|50|100):([1-9A-HJ-NP-Za-km-z]{32,44})$/);
      if (!match) return this.#send(this.#pick('❌ خيار البيع غير صالح.', '❌ Invalid sell option.'));
      const [, rawValue, address] = match;
      return this.#executePaperSell(address, Number(rawValue));
    }

    if (data.startsWith('paper:custom:')) {
      const address = data.slice('paper:custom:'.length);
      if (!SOLANA_ADDRESS.test(address)) return this.#send(this.#pick('❌ عنوان العملة غير صالح.', '❌ Invalid token address.'));
      this.awaitingPaperAmountFor = address;
      return this.#send(this.#pick(
        '💵 أرسل مبلغ الشراء التجريبي بالدولار فقط، مثال: 35 أو 125.50',
        '💵 Send only the PAPER buy amount in USD, for example: 35 or 125.50'
      ));
    }

    if (data.startsWith('token:ca:')) {
      const address = data.slice('token:ca:'.length);
      if (!SOLANA_ADDRESS.test(address)) {
        return this.#send(this.#pick('❌ تعذر قراءة عنوان العملة.', '❌ Could not read the token address.'));
      }
      return this.#send(`${this.#pick('📄 عنوان العملة — اضغط مطولًا للنسخ', '📄 Token CA — press and hold to copy')}\n\n${address}`);
    }

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
        '🔒 التداول الحقيقي ما زال مقفولًا. أزرار الشراء والبيع تعمل الآن على Paper فقط. للتداول الحقيقي نحتاج لاحقًا محفظة تداول منفصلة وموقّع آمن، وليس Seed Phrase داخل Telegram.',
        '🔒 Live trading is still locked. Buy/sell buttons currently work in PAPER mode only. Live execution later requires a separate trading wallet and secure signer, never a seed phrase in Telegram.'
      ), [[{ text: '⬅️ المحفظة', callback_data: 'menu:wallet' }]]);
    }
  }

  async #handleMessage(message) {
    if (String(message?.chat?.id ?? '') !== this.chatId || message?.chat?.type !== 'private') return;
    const text = String(message?.text ?? '').trim();
    if (/^\/(start|menu)(?:\s|$)/i.test(text)) return this.showMainMenu();

    if (this.awaitingPaperAmountFor) {
      const address = this.awaitingPaperAmountFor;
      this.awaitingPaperAmountFor = '';
      const value = Number(text.replace(/[$,\s]/g, ''));
      if (!Number.isFinite(value) || value <= 0) {
        return this.#send(this.#pick(
          '❌ المبلغ غير صالح. افتح خيار الشراء من تنبيه العملة وحاول مرة أخرى.',
          '❌ Invalid amount. Open the buy option from the token alert and try again.'
        ));
      }
      return this.#executePaperBuy(address, 'usd', value);
    }

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
