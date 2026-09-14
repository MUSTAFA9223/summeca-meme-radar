import { env } from '../config/env.mjs';
import { ageLabel, entryQuality, isRisingMomentum, momentumScore, normalizeMomentumSnapshot, persistedSafety } from '../core/momentumProfile.mjs';
import { fetchHeliusAssetMetadata } from '../feeds/heliusAsset.mjs';
import { normalizeTelegramLanguage, telegramApi } from '../notifiers/telegram.mjs';

const SOLANA_ADDRESS = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
const short = (value) => value ? `${String(value).slice(0, 5)}…${String(value).slice(-5)}` : '—';
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const num = (value, fallback = 0) => Number.isFinite(Number(value)) ? Number(value) : fallback;

const compactMoney = (value) => {
  const n = num(value);
  if (n <= 0) return '—';
  if (n >= 1e9) return `${(n / 1e9).toFixed(n >= 1e10 ? 0 : 1)}B`;
  if (n >= 1e6) return `${(n / 1e6).toFixed(n >= 1e7 ? 0 : 1)}M`;
  if (n >= 1e3) return `${(n / 1e3).toFixed(n >= 1e4 ? 0 : 1)}K`;
  return n.toFixed(n >= 100 ? 0 : 1);
};

const priceText = (value) => {
  const n = num(value);
  if (n <= 0) return '—';
  return n >= 0.01 ? n.toLocaleString('en-US', { maximumFractionDigits: 8 }) : n.toExponential(6);
};

