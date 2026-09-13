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

const tokenKeyboard = (address, language = 'ar') => {
  const mint = String(address ?? '').trim();
  if (!mint) return undefined;
  const ar = language !== 'en';
  return {
    inline_keyboard: [
      [{ text: ar ? '📋 نسخ عنوان العملة CA' : '📋 Copy token CA', copy_text: { text: mint } }],
      [
        { text: '👻 Phantom', url: `https://phantom.com/tokens/solana/${encodeURIComponent(mint)}` },
        { text: '🔥 Fomo', url: `https://fomo.family/tokens/solana/${encodeURIComponent(mint)}` }
      ]
    ]
  };
};

const translateExitReason = (reason) => {
  const text = String(reason ?? 'غير محدد');
  if (text === 'paper stop-loss') return 'وقف خسارة تجريبي';
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
      '✅ تم ربط SUMMECA Meme Radar بنجاح\n\nالتنبيهات الحية جاهزة. التداول الحقيقي ما زال مغلقًا، والوضع الحالي تداول تجريبي فقط.',
      '✅ SUMMECA Meme Radar connected\n\nLive alerts are ready. Trading remains PAPER ONLY.'
    ));
  }

  async signal(s, sc, p) {
    const currentPrice = price(s.priceUsd);
    const buyers = Number(s.buys30s ?? 0);
    const sellers = Number(s.sells30s ?? 0);
    const uniqueBuyers = Number(s.uniqueBuyers30s ?? 0);
    const venue = sourceLabel(s.source);
    const ar = [
      '🔥 إشارة قوية — SUMMECA Meme Radar',
      '',
      `${s.symbol} — ${s.name}`,
      `المصدر/منصة الإطلاق: ${venue}`,
      'فتح/تحقق: Phantom أو Fomo من الأزرار أسفل التنبيه',
      `السعر: ${currentPrice ? `$${currentPrice}` : 'غير متاح بعد'}`,
      `السيولة: $${money(s.liquidityUsd)}`,
      `🟢 المشترون 30ث: ${buyers} | 🔴 البائعون 30ث: ${sellers}`,
      `👥 مشترون مختلفون: ${uniqueBuyers}`,
      `حجم الشراء 30ث: $${money(s.buyVolume30sUsd)} | البيع: $${money(s.sellVolume30sUsd)}`,
      '',
      `درجة الدخول: ${sc.entry}/100 | فرصة الصعود: ${sc.moon}/100 | المخاطرة: ${sc.risk}/100`,
      p ? `🧪 شراء تجريبي: $${p.usdSize.toFixed(2)} بسعر ${p.entryPriceUsd}` : '👀 مراقبة قوية — لم يتم تنفيذ شراء تجريبي',
      !currentPrice ? 'ℹ️ ستبدأ نسبة الصعود من أول سعر صالح يظهر بعد الإشارة.' : '📈 بدأت متابعة الأداء من سعر هذه الإشارة.',
      '',
      `CA: ${s.address}`
    ].join('\n');

    const en = [
      '🔥 STRONG SIGNAL — SUMMECA Meme Radar',
      '',
      `${s.symbol} — ${s.name}`,
      `Launch/source venue: ${venue}`,
      'Open/verify: Phantom or Fomo using the buttons below',
      `Price: ${currentPrice ? `$${currentPrice}` : 'not available yet'}`,
      `Liquidity: $${money(s.liquidityUsd)}`,
      `🟢 Buys 30s: ${buyers} | 🔴 Sells 30s: ${sellers}`,
      `👥 Unique buyers: ${uniqueBuyers}`,
      `Buy volume 30s: $${money(s.buyVolume30sUsd)} | Sell: $${money(s.sellVolume30sUsd)}`,
      '',
      `Entry: ${sc.entry}/100 | Moon: ${sc.moon}/100 | Risk: ${sc.risk}/100`,
      p ? `🧪 PAPER BUY: $${p.usdSize.toFixed(2)} @ ${p.entryPriceUsd}` : '👀 Strong watch — no paper buy executed',
      !currentPrice ? 'ℹ️ Performance tracking starts from the first valid price after the signal.' : '📈 Performance tracking started from this signal price.',
      '',
      `CA: ${s.address}`
    ].join('\n');

    const text = this.#pick(ar, en);
    const replyMarkup = tokenKeyboard(s.address, this.language);
    if (s.imageUrl) {
      try {
        return await telegramApi(this.token, 'sendPhoto', {
          chat_id: this.chatId,
          photo: s.imageUrl,
          caption: text,
          ...(replyMarkup ? { reply_markup: replyMarkup } : {})
        });
      } catch (error) {
        console.warn('[telegram:photo]', error.message);
      }
    }
    return this.#send(text, replyMarkup ? { reply_markup: replyMarkup } : {});
  }

  async signalUpdate(s, sc, event) {
    if (!this.enabled || !event?.thread?.rootMessageId) return null;
    const buyers = Number(s.buys30s ?? 0);
    const sellers = Number(s.sells30s ?? 0);
    const currentPrice = price(event.priceUsd ?? s.priceUsd);
    const venue = sourceLabel(s.source);
    const reply = {
      reply_parameters: {
        message_id: event.thread.rootMessageId,
        allow_sending_without_reply: true
      }
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
