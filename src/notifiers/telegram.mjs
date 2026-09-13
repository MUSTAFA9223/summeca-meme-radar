export async function telegramApi(token, method, body = {}) {
  if (!token) throw new Error('TELEGRAM_BOT_TOKEN is required');
  const response = await fetch(`https://api.telegram.org/bot${token}/${method}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body)
  });
  const payload = await response.json().catch(() => null);
  if (!response.ok || !payload?.ok) {
    throw new Error(`Telegram ${method} HTTP ${response.status}${payload?.description ? `: ${payload.description}` : ''}`);
  }
  return payload.result;
}

export async function discoverPrivateStartChat(token) {
  const updates = await telegramApi(token, 'getUpdates', {
    limit: 100,
    timeout: 0,
    allowed_updates: ['message']
  });

  const starts = (Array.isArray(updates) ? updates : [])
    .map((update) => update?.message)
    .filter((message) => message?.chat?.type === 'private' && /^\/start(?:\s|$)/i.test(String(message?.text ?? '')));

  const ids = [...new Set(starts.map((message) => String(message.chat.id)))];
  if (ids.length === 0) {
    throw new Error('No private /start message found. Open the bot in Telegram and press Start, then retry.');
  }
  if (ids.length > 1) {
    throw new Error('Multiple private /start chats found. Set TELEGRAM_CHAT_ID explicitly before sending alerts.');
  }
  return ids[0];
}

export const normalizeTelegramLanguage = (language) => {
  const value = String(language ?? 'ar').trim().toLowerCase();
  return ['ar', 'en', 'bilingual'].includes(value) ? value : 'ar';
};

const money = (value) => Number(value ?? 0).toLocaleString('en-US', { maximumFractionDigits: 0 });
const compactMoney = (value) => {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return '—';
  if (n >= 1_000_000_000) return `${(n / 1_000_000_000).toFixed(n >= 10_000_000_000 ? 0 : 1)}B`;
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(n >= 10_000_000 ? 0 : 1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(n >= 10_000 ? 0 : 1)}K`;
  return n.toFixed(n >= 100 ? 0 : 1);
};
const price = (value) => {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return null;
  if (n >= 0.01) return n.toLocaleString('en-US', { maximumFractionDigits: 8 });
  return n.toExponential(6);
};
const pct = (value) => `${Number(value ?? 0).toLocaleString('en-US', { maximumFractionDigits: 1 })}%`;

const sourceLabel = (source) => {
  const value = String(source ?? '').toLowerCase();
  if (value.includes('pump_amm') || value.includes('pumpswap')) return 'PumpSwap (Pump.fun)';
  if (value.includes('pump')) return 'Pump.fun';
  if (value.includes('raydium')) return 'Raydium';
  if (value.includes('meteora')) return 'Meteora';
  if (value.includes('orca')) return 'Orca';
  return source ? String(source) : 'Solana';
};

const phantomSwapUrl = (mint, side = 'buy') => {
  const caip19 = `solana:101/address:${mint}`;
  if (side === 'sell') {
    return `https://phantom.app/ul/v1/swap?buy=&sell=${encodeURIComponent(caip19)}`;
  }
  return `https://phantom.app/ul/v1/swap?buy=${encodeURIComponent(caip19)}&sell=`;
};

const tokenKeyboard = (address, language = 'ar', { early = false } = {}) => {
  const mint = String(address ?? '').trim();
  if (!mint) return undefined;
  const ar = language !== 'en';
  const dexUrl = `https://dexscreener.com/solana/${encodeURIComponent(mint)}`;
  const phantomTokenUrl = `https://phantom.com/tokens/solana/${encodeURIComponent(mint)}`;
  const fomoUrl = `https://fomo.family/tokens/solana/${encodeURIComponent(mint)}`;

  return {
    inline_keyboard: [
      [
        { text: ar ? '🟢 شراء سريع' : '🟢 Quick buy', url: phantomSwapUrl(mint, 'buy') },
        { text: ar ? '🔴 بيع' : '🔴 Sell', url: phantomSwapUrl(mint, 'sell') },
        { text: ar ? '📋 العقد' : '📋 CA', copy_text: { text: mint } }
      ],
      [
        { text: '📊 DEX', url: dexUrl },
        { text: '⚡ Quick Buy', url: phantomSwapUrl(mint, 'buy') },
        { text: '🔥 FOMO', url: fomoUrl },
        { text: '👻 Phantom', url: phantomTokenUrl }
      ],
      ...(early ? [[{ text: ar ? '🚀 Pump.fun' : '🚀 Pump.fun', url: `https://pump.fun/coin/${encodeURIComponent(mint)}` }]] : []),
      [
        { text: ar ? '🧪 شراء Paper' : '🧪 Paper buy', callback_data: `paper:menu:${mint}` },
        { text: ar ? '🧪 بيع Paper' : '🧪 Paper sell', callback_data: `paper:sellmenu:${mint}` }
      ],
      [
        { text: '10%', callback_data: `paper:buy:p10:${mint}` },
        { text: '20%', callback_data: `paper:buy:p20:${mint}` },
        { text: '50%', callback_data: `paper:buy:p50:${mint}` },
        { text: '100%', callback_data: `paper:buy:p100:${mint}` }
      ],
      [
        { text: ar ? '💵 مبلغ بالدولار' : '💵 USD amount', callback_data: `paper:custom:${mint}` },
        { text: ar ? '📄 إرسال CA' : '📄 Send CA', callback_data: `token:ca:${mint}` }
      ]
    ]
  };
};

const translateExitReason = (reason) => {
  const text = String(reason ?? 'غير محدد');
  if (text === 'paper stop-loss') return 'وقف خسارة تجريبي';
  if (text === 'manual paper sell') return 'بيع يدوي من البوت';
  if (text.startsWith('profit lock target')) return text.replace('profit lock target', 'حماية ربح مستهدفة');
  if (text === 'momentum reversal after peak') return 'انعكاس الزخم بعد القمة';
  if (text.startsWith('adaptive trailing exit')) return text.replace('adaptive trailing exit', 'خروج متحرك تكيفي');
  if (text.startsWith('emergency-risk:')) return text.replace('emergency-risk:', 'مخاطرة طارئة:');
  return text;
};

export class TelegramNotifier {
  constructor(token, chatId, language = 'ar') {
    this.token = token;
    this.chatId = chatId;
    this.language = normalizeTelegramLanguage(language);
  }

  get enabled() {
    return Boolean(this.token && this.chatId);
  }

  setLanguage(language) {
    this.language = normalizeTelegramLanguage(language);
  }

  async #send(text, extra = {}) {
    if (!this.enabled) return null;
    return telegramApi(this.token, 'sendMessage', { chat_id: this.chatId, text, ...extra });
  }

  #pick(ar, en) {
    if (this.language === 'en') return en;
    if (this.language === 'bilingual') return `${ar}\n\n────────────\n\n${en}`;
    return ar;
  }

  async test() {
    return this.#send(this.#pick(
      '✅ تم ربط SUMMECA Meme Radar بنجاح\n\nتنبيهات الرادار جاهزة. الشراء/البيع الحقيقي متاح عبر أزرار Phantom مع تأكيدك داخل المحفظة؛ البوت نفسه لا يحتفظ بمفتاح خاص ولا يوقّع عنك.',
      '✅ SUMMECA Meme Radar connected\n\nRadar alerts are ready. Wallet-confirmed live buy/sell links open Phantom for your approval; the bot never stores your private key or signs for you.'
    ));
  }

  async earlyCreate(candidate, event = {}) {
    if (!this.enabled || !candidate?.address) return null;
    const mint = String(candidate.address);
    const ar = [
      '⚡ NEW CREATE — تم إنشاء عملة الآن',
      '',
      `${candidate.symbol && candidate.symbol !== 'NEW' ? candidate.symbol : 'عملة Pump.fun جديدة'}${candidate.name && candidate.name !== 'New Pump.fun coin' ? ` — ${candidate.name}` : ''}`,
      'المرحلة: 🟢 إنشاء مباشر على Pump.fun',
      `Slot: ${event.slot ?? '—'}`,
      '',
      '⚠️ لم تجتز العملة بعد فحوص السيولة والأمان والزخم.',
      'يمكنك فتح مبادلة Phantom الحقيقية من الأزرار ثم تأكيدها داخل المحفظة، أو استخدام Paper للاختبار.',
      '',
      `CA: ${mint}`
    ].join('\n');
    const en = [
      '⚡ NEW CREATE — coin created now',
      '',
      `${candidate.symbol && candidate.symbol !== 'NEW' ? candidate.symbol : 'New Pump.fun coin'}${candidate.name && candidate.name !== 'New Pump.fun coin' ? ` — ${candidate.name}` : ''}`,
      'Stage: 🟢 direct Pump.fun creation',
      `Slot: ${event.slot ?? '—'}`,
      '',
      '⚠️ Liquidity, safety, and momentum checks have NOT passed yet.',
      'You may open a real Phantom swap from the buttons and approve it in-wallet, or use PAPER for testing.',
      '',
      `CA: ${mint}`
    ].join('\n');
    return this.#send(this.#pick(ar, en), { reply_markup: tokenKeyboard(mint, this.language, { early: true }) });
  }

  async signal(s, sc, p, { replyToMessageId = null } = {}) {
    const currentPrice = price(s.priceUsd);
    const buyers = Number(s.buys30s ?? 0);
    const sellers = Number(s.sells30s ?? 0);
    const uniqueBuyers = Number(s.uniqueBuyers30s ?? 0);
    const venue = sourceLabel(s.source);
    const marketCap = compactMoney(s.marketCapUsd);
    const volume5m = compactMoney(s.volume5mUsd);
    const liquidity = compactMoney(s.liquidityUsd);
    const symbol = String(s.symbol ?? 'TOKEN').replace(/^\$/, '');
    const displayName = String(s.name ?? symbol);

    const ar = [
      '🔥 SUMMECA TRENDING — إشارة زخم قوية',
      '',
      `$${symbol}  •  ${displayName}`,
      '',
      `CA: ${s.address}`,
      '',
      `MC: $${marketCap}  |  Vol 5m: $${volume5m}`,
      `💧 Liquidity: $${liquidity}  |  💵 Price: ${currentPrice ? `$${currentPrice}` : '—'}`,
      `🟢 Buy 30s: ${buyers}  |  🔴 Sell 30s: ${sellers}  |  👥 ${uniqueBuyers}`,
      '',
      `🎯 Entry ${sc.entry}/100  |  🚀 Moon ${sc.moon}/100  |  🛡️ Risk ${sc.risk}/100`,
      '✅ Scam Check: PASSED',
      `📍 ${venue}`,
      p ? `🧪 Paper: $${p.usdSize.toFixed(2)} @ ${p.entryPriceUsd}` : '👀 Strong Watch — المتابعة بدأت',
      '',
      '🔗 DEX | Quick Buy | FOMO | Phantom ↓'
    ].join('\n');

    const en = [
      '🔥 SUMMECA TRENDING — STRONG MOMENTUM',
      '',
      `$${symbol}  •  ${displayName}`,
      '',
      `CA: ${s.address}`,
      '',
      `MC: $${marketCap}  |  Vol 5m: $${volume5m}`,
      `💧 Liquidity: $${liquidity}  |  💵 Price: ${currentPrice ? `$${currentPrice}` : '—'}`,
      `🟢 Buy 30s: ${buyers}  |  🔴 Sell 30s: ${sellers}  |  👥 ${uniqueBuyers}`,
      '',
      `🎯 Entry ${sc.entry}/100  |  🚀 Moon ${sc.moon}/100  |  🛡️ Risk ${sc.risk}/100`,
      '✅ Scam Check: PASSED',
      `📍 ${venue}`,
      p ? `🧪 Paper: $${p.usdSize.toFixed(2)} @ ${p.entryPriceUsd}` : '👀 Strong Watch — tracking started',
      '',
      '🔗 DEX | Quick Buy | FOMO | Phantom ↓'
    ].join('\n');

    const text = this.#pick(ar, en);
    const replyMarkup = tokenKeyboard(s.address, this.language, { early: venue.includes('Pump.fun') });
    const reply = replyToMessageId ? {
      reply_parameters: { message_id: Number(replyToMessageId), allow_sending_without_reply: true }
    } : {};

    if (s.imageUrl) {
      try {
        if (text.length <= 1000) {
          return await telegramApi(this.token, 'sendPhoto', {
            chat_id: this.chatId,
            photo: s.imageUrl,
            caption: text,
            ...reply,
            ...(replyMarkup ? { reply_markup: replyMarkup } : {})
          });
        }
        const photo = await telegramApi(this.token, 'sendPhoto', {
          chat_id: this.chatId,
          photo: s.imageUrl,
          caption: this.language === 'en' ? `🔥 SUMMECA TRENDING\n$${symbol} • ${displayName}` : `🔥 SUMMECA TRENDING\n$${symbol} • ${displayName}`,
          ...reply
        });
        return await this.#send(text, {
          reply_parameters: { message_id: Number(photo.message_id), allow_sending_without_reply: true },
          ...(replyMarkup ? { reply_markup: replyMarkup } : {})
        });
      } catch (error) {
        console.warn('[telegram:photo]', error.message);
      }
    }
    return this.#send(text, { ...reply, ...(replyMarkup ? { reply_markup: replyMarkup } : {}) });
  }

  async signalUpdate(s, sc, event) {
    if (!this.enabled || !event?.thread?.rootMessageId) return null;
    const buyers = Number(s.buys30s ?? 0);
    const sellers = Number(s.sells30s ?? 0);
    const currentPrice = price(event.priceUsd ?? s.priceUsd);
    const venue = sourceLabel(s.source);
    const controls = tokenKeyboard(s.address, this.language, { early: venue.includes('Pump.fun') });
    const reply = {
      reply_parameters: {
        message_id: event.thread.rootMessageId,
        allow_sending_without_reply: true
      },
      ...(controls ? { reply_markup: controls } : {})
    };

    if (event.type === 'reference') {
      const ar = [
        `📍 بدأ مرجع المتابعة — ${s.symbol}`,
        `المصدر: ${venue}`,
        `السعر المرجعي: $${currentPrice}`,
        `🟢 المشترون 30ث: ${buyers} | 🔴 البائعون 30ث: ${sellers}`,
        `السيولة: $${money(s.liquidityUsd)}`,
        'سأرسل التحديثات القادمة كردود على الإشارة الأصلية.'
      ].join('\n');
      const en = [
        `📍 Tracking reference set — ${s.symbol}`,
        `Source: ${venue}`,
        `Reference price: $${currentPrice}`,
        `🟢 Buys 30s: ${buyers} | 🔴 Sells 30s: ${sellers}`,
        `Liquidity: $${money(s.liquidityUsd)}`,
        'Future performance updates will reply to the original signal.'
      ].join('\n');
      return this.#send(this.#pick(ar, en), reply);
    }

    const ar = [
      `🚀 تحديث ${s.symbol} — تجاوز +${event.milestonePct}%`,
      '',
      `الصعود من الإشارة: +${pct(event.returnPct)}`,
      `أعلى صعود مسجل: +${pct(event.peakReturnPct)}`,
      `السعر الحالي: ${currentPrice ? `$${currentPrice}` : '—'}`,
      `السيولة: $${money(s.liquidityUsd)}`,
      `🟢 المشترون 30ث: ${buyers} | 🔴 البائعون 30ث: ${sellers}`,
      `👥 مشترون مختلفون: ${Number(s.uniqueBuyers30s ?? 0)}`,
      `حجم الشراء: $${money(s.buyVolume30sUsd)} | البيع: $${money(s.sellVolume30sUsd)}`,
      `Entry ${sc.entry}/100 | Moon ${sc.moon}/100 | Risk ${sc.risk}/100`
    ].join('\n');
    const en = [
      `🚀 ${s.symbol} update — crossed +${event.milestonePct}%`,
      '',
      `Return from signal: +${pct(event.returnPct)}`,
      `Peak recorded: +${pct(event.peakReturnPct)}`,
      `Current price: ${currentPrice ? `$${currentPrice}` : '—'}`,
      `Liquidity: $${money(s.liquidityUsd)}`,
      `🟢 Buys 30s: ${buyers} | 🔴 Sells 30s: ${sellers}`,
      `👥 Unique buyers: ${Number(s.uniqueBuyers30s ?? 0)}`,
      `Buy volume: $${money(s.buyVolume30sUsd)} | Sell: $${money(s.sellVolume30sUsd)}`,
      `Entry ${sc.entry}/100 | Moon ${sc.moon}/100 | Risk ${sc.risk}/100`
    ].join('\n');
    return this.#send(this.#pick(ar, en), reply);
  }

  async exit(p) {
    const pnl = (p.pnlPct ?? 0).toFixed(1);
    const ar = `🧪 خروج تجريبي — ${p.symbol}\nالربح/الخسارة: ${pnl}%\nالسبب: ${translateExitReason(p.exitReason)}`;
    const en = `🧪 PAPER EXIT ${p.symbol}\nPnL: ${pnl}%\nReason: ${p.exitReason ?? 'n/a'}`;
    return this.#send(this.#pick(ar, en));
  }
}