const phantomSwapUrl = (mint, side = 'buy') => {
  const caip19 = `solana:101/address:${mint}`;
  return side === 'sell'
    ? `https://phantom.app/ul/v1/swap?buy=&sell=${encodeURIComponent(caip19)}`
    : `https://phantom.app/ul/v1/swap?buy=${encodeURIComponent(caip19)}&sell=`;
};

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

  async #send(text, inlineKeyboard, extra = {}) {
    const body = { chat_id: this.chatId, text, ...extra };
    if (inlineKeyboard) body.reply_markup = { inline_keyboard: inlineKeyboard };
    return telegramApi(this.token, 'sendMessage', body);
  }

  async #sendCard({ text, imageUrl, keyboard }) {
    if (imageUrl && text.length <= 1000) {
      try {
        return await telegramApi(this.token, 'sendPhoto', {
          chat_id: this.chatId,
          photo: imageUrl,
          caption: text,
          ...(keyboard ? { reply_markup: { inline_keyboard: keyboard } } : {})
        });
      } catch (error) {
        console.warn('[telegram:controller:photo]', error.message);
      }
    }
    return this.#send(text, keyboard);
  }

  async #answerCallback(id, text = '') {
    if (!id) return;
    await telegramApi(this.token, 'answerCallbackQuery', { callback_query_id: id, text }).catch(() => {});
  }

  mainKeyboard() {
    return [
      [{ text: '📊 الحالة', callback_data: 'menu:status' }, { text: '🔥 العملات الصاعدة', callback_data: 'menu:trending' }],
      [{ text: '🔔 آخر الإشارات', callback_data: 'menu:signals' }, { text: '👀 المتابعة', callback_data: 'menu:watchlist' }],
      [{ text: '🆕 العملات الجديدة', callback_data: 'menu:newcoins' }],
      [{ text: '🧪 الصفقات التجريبية', callback_data: 'menu:trades' }, { text: '👛 المحفظة', callback_data: 'menu:wallet' }],
      [{ text: '⚙️ الإعدادات', callback_data: 'menu:settings' }, { text: '🛡️ الحماية', callback_data: 'menu:safety' }],
      [{ text: '❓ المساعدة', callback_data: 'menu:help' }]
    ];
  }

  async showMainMenu() {
    return this.#send(this.#pick(
      '🤖 SUMMECA Meme Radar\n\n🔥 الصاعدة = عملات عليها حركة فعلية مرتبة بالزخم.\n👀 المتابعة = عملات اخترتها أنت وتصل تحديثاتها عند التسارع.\n🆕 الجديدة = قائمة خام فقط، وليست إشارة دخول.\n\nلا يظهر «دخول معتمد» إلا بعد نجاح بوابة الأمان.',
      '🤖 SUMMECA Meme Radar\n\n🔥 Trending = tokens with verified movement ranked by momentum.\n👀 Watchlist = tokens you chose, with acceleration updates.\n🆕 New coins = raw launches only, not entry signals.\n\n“Entry approved” is shown only after the safety gate passes.'
    ), this.mainKeyboard());
  }

  async #loadWatchlist() {
    if (!this.settings?.enabled) return [];
    const raw = await this.settings.get('watchlist_tokens');
    if (!raw) return [];
    try {
      return [...new Set(JSON.parse(String(raw)).map(String).filter((value) => SOLANA_ADDRESS.test(value)))].slice(0, 30);
    } catch {
      return [];
    }
  }

  async #saveWatchlist(list) {
    if (!this.settings?.enabled) return;
    const safe = [...new Set(list.map(String).filter((value) => SOLANA_ADDRESS.test(value)))].slice(0, 30);
    await this.settings.set('watchlist_tokens', JSON.stringify(safe));
  }

  async #watching(address) {
    return (await this.#loadWatchlist()).includes(address);
  }

  #tokenKeyboard(address, { watching = false, safe = false } = {}) {
    const rows = [
      [
        { text: watching ? '🗑️ إلغاء المتابعة' : '👀 متابعة', callback_data: `${watching ? 'watch:remove' : 'watch:add'}:${address}` },
        { text: '📋 العقد', copy_text: { text: address } }
      ],
      [
        { text: '📊 DEX', url: `https://dexscreener.com/solana/${encodeURIComponent(address)}` },
        { text: '🔥 FOMO', url: `https://fomo.family/tokens/solana/${encodeURIComponent(address)}` },
        { text: '👻 Phantom', url: `https://phantom.com/tokens/solana/${encodeURIComponent(address)}` }
      ],
      [
        { text: '🧪 شراء Paper', callback_data: `paper:menu:${address}` },
        { text: '🧪 بيع Paper', callback_data: `paper:sellmenu:${address}` }
      ]
    ];
    if (safe) rows.push([{ text: '⚡ تداول حقيقي — تأكيد أولًا', callback_data: `live:menu:${address}` }]);
    return rows;
  }

  async #showStatus() {
    let watchCount = 0;
    try { watchCount = (await this.#loadWatchlist()).length; } catch {}
    const ar = [
      '📊 حالة الرادار', '',
      `الرادار: ${this.runtime.scannerPaused ? '⏸️ متوقف مؤقتًا' : '🟢 يعمل'}`,
      `تنبيهات الزخم: ${this.runtime.alertsEnabled ? '🔔 مفعلة' : '🔕 متوقفة'}`,
      `قائمة المتابعة: ${watchCount} عملة`,
      'تنبيهات إنشاء العملات: 🔇 مخفية — داخل قسم العملات الجديدة',
      `اللغة: ${this.runtime.language}`,
      `التداول الآلي الحقيقي: ${env.liveTradingEnabled ? '🟠 مفعّل بالمحرك المحمي' : '🔒 مقفول'}`,
      `بوابة الأمان: ✅ Fail-closed`,
      `مصادر السوق: Helius + DexScreener + GeckoTerminal fallback`,
      env.privyWalletAddress ? `محفظة التداول: ${short(env.privyWalletAddress)}` : 'محفظة التداول: غير مهيأة'
    ].join('\n');
    const en = [
      '📊 Radar status', '',
      `Scanner: ${this.runtime.scannerPaused ? '⏸️ Paused' : '🟢 Running'}`,
      `Momentum alerts: ${this.runtime.alertsEnabled ? '🔔 Enabled' : '🔕 Disabled'}`,
      `Watchlist: ${watchCount} token(s)`,
      'Raw create alerts: 🔇 Hidden under New coins',
      `Language: ${this.runtime.language}`,
      `Autonomous live engine: ${env.liveTradingEnabled ? '🟠 Enabled with guarded engine' : '🔒 Locked'}`,
      'Safety gate: ✅ Fail-closed',
      'Market sources: Helius + DexScreener + GeckoTerminal fallback',
      env.privyWalletAddress ? `Trading wallet: ${short(env.privyWalletAddress)}` : 'Trading wallet: not configured'
    ].join('\n');
    return this.#send(this.#pick(ar, en), [[{ text: '⬅️ القائمة', callback_data: 'menu:home' }]]);
  }

  async #showSettings() {
    const text = this.#pick(
      '⚙️ الإعدادات\n\nغيّر اللغة، تنبيهات الزخم، أو أوقف/شغّل الرادار. العملات التي تضيفها للمتابعة محفوظة في Supabase وتبقى بعد إعادة التشغيل.',
      '⚙️ Settings\n\nChange language, momentum alerts, or pause/resume the radar. Watchlist tokens persist in Supabase across restarts.'
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

  async #getSolBalance(address) {
    if (!address || !this.heliusApiKey) return null;
    const endpoint = `https://mainnet.helius-rpc.com/?api-key=${encodeURIComponent(this.heliusApiKey)}`;
    const response = await fetch(endpoint, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'getBalance', params: [address] })
    });
    if (!response.ok) throw new Error(`Helius HTTP ${response.status}`);
    const body = await response.json();
    if (body.error) throw new Error(body.error.message);
    return Number(body?.result?.value ?? 0) / 1_000_000_000;
  }

  async #showWallet() {
    const monitorAddress = String(this.runtime.walletAddress ?? '');
    const tradingAddress = String(env.privyWalletAddress ?? '');
    let monitorBalance = null;
    let tradingBalance = null;
    if (monitorAddress) try { monitorBalance = await this.#getSolBalance(monitorAddress); } catch {}
    if (tradingAddress) try { tradingBalance = await this.#getSolBalance(tradingAddress); } catch {}

    let liveTrades = [];
    if (tradingAddress && this.store?.enabled) {
      try { liveTrades = await this.store.listOpenLiveTrades(tradingAddress, 5); } catch {}
    }

    const tradeLines = liveTrades.map((row) => {
      const token = row.tokens ?? {};
      return `• ${token.symbol ?? 'TOKEN'} | ${num(row.input_sol).toFixed(4)} SOL | High ${num(row.high_water_pnl_pct).toFixed(1)}%`;
    });

    const ar = [
      '👛 المحفظة والصفقات', '',
      '🔐 SUMMECA Trading Wallet',
      tradingAddress ? `العنوان: ${short(tradingAddress)}` : 'غير مهيأة',
      tradingBalance != null ? `الرصيد: ${tradingBalance.toFixed(5)} SOL` : '',
      `المحرك الآلي: ${env.liveTradingEnabled ? '🟠 مفعّل' : '🔒 مقفول'}`,
      `صفقات حقيقية مفتوحة: ${liveTrades.length}`,
      ...tradeLines,
      '',
      '👁️ محفظة المراقبة الشخصية',
      monitorAddress ? `العنوان: ${short(monitorAddress)}` : 'غير مرتبطة',
      monitorBalance != null ? `الرصيد: ${monitorBalance.toFixed(5)} SOL` : '',
      '',
      '🧪 Paper Trading يبقى متاحًا من أزرار العملة.',
      '🔒 لا ترسل Seed Phrase أو Private Key في Telegram.'
    ].filter(Boolean).join('\n');

    const en = [
      '👛 Wallet & trades', '',
      '🔐 SUMMECA Trading Wallet',
      tradingAddress ? `Address: ${short(tradingAddress)}` : 'Not configured',
      tradingBalance != null ? `Balance: ${tradingBalance.toFixed(5)} SOL` : '',
      `Autonomous engine: ${env.liveTradingEnabled ? '🟠 Enabled' : '🔒 Locked'}`,
      `Open live positions: ${liveTrades.length}`,
      ...tradeLines,
      '',
      '👁️ Personal monitor wallet',
      monitorAddress ? `Address: ${short(monitorAddress)}` : 'Not linked',
      monitorBalance != null ? `Balance: ${monitorBalance.toFixed(5)} SOL` : '',
      '',
      '🧪 Paper Trading remains available from token controls.',
      '🔒 Never send a seed phrase or private key in Telegram.'
    ].filter(Boolean).join('\n');

    return this.#send(this.#pick(ar, en), [
      [{ text: monitorAddress ? '🔄 تغيير محفظة المراقبة' : '🔗 ربط محفظة مراقبة', callback_data: 'wallet:link' }],
      [{ text: '🔄 تحديث الرصيد والصفقات', callback_data: 'wallet:show' }],
      ...(monitorAddress ? [[{ text: '❌ فصل محفظة المراقبة', callback_data: 'wallet:disconnect' }]] : []),
      [{ text: '🛡️ حالة التداول الحقيقي', callback_data: 'wallet:live' }],
      [{ text: '⬅️ القائمة', callback_data: 'menu:home' }]
    ]);
  }

  async #showTrending(limit = 10) {
    let rows = [];
    try { rows = await this.store.listTrendingSnapshots({ minutes: 10, limit: 220 }); } catch (error) {
      console.error('[telegram:trending]', error.message);
    }
    const latest = new Map();
    for (const row of rows) if (row?.token_id && !latest.has(String(row.token_id))) latest.set(String(row.token_id), row);
    const ranked = [...latest.values()]
      .map((snapshot) => ({ snapshot, profile: normalizeMomentumSnapshot(snapshot), momentum: momentumScore(snapshot), safety: persistedSafety(snapshot), quality: entryQuality(snapshot) }))
      .filter((item) => item.profile.priceUsd > 0)
      .filter((item) => isRisingMomentum(item.snapshot) || item.momentum >= 35)
      .sort((a, b) => b.momentum - a.momentum || b.profile.entryScore - a.profile.entryScore)
      .slice(0, Math.max(1, Math.min(20, limit)));

    if (!ranked.length) {
      return this.#send(this.#pick(
        '🔥 لا توجد الآن عملات لديها حركة كافية للدخول في قائمة الصاعدين. الرادار مستمر بالمراقبة.',
        '🔥 No tokens currently have enough verified movement to enter the trending list. The radar is still scanning.'
      ), [[{ text: '🔄 تحديث', callback_data: 'menu:trending' }, { text: '⬅️ القائمة', callback_data: 'menu:home' }]]);
    }

    const arLines = ranked.map((item, i) => {
      const s = item.profile;
      const badge = item.safety.ok ? (item.quality.key === 'late' ? '⚠️' : '✅') : '👀';
      return `${i + 1}. ${badge} $${s.symbol} | زخم ${item.momentum} | Entry ${Math.round(s.entryScore)} | Risk ${Math.round(s.riskScore)} | 5د ${s.priceChange5mPct.toFixed(1)}%`;
    });
    const enLines = ranked.map((item, i) => {
      const s = item.profile;
      const badge = item.safety.ok ? (item.quality.key === 'late' ? '⚠️' : '✅') : '👀';
      return `${i + 1}. ${badge} $${s.symbol} | M ${item.momentum} | Entry ${Math.round(s.entryScore)} | Risk ${Math.round(s.riskScore)} | 5m ${s.priceChange5mPct.toFixed(1)}%`;
    });
    const text = this.#pick(
      `🔥 أقوى العملات الصاعدة الآن\n\n✅ = اجتازت الأمان | ⚠️ = آمنة لكن الدخول متأخر | 👀 = حركة فقط وليست دخولًا معتمدًا\n\n${arLines.join('\n')}`,
      `🔥 Strongest trending tokens now\n\n✅ = safety passed | ⚠️ = safe but late | 👀 = movement only, not approved entry\n\n${enLines.join('\n')}`
    );
    const buttons = ranked.slice(0, 10).map((item, i) => [{ text: `${i + 1}. $${item.profile.symbol}`, callback_data: `token:detail:${item.profile.address}` }]);
    buttons.push([
      { text: limit >= 20 ? '🔟 عرض 10' : '2️⃣0️⃣ عرض 20', callback_data: limit >= 20 ? 'menu:trending' : 'menu:trending20' },
      { text: '🔄 تحديث', callback_data: limit >= 20 ? 'menu:trending20' : 'menu:trending' }
    ]);
    buttons.push([{ text: '⬅️ القائمة', callback_data: 'menu:home' }]);
    return this.#send(text, buttons);
  }

  async #showWatchlist() {
    let watchlist = [];
    try { watchlist = await this.#loadWatchlist(); } catch {}
    if (!watchlist.length) {
      return this.#send(this.#pick(
        '👀 قائمة المتابعة فارغة.\n\nافتح «🔥 العملات الصاعدة» ثم اختر عملة واضغط «👀 متابعة». بعدها ستصلك تحديثات عندما يتسارع الزخم، ولن يظهر تنبيه دخول إذا فشل الأمان.',
        '👀 Watchlist is empty.\n\nOpen Trending, choose a token, then tap Watch. You will receive acceleration updates, and no entry alert is sent if safety fails.'
      ), [[{ text: '🔥 الصاعدة', callback_data: 'menu:trending' }, { text: '⬅️ القائمة', callback_data: 'menu:home' }]]);
    }

    const entries = [];
    for (const address of watchlist.slice(0, 20)) {
      let snapshot = null;
      try { snapshot = await this.store.latestSnapshotForAddress(address); } catch {}
      if (!snapshot) {
        entries.push({ address, symbol: short(address), momentum: 0, safety: { ok: false }, quality: { ar: 'انتظار بيانات', en: 'Waiting for data' } });
        continue;
      }
      const p = normalizeMomentumSnapshot(snapshot);
      entries.push({ address, symbol: p.symbol, momentum: momentumScore(snapshot), safety: persistedSafety(snapshot), quality: entryQuality(snapshot) });
    }
    entries.sort((a, b) => b.momentum - a.momentum);
    const lines = entries.map((item, i) => `${i + 1}. ${item.safety.ok ? '✅' : '👀'} $${item.symbol} | Momentum ${item.momentum} | ${this.runtime.language === 'en' ? item.quality.en : item.quality.ar}`);
    const buttons = entries.slice(0, 10).map((item, i) => [{ text: `${i + 1}. $${item.symbol}`, callback_data: `token:detail:${item.address}` }, { text: '🗑️', callback_data: `watch:remove:${item.address}` }]);
    buttons.push([{ text: '🔄 تحديث', callback_data: 'menu:watchlist' }, { text: '⬅️ القائمة', callback_data: 'menu:home' }]);
    return this.#send(`${this.#pick('👀 العملات تحت المتابعة', '👀 Watched tokens')}\n\n${lines.join('\n')}`, buttons);
  }

  async #showTokenDetail(address) {
    if (!SOLANA_ADDRESS.test(address)) return this.#send(this.#pick('❌ عنوان العملة غير صالح.', '❌ Invalid token address.'));
    let snapshot = null;
    try { snapshot = await this.store.latestSnapshotForAddress(address); } catch {}
    if (!snapshot) {
      return this.#send(this.#pick(
        `⏳ لا توجد بيانات سوق محفوظة بعد لهذه العملة.\nCA: ${address}`,
        `⏳ No stored market snapshot is available yet for this token.\nCA: ${address}`
      ), [[{ text: '👀 متابعة', callback_data: `watch:add:${address}` }, { text: '📋 العقد', copy_text: { text: address } }]]);
    }

    const s = normalizeMomentumSnapshot(snapshot);
    const safety = persistedSafety(snapshot);
    const quality = entryQuality(snapshot);
    const momentum = momentumScore(snapshot);
    const ratio = s.buys30s / Math.max(1, s.sells30s);
    let image = s.imageUrl;
    let name = s.name;
    let symbol = s.symbol;
    if ((!image || !name || symbol === 'TOKEN') && this.heliusApiKey) {
      try {
        const meta = await fetchHeliusAssetMetadata(this.heliusApiKey, address);
        image = image ?? meta.imageUrl;
        name = meta.name ?? name;
        symbol = meta.symbol ?? symbol;
      } catch {}
    }
    const watching = await this.#watching(address).catch(() => false);
    const statusAr = safety.ok ? '✅ فحص الأمان: ناجح' : `👀 فحص الأمان: غير مكتمل/مرفوض\n${safety.reasons.slice(0, 4).join(' | ')}`;
    const statusEn = safety.ok ? '✅ Safety check: PASSED' : `👀 Safety check: incomplete/failed\n${safety.reasons.slice(0, 4).join(' | ')}`;
    const ar = [
      '🔥 SUMMECA TOKEN RADAR', '',
      `$${symbol} • ${name}`, '',
      `⏱️ العمر: ${ageLabel(snapshot, 'ar')} | 📍 ${s.source}`,
      `💵 السعر: $${priceText(s.priceUsd)}`,
      `MC: $${compactMoney(s.marketCapUsd)} | Vol 5m: $${compactMoney(s.volume5mUsd)}`,
      `💧 السيولة: $${compactMoney(s.liquidityUsd)}`,
      `🟢 شراء 30ث: ${s.buys30s.toFixed(1)} | 🔴 بيع: ${s.sells30s.toFixed(1)} | Ratio ${ratio.toFixed(2)}x`,
      `👥 مشترون: ${s.uniqueBuyers30s.toFixed(1)} | 5د: ${s.priceChange5mPct.toFixed(1)}%`,
      '',
      `⚡ Momentum ${momentum}/100 | 🎯 Entry ${Math.round(s.entryScore)}/100`,
      `🚀 Moon ${Math.round(s.moonScore)}/100 | 🛡️ Risk ${Math.round(s.riskScore)}/100`,
      quality.ar,
      statusAr,
      '',
      `CA: ${address}`
    ].join('\n');
    const en = [
      '🔥 SUMMECA TOKEN RADAR', '',
      `$${symbol} • ${name}`, '',
      `⏱️ Age: ${ageLabel(snapshot, 'en')} | 📍 ${s.source}`,
      `💵 Price: $${priceText(s.priceUsd)}`,
      `MC: $${compactMoney(s.marketCapUsd)} | Vol 5m: $${compactMoney(s.volume5mUsd)}`,
      `💧 Liquidity: $${compactMoney(s.liquidityUsd)}`,
      `🟢 Buys 30s: ${s.buys30s.toFixed(1)} | 🔴 Sells: ${s.sells30s.toFixed(1)} | Ratio ${ratio.toFixed(2)}x`,
      `👥 Buyers: ${s.uniqueBuyers30s.toFixed(1)} | 5m: ${s.priceChange5mPct.toFixed(1)}%`,
      '',
      `⚡ Momentum ${momentum}/100 | 🎯 Entry ${Math.round(s.entryScore)}/100`,
      `🚀 Moon ${Math.round(s.moonScore)}/100 | 🛡️ Risk ${Math.round(s.riskScore)}/100`,
      quality.en,
      statusEn,
      '',
      `CA: ${address}`
    ].join('\n');
    return this.#sendCard({ text: this.#pick(ar, en), imageUrl: image, keyboard: this.#tokenKeyboard(address, { watching, safe: safety.ok }) });
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
      '🆕 أحدث العملات التي تم إنشاؤها\n\nقائمة خام عند الطلب فقط. لا تعني أن العملة آمنة أو أنها فرصة دخول.',
      '🆕 Latest created coins\n\nRaw on-demand list only. It does not mean a token is safe or an entry opportunity.'
    ), [[{ text: '🔄 تحديث', callback_data: 'menu:newcoins' }, { text: '⬅️ القائمة', callback_data: 'menu:home' }]]);

    for (const row of rows) {
      const address = String(row.address ?? '');
      if (!SOLANA_ADDRESS.test(address)) continue;
      let meta = {};
      if (this.heliusApiKey) try { meta = await fetchHeliusAssetMetadata(this.heliusApiKey, address); } catch {}
      const symbol = meta.symbol ?? row.symbol ?? 'NEW';
      const name = meta.name ?? row.name ?? 'New Pump.fun coin';
      const createdAt = Number(row.createdAt ?? row.listedAt ?? Date.now());
      const ageSec = Math.max(0, Math.round((Date.now() - createdAt) / 1000));
      const caption = this.#pick(
        `🆕 $${symbol} — ${name}\nالعمر: ${ageSec}ث\nالحالة: خام — ليست إشارة دخول\nCA: ${address}`,
        `🆕 $${symbol} — ${name}\nAge: ${ageSec}s\nStatus: raw — not an entry signal\nCA: ${address}`
      );
      const watching = await this.#watching(address).catch(() => false);
      const keyboard = [
        [{ text: watching ? '🗑️ إلغاء المتابعة' : '👀 متابعة', callback_data: `${watching ? 'watch:remove' : 'watch:add'}:${address}` }, { text: '📋 CA', copy_text: { text: address } }],
        [{ text: '📊 تفاصيل الرادار', callback_data: `token:detail:${address}` }, { text: '⚡ Pump.fun', url: `https://pump.fun/coin/${encodeURIComponent(address)}` }],
        [{ text: '👻 Phantom', url: `https://phantom.com/tokens/solana/${encodeURIComponent(address)}` }]
      ];
      await this.#sendCard({ text: caption, imageUrl: meta.imageUrl, keyboard });
      await wait(150);
    }
  }

  async #showSignals() {
    let rows = [];
    try { rows = await this.store.listRecentSignals(8); } catch {}
    if (!rows.length) return this.#send(this.#pick('🔔 لا توجد إشارات محفوظة بعد.', '🔔 No stored signals yet.'), [[{ text: '⬅️ القائمة', callback_data: 'menu:home' }]]);
    const lines = rows.map((row, i) => {
      const token = row.tokens ?? {};
      const type = row.signal_type === 'entry' ? '🎯' : row.signal_type === 'moon' ? '🚀' : row.signal_type === 'exit' ? '🔴' : '👀';
      return `${i + 1}. ${type} $${token.symbol ?? 'TOKEN'} | Entry ${row.entry_score ?? '—'} | Moon ${row.moon_score ?? '—'} | Risk ${row.risk_score ?? '—'}`;
    });
    return this.#send(`${this.#pick('🔔 آخر الإشارات', '🔔 Recent signals')}\n\n${lines.join('\n')}`, [[{ text: '🔥 الصاعدة', callback_data: 'menu:trending' }, { text: '⬅️ القائمة', callback_data: 'menu:home' }]]);
  }

  async #showTrades() {
    let rows = [];
    try { rows = await this.store.listRecentPaperTrades(8); } catch {}
    if (!rows.length) return this.#send(this.#pick('🧪 لا توجد صفقات تجريبية محفوظة بعد.', '🧪 No stored paper trades yet.'), [[{ text: '⬅️ القائمة', callback_data: 'menu:home' }]]);
    const lines = rows.map((row, i) => {
      const token = row.tokens ?? {};
      const pnl = row.pnl_pct == null ? 'OPEN' : `${Number(row.pnl_pct).toFixed(1)}%`;
      const peak = row.peak_pnl_pct == null ? '—' : `${Number(row.peak_pnl_pct).toFixed(1)}%`;
      const size = row.size_usd == null ? '—' : `$${Number(row.size_usd).toFixed(2)}`;
      return `${i + 1}. $${token.symbol ?? 'TOKEN'} | ${row.status} | ${size} | PnL ${pnl} | Peak ${peak}`;
    });
    return this.#send(`🧪 ${this.#pick('الصفقات التجريبية', 'Paper trades')}\n\n${lines.join('\n')}\n\nStop: -${env.paperStopLossPct}% | Profit lock: +20% after +30%`, [[{ text: '⬅️ القائمة', callback_data: 'menu:home' }]]);
  }

  async #showSafety() {
    return this.#send(this.#pick(
      '🛡️ الحماية\n\n• إشارة «دخول معتمد» تتطلب سعرًا حقيقيًا + بيانات سوق مؤكدة + فحص أمان مؤكد + بيعًا واحدًا على الأقل + Risk ≤35.\n• العملات التي تفشل الأمان لا تحصل على زر تداول حقيقي من بطاقة الرادار.\n• متابعة العملات قد ترسل تحذيرًا إذا فقدت العملة اعتماد الأمان.\n• التداول الآلي الحقيقي مقفول افتراضيًا بمتغير LIVE_TRADING_ENABLED.\n• Paper Stop = -10% وحماية الربح تبدأ بعد +30% وتستهدف +20%.',
      '🛡️ Safety\n\n• “Entry approved” requires a real price + verified market data + verified security + at least one observed sell + Risk ≤35.\n• Tokens failing safety do not receive a live-trade button on radar cards.\n• Watchlist alerts warn when a token loses safety approval.\n• Autonomous live trading is locked by default with LIVE_TRADING_ENABLED.\n• Paper Stop = -10%; profit lock arms after +30% and targets +20%.'
    ), [[{ text: '⬅️ القائمة', callback_data: 'menu:home' }]]);
  }

  async #showHelp() {
    return this.#send(this.#pick(
      '❓ المساعدة\n\n/start أو /menu — لوحة التحكم\n/trending — أقوى العملات الصاعدة\n/watchlist — العملات التي تتابعها\n\nمن بطاقة العملة: تابعها، افتح Paper، أو إذا اجتازت الأمان افتح «تداول حقيقي» ثم شاشة تأكيد. التأكيد لا يرسل صفقة من الخادم؛ يفتح Phantom لتراجع وتوافق بنفسك.\n\nالعملات الجديدة خام ولا تعتبر توصية شراء.',
      '❓ Help\n\n/start or /menu — control panel\n/trending — strongest rising tokens\n/watchlist — watched tokens\n\nFrom a token card: watch it, use Paper, or if safety passes open Live Trade and then a confirmation screen. Confirmation does not send a server-side trade; it opens Phantom for your review and approval.\n\nNew coins are raw launches, not buy recommendations.'
    ), [[{ text: '⬅️ القائمة', callback_data: 'menu:home' }]]);
  }

  async #saveSetting(key, value) {
    if (this.settings?.enabled) await this.settings.set(key, String(value));
  }

  async #showPaperSizing(address) {
    if (!SOLANA_ADDRESS.test(address)) return this.#send(this.#pick('❌ عنوان العملة غير صالح.', '❌ Invalid token address.'));
    return this.#send(this.#pick(
      `🟢 شراء تجريبي من البوت\n\nاختر الحجم لـ ${short(address)}.\nالنسبة تُحسب من الرصيد التجريبي المتاح وقت التنفيذ.`,
      `🟢 In-bot PAPER buy\n\nChoose size for ${short(address)}.\nPercentages use currently available paper cash.`
    ), [
      [{ text: '10%', callback_data: `paper:buy:p10:${address}` }, { text: '20%', callback_data: `paper:buy:p20:${address}` }, { text: '50%', callback_data: `paper:buy:p50:${address}` }, { text: '100%', callback_data: `paper:buy:p100:${address}` }],
      [{ text: '$10', callback_data: `paper:buy:d10:${address}` }, { text: '$25', callback_data: `paper:buy:d25:${address}` }, { text: '$50', callback_data: `paper:buy:d50:${address}` }, { text: '$100', callback_data: `paper:buy:d100:${address}` }],
      [{ text: this.runtime.language === 'en' ? '💵 Custom USD amount' : '💵 مبلغ دولار آخر', callback_data: `paper:custom:${address}` }]
    ]);
  }

  async #showPaperSell(address) {
    if (!SOLANA_ADDRESS.test(address)) return this.#send(this.#pick('❌ عنوان العملة غير صالح.', '❌ Invalid token address.'));
    return this.#send(this.#pick(
      `🔴 بيع تجريبي\n\nاختر نسبة البيع من الصفقة المفتوحة لـ ${short(address)}.`,
      `🔴 PAPER sell\n\nChoose how much of the open position to sell for ${short(address)}.`
    ), [[{ text: '25%', callback_data: `paper:sell:p25:${address}` }, { text: '50%', callback_data: `paper:sell:p50:${address}` }, { text: '100%', callback_data: `paper:sell:p100:${address}` }]]);
  }

  async #executePaperBuy(address, mode, value) {
    if (!this.onPaperBuy) return this.#send(this.#pick('❌ خدمة الشراء التجريبي غير متاحة.', '❌ Paper buy service is unavailable.'));
    try {
      const result = await this.onPaperBuy({ address, mode, value });
      if (result?.status === 'filled') {
        const p = result.position;
        const warning = Array.isArray(result.warnings) && result.warnings.length ? `\n⚠️ ${result.warnings.join('، ')}` : '';
        return this.#send(this.#pick(
          `✅ تم الشراء التجريبي\n\n${p.symbol ?? 'TOKEN'}\nالحجم: $${Number(p.usdSize).toFixed(2)}\nالسعر: ${p.entryPriceUsd}\nالستوب: -10%\nحماية الربح: +20% بعد بلوغ +30%${warning}`,
          `✅ PAPER buy filled\n\n${p.symbol ?? 'TOKEN'}\nSize: $${Number(p.usdSize).toFixed(2)}\nPrice: ${p.entryPriceUsd}\nStop: -10%\nProfit lock: +20% after reaching +30%${warning}`
        ), [[{ text: this.runtime.language === 'en' ? '🔴 Sell this position' : '🔴 بيع هذه الصفقة', callback_data: `paper:sellmenu:${address}` }]]);
      }
      if (result?.status === 'queued') return this.#send(this.#pick(`⏳ تم حجز طلب Paper لـ ${short(address)} حتى يظهر سعر صالح.`, `⏳ PAPER buy queued for ${short(address)} until a valid price appears.`));
      return this.#send(this.#pick(`❌ لم يتم تنفيذ Paper: ${result?.reason ?? 'unknown'}`, `❌ PAPER buy not executed: ${result?.reason ?? 'unknown'}`));
    } catch (error) {
      return this.#send(this.#pick(`❌ تعذر تنفيذ Paper: ${error.message}`, `❌ PAPER buy failed: ${error.message}`));
    }
  }

  async #executePaperSell(address, percent) {
    if (!this.onPaperSell) return this.#send(this.#pick('❌ خدمة البيع التجريبي غير متاحة.', '❌ Paper sell service is unavailable.'));
    try {
      const result = await this.onPaperSell({ address, percent });
      if (result?.status === 'sold') {
        const sign = Number(result.legPnlUsd ?? 0) >= 0 ? '+' : '';
        const ar = [
          result.closed ? '✅ تم إغلاق الصفقة التجريبية بالكامل' : `✅ تم بيع ${Number(result.sellPct).toFixed(0)}%`, '',
          `${result.symbol ?? 'TOKEN'}`, `السعر: ${result.priceUsd}`,
          `نتيجة الجزء: ${sign}$${Number(result.legPnlUsd ?? 0).toFixed(2)} (${Number(result.legPnlPct ?? 0).toFixed(1)}%)`,
          result.closed ? `النتيجة الإجمالية: ${Number(result.totalPnlPct ?? 0).toFixed(1)}%` : `المتبقي: $${Number(result.remainingUsdSize ?? 0).toFixed(2)}`
        ].join('\n');
        const en = [
          result.closed ? '✅ PAPER position fully closed' : `✅ Sold ${Number(result.sellPct).toFixed(0)}%`, '',
          `${result.symbol ?? 'TOKEN'}`, `Price: ${result.priceUsd}`,
          `Leg result: ${sign}$${Number(result.legPnlUsd ?? 0).toFixed(2)} (${Number(result.legPnlPct ?? 0).toFixed(1)}%)`,
          result.closed ? `Total: ${Number(result.totalPnlPct ?? 0).toFixed(1)}%` : `Remaining: $${Number(result.remainingUsdSize ?? 0).toFixed(2)}`
        ].join('\n');
        return this.#send(this.#pick(ar, en), result.closed ? undefined : [[{ text: '🔴 بيع المزيد', callback_data: `paper:sellmenu:${address}` }]]);
      }
      return this.#send(this.#pick(`❌ لم يتم البيع: ${result?.reason ?? 'unknown'}`, `❌ PAPER sell not executed: ${result?.reason ?? 'unknown'}`));
    } catch (error) {
      return this.#send(this.#pick(`❌ تعذر البيع: ${error.message}`, `❌ PAPER sell failed: ${error.message}`));
    }
  }

  async #showLiveTradeMenu(address) {
    if (!SOLANA_ADDRESS.test(address)) return this.#send(this.#pick('❌ عنوان العملة غير صالح.', '❌ Invalid token address.'));
    let snapshot = null;
    try { snapshot = await this.store.latestSnapshotForAddress(address); } catch {}
    const safety = snapshot ? persistedSafety(snapshot) : { ok: false, reasons: ['market snapshot unavailable'] };
    if (!safety.ok) {
      return this.#send(this.#pick(
        `⛔ التداول الحقيقي السريع غير متاح لهذه العملة لأن بوابة الأمان لم تجتز:\n${safety.reasons.slice(0, 5).join(' | ')}\n\nيمكنك مراقبة العملة أو استخدام Paper.`,
        `⛔ Quick live trading is unavailable because the safety gate did not pass:\n${safety.reasons.slice(0, 5).join(' | ')}\n\nYou can watch the token or use Paper.`
      ), [[{ text: '🧪 Paper', callback_data: `paper:menu:${address}` }, { text: '⬅️ التفاصيل', callback_data: `token:detail:${address}` }]]);
    }
    const p = normalizeMomentumSnapshot(snapshot);
    const quality = entryQuality(snapshot);
    return this.#send(this.#pick(
      `⚡ تأكيد التداول الحقيقي\n\n$${p.symbol}\n${quality.ar}\nEntry ${Math.round(p.entryScore)}/100 | Risk ${Math.round(p.riskScore)}/100\n\nهذه الشاشة لا تنفذ صفقة من الخادم. الزر التالي يفتح Phantom لتراجع السعر والمبلغ ثم تؤكد بنفسك.\nالمحرك الآلي المستقل: ${env.liveTradingEnabled ? 'مفعّل بالإعدادات' : 'مقفول'}.`,
      `⚡ Confirm live trade\n\n$${p.symbol}\n${quality.en}\nEntry ${Math.round(p.entryScore)}/100 | Risk ${Math.round(p.riskScore)}/100\n\nThis screen does not send a server-side trade. The next button opens Phantom so you can review price/amount and approve yourself.\nAutonomous engine: ${env.liveTradingEnabled ? 'enabled by configuration' : 'locked'}.`
    ), [
      [{ text: '🟢 تأكيد وفتح شراء Phantom', url: phantomSwapUrl(address, 'buy') }],
      [{ text: '🔴 تأكيد وفتح بيع Phantom', url: phantomSwapUrl(address, 'sell') }],
      [{ text: '🧪 Paper بدلًا منه', callback_data: `paper:menu:${address}` }],
      [{ text: '❌ إلغاء', callback_data: `token:detail:${address}` }]
    ]);
  }

  async #handleCallback(callback) {
    if (String(callback?.message?.chat?.id ?? '') !== this.chatId) return;
    const data = String(callback?.data ?? '');
    await this.#answerCallback(callback.id);

    if (data === 'menu:home') return this.showMainMenu();
    if (data === 'menu:status') return this.#showStatus();
    if (data === 'menu:trending') return this.#showTrending(10);
    if (data === 'menu:trending20') return this.#showTrending(20);
    if (data === 'menu:watchlist') return this.#showWatchlist();
    if (data === 'menu:newcoins') return this.#showNewCoins();
    if (data === 'menu:signals') return this.#showSignals();
    if (data === 'menu:trades') return this.#showTrades();
    if (data === 'menu:wallet') return this.#showWallet();
    if (data === 'menu:settings') return this.#showSettings();
    if (data === 'menu:safety') return this.#showSafety();
    if (data === 'menu:help') return this.#showHelp();
    if (data === 'settings:language') return this.#showLanguage();

    if (data.startsWith('token:detail:')) return this.#showTokenDetail(data.slice('token:detail:'.length));
    if (data.startsWith('live:menu:')) return this.#showLiveTradeMenu(data.slice('live:menu:'.length));

    if (data.startsWith('watch:add:')) {
      const address = data.slice('watch:add:'.length);
      if (!SOLANA_ADDRESS.test(address)) return;
      const list = await this.#loadWatchlist();
      if (!list.includes(address)) list.unshift(address);
      await this.#saveWatchlist(list);
      await this.#answerCallback(callback.id, this.runtime.language === 'en' ? 'Added to watchlist' : 'تمت الإضافة للمتابعة');
      return this.#showTokenDetail(address);
    }
    if (data.startsWith('watch:remove:')) {
      const address = data.slice('watch:remove:'.length);
      const list = (await this.#loadWatchlist()).filter((value) => value !== address);
      await this.#saveWatchlist(list);
      await this.#answerCallback(callback.id, this.runtime.language === 'en' ? 'Removed from watchlist' : 'تم إلغاء المتابعة');
      return data.includes('watch:remove:') ? this.#showWatchlist() : undefined;
    }

    if (data.startsWith('paper:menu:')) return this.#showPaperSizing(data.slice('paper:menu:'.length));
    if (data.startsWith('paper:sellmenu:')) return this.#showPaperSell(data.slice('paper:sellmenu:'.length));
    if (data.startsWith('paper:buy:')) {
      const match = data.match(/^paper:buy:([pd])(\d+(?:\.\d+)?):([1-9A-HJ-NP-Za-km-z]{32,44})$/);
      if (!match) return this.#send(this.#pick('❌ خيار الشراء غير صالح.', '❌ Invalid buy option.'));
      const [, kind, rawValue, address] = match;
      return this.#executePaperBuy(address, kind === 'p' ? 'percent' : 'usd', Number(rawValue));
    }
    if (data.startsWith('paper:sell:')) {
      const match = data.match(/^paper:sell:p(25|50|100):([1-9A-HJ-NP-Za-km-z]{32,44})$/);
      if (!match) return this.#send(this.#pick('❌ خيار البيع غير صالح.', '❌ Invalid sell option.'));
      return this.#executePaperSell(match[2], Number(match[1]));
    }
    if (data.startsWith('paper:custom:')) {
      const address = data.slice('paper:custom:'.length);
      if (!SOLANA_ADDRESS.test(address)) return this.#send(this.#pick('❌ عنوان العملة غير صالح.', '❌ Invalid token address.'));
      this.awaitingPaperAmountFor = address;
      return this.#send(this.#pick('💵 أرسل مبلغ الدولار الآن، مثال: 35', '💵 Send the USD amount now, for example: 35'));
    }
    if (data.startsWith('token:ca:')) {
      const address = data.slice('token:ca:'.length);
      if (SOLANA_ADDRESS.test(address)) return this.#send(`${this.#pick('📄 عنوان العملة', '📄 Token CA')}\n\n${address}`);
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
        '🔗 أرسل عنوان محفظة Solana العام فقط للمراقبة.\n⚠️ لا ترسل Seed Phrase أو Private Key.',
        '🔗 Send only a public Solana address for monitoring.\n⚠️ Never send a seed phrase or private key.'
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
        `🛡️ التداول الحقيقي\n\nSUMMECA Trading Wallet: ${env.privyWalletAddress ? short(env.privyWalletAddress) : 'غير مهيأة'}\nالمحرك الآلي: ${env.liveTradingEnabled ? '🟠 مفعّل' : '🔒 مقفول'}\n\nمن بطاقة عملة آمنة يمكن فتح شاشة «تداول حقيقي» ثم Phantom للمراجعة والتأكيد. البوت لا يطلب Seed Phrase.`,
        `🛡️ Live trading\n\nSUMMECA Trading Wallet: ${env.privyWalletAddress ? short(env.privyWalletAddress) : 'not configured'}\nAutonomous engine: ${env.liveTradingEnabled ? '🟠 Enabled' : '🔒 Locked'}\n\nFrom a safety-approved token card, open Live Trade then Phantom to review and approve. The bot never asks for a seed phrase.`
      ), [[{ text: '🔥 العملات الصاعدة', callback_data: 'menu:trending' }, { text: '⬅️ المحفظة', callback_data: 'menu:wallet' }]]);
    }
  }

  async #handleMessage(message) {
    if (String(message?.chat?.id ?? '') !== this.chatId || message?.chat?.type !== 'private') return;
    const text = String(message?.text ?? '').trim();
    if (/^\/(start|menu)(?:\s|$)/i.test(text)) return this.showMainMenu();
    if (/^\/trending(?:\s|$)/i.test(text)) return this.#showTrending(10);
    if (/^\/watchlist(?:\s|$)/i.test(text)) return this.#showWatchlist();

    if (this.awaitingPaperAmountFor) {
      const address = this.awaitingPaperAmountFor;
      this.awaitingPaperAmountFor = '';
      const value = Number(text.replace(/[$,\s]/g, ''));
      if (!Number.isFinite(value) || value <= 0) return this.#send(this.#pick('❌ المبلغ غير صالح.', '❌ Invalid amount.'));
      return this.#executePaperBuy(address, 'usd', value);
    }

    if (this.awaitingWallet) {
      this.awaitingWallet = false;
      if (!SOLANA_ADDRESS.test(text)) {
        return this.#send(this.#pick('❌ هذا ليس عنوان Solana عامًا صالحًا. ولا ترسل أي مفتاح خاص.', '❌ That is not a valid public Solana address. Never send a private key.'), [[{ text: '👛 المحفظة', callback_data: 'menu:wallet' }]]);
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
        { command: 'trending', description: 'Show strongest trending tokens' },
        { command: 'watchlist', description: 'Show watched tokens' },
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
