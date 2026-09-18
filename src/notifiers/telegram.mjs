import { ageLabel, entryQuality, momentumScore } from '../core/momentumProfile.mjs';

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
  if (ids.length === 0) throw new Error('No private /start message found. Open the bot in Telegram and press Start, then retry.');
  if (ids.length > 1) throw new Error('Multiple private /start chats found. Set TELEGRAM_CHAT_ID explicitly before sending alerts.');
  return ids[0];
}

export const normalizeTelegramLanguage = () => 'ar';

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
const escapeHtml = (value) => String(value ?? '')
  .replaceAll('&', '&amp;')
  .replaceAll('<', '&lt;')
  .replaceAll('>', '&gt;');
const boldTelegram = (value) => `<b>${escapeHtml(value)}</b>`;

const sourceLabel = (source) => {
  const value = String(source ?? '').toLowerCase();
  if (value.includes('pump_amm') || value.includes('pumpswap')) return 'PumpSwap (Pump.fun)';
  if (value.includes('pump')) return 'Pump.fun';
  if (value.includes('raydium')) return 'Raydium';
  if (value.includes('meteora')) return 'Meteora';
  if (value.includes('orca')) return 'Orca';
  if (value.includes('geckoterminal')) return `GeckoTerminal • ${String(source).split(':')[1] ?? 'Solana'}`;
  return source ? String(source) : 'Solana';
};

const tokenKeyboard = (address, language = 'ar', { early = false, safe = false } = {}) => {
  const mint = String(address ?? '').trim();
  if (!mint) return undefined;
  const ar = language !== 'en';
  const rows = [
    [
      { text: ar ? '👀 متابعة' : '👀 Watch', callback_data: `watch:add:${mint}` },
      { text: ar ? '📋 العقد' : '📋 CA', copy_text: { text: mint } }
    ],
    [
      { text: '📊 DEX', url: `https://dexscreener.com/solana/${encodeURIComponent(mint)}` },
      { text: '🔥 FOMO', url: `https://fomo.family/tokens/solana/${encodeURIComponent(mint)}` },
      { text: '👻 فانتوم', url: `https://phantom.com/tokens/solana/${encodeURIComponent(mint)}` }
    ],
    ...(early ? [[{ text: '🚀 Pump.fun', url: `https://pump.fun/coin/${encodeURIComponent(mint)}` }]] : []),
    [
      { text: ar ? '🧪 شراء تجريبي' : '🧪 Paper buy', callback_data: `paper:menu:${mint}` },
      { text: ar ? '🧪 بيع تجريبي' : '🧪 Paper sell', callback_data: `paper:sellmenu:${mint}` }
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
  ];
  if (safe) rows.splice(2, 0, [{ text: ar ? '⚡ تداول حقيقي — تأكيد' : '⚡ Live trade — confirm', callback_data: `live:menu:${mint}` }]);
  return { inline_keyboard: rows };
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

  get enabled() { return Boolean(this.token && this.chatId); }
  setLanguage(language) { this.language = normalizeTelegramLanguage(language); }

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
      '✅ تم ربط SUMMECA Meme Radar بنجاح\n\nالرادار جاهز. زر التداول الحقيقي يمر بشاشة تأكيد ويفتح Phantom لمراجعتك؛ التنبيهات لا تعني ضمان الربح.',
      '✅ SUMMECA Meme Radar connected\n\nRadar is ready. Live trade controls use a confirmation screen and open Phantom for your review; alerts do not guarantee profit.'
    ));
  }

  async earlyCreate(candidate, event = {}) {
    if (!this.enabled || !candidate?.address) return null;
    const mint = String(candidate.address);
    const ar = [
      '⚡ تم إنشاء عملة جديدة الآن', '',
      `${candidate.symbol && candidate.symbol !== 'NEW' ? `$${candidate.symbol}` : 'عملة Pump.fun جديدة'}${candidate.name && candidate.name !== 'New Pump.fun coin' ? ` — ${candidate.name}` : ''}`,
      'المرحلة: 🟢 إنشاء مباشر على Pump.fun',
      `رقم الكتلة: ${event.slot ?? '—'}`, '',
      '⚠️ هذه عملة خام ولم تجتز فحوص السوق والأمان والزخم.',
      `العقد: ${mint}`
    ].join('\n');
    const en = [
      '⚡ NEW CREATE — coin created now', '',
      `${candidate.symbol && candidate.symbol !== 'NEW' ? `$${candidate.symbol}` : 'New Pump.fun coin'}${candidate.name && candidate.name !== 'New Pump.fun coin' ? ` — ${candidate.name}` : ''}`,
      'Stage: 🟢 direct Pump.fun creation',
      `رقم الكتلة: ${event.slot ?? '—'}`, '',
      '⚠️ Raw launch only; market, safety, and momentum gates have not passed.',
      `العقد: ${mint}`
    ].join('\n');
    return this.#send(this.#pick(ar, en), { reply_markup: tokenKeyboard(mint, this.language, { early: true, safe: false }) });
  }

  async signal(s, sc, p, { replyToMessageId = null } = {}) {
    const currentPrice = price(s.priceUsd);
    const buyers = Number(s.buys30s ?? 0);
    const sellers = Number(s.sells30s ?? 0);
    const ratio = buyers / Math.max(1, sellers);
    const uniqueBuyers = Number(s.uniqueBuyers30s ?? 0);
    const uniqueBuyersLabel = s.uniqueBuyersVerified === true && Number.isFinite(uniqueBuyers)
      ? uniqueBuyers.toFixed(0)
      : '—';
    const venue = sourceLabel(s.source);
    const marketCap = compactMoney(s.marketCapUsd);
    const volume5m = compactMoney(s.volume5mUsd);
    const liquidity = compactMoney(s.liquidityUsd);
    const symbol = String(s.symbol ?? 'TOKEN').replace(/^\$/, '');
    const displayName = String(s.name ?? symbol);
    const momentum = momentumScore({ ...s, entryScore: sc.entry, moonScore: sc.moon, riskScore: sc.risk });
    const quality = entryQuality({ ...s, entryScore: sc.entry, moonScore: sc.moon, riskScore: sc.risk });

    const ar = [
      '🔥 SUMMECA — إشارة دخول معتمدة', '',
      `$${symbol}  •  ${displayName}`, '',
      `⏱️ العمر: ${ageLabel(s, 'ar')}  |  📍 ${venue}`,
      `العقد: ${s.address}`, '',
      `القيمة السوقية: $${marketCap}  |  حجم 5 دقائق: $${volume5m}`,
      `💧 السيولة: $${liquidity}  |  💵 السعر: ${currentPrice ? `$${currentPrice}` : '—'}`,
      `🟢 شراء 30ث: ${buyers.toFixed(1)}  |  🔴 بيع: ${sellers.toFixed(1)}  |  النسبة ${ratio.toFixed(2)}x`,
      `👥 المشترون الفريدون: ${uniqueBuyersLabel}  |  5m: ${Number(s.priceChange5mPct ?? 0).toFixed(1)}%`, '',
      `⚡ الزخم ${momentum}/100  |  🎯 الدخول ${sc.entry}/100`,
      `🚀 فرصة الصعود ${sc.moon}/100  |  🛡️ المخاطر ${sc.risk}/100`,
      quality.ar,
      '✅ فحص السكام/الأمان: ناجح',
      '📈 بدأت متابعة الأداء من هذه الإشارة.', '',
      '⚠️ لا يوجد ضمان للربح؛ راقب الانزلاق والسيولة.'
    ].join('\n');

    const en = [
      '🔥 SUMMECA TRENDING — APPROVED ENTRY SIGNAL', '',
      `$${symbol}  •  ${displayName}`, '',
      `⏱️ Age: ${ageLabel(s, 'en')}  |  📍 ${venue}`,
      `العقد: ${s.address}`, '',
      `القيمة السوقية: $${marketCap}  |  حجم 5 دقائق: $${volume5m}`,
      `💧 السيولة: $${liquidity}  |  💵 السعر: ${currentPrice ? `$${currentPrice}` : '—'}`,
      `🟢 Buys 30s: ${buyers.toFixed(1)}  |  🔴 Sells: ${sellers.toFixed(1)}  |  النسبة ${ratio.toFixed(2)}x`,
      `👥 المشترون الفريدون: ${uniqueBuyersLabel}  |  5m: ${Number(s.priceChange5mPct ?? 0).toFixed(1)}%`, '',
      `⚡ الزخم ${momentum}/100  |  🎯 الدخول ${sc.entry}/100`,
      `🚀 فرصة الصعود ${sc.moon}/100  |  🛡️ المخاطر ${sc.risk}/100`,
      quality.en,
      '✅ Scam/safety check: PASSED',
      '📈 Performance tracking started from this signal.', '',
      '⚠️ Profit is not guaranteed; review slippage and liquidity.'
    ].join('\n');

    const text = this.#pick(ar, en);
    const boldText = boldTelegram(text);
    const replyMarkup = tokenKeyboard(s.address, this.language, { early: venue.includes('Pump.fun'), safe: true });
    const reply = replyToMessageId ? { reply_parameters: { message_id: Number(replyToMessageId), allow_sending_without_reply: true } } : {};

    if (s.imageUrl) {
      try {
        if (boldText.length <= 1024) {
          return await telegramApi(this.token, 'sendPhoto', {
            chat_id: this.chatId,
            photo: s.imageUrl,
            caption: boldText,
            parse_mode: 'HTML',
            ...reply,
            ...(replyMarkup ? { reply_markup: replyMarkup } : {})
          });
        }
      } catch (error) {
        console.warn('[telegram:photo]', error.message);
      }
    }

    return this.#send(boldText, {
      parse_mode: 'HTML',
      ...reply,
      ...(replyMarkup ? { reply_markup: replyMarkup } : {})
    });
  }

  async signalUpdate(s, sc, event) {
    if (!this.enabled || !event?.thread?.rootMessageId) return null;
    const buyers = Number(s.buys30s ?? 0);
    const sellers = Number(s.sells30s ?? 0);
    const currentPrice = price(event.priceUsd ?? s.priceUsd);
    const venue = sourceLabel(s.source);
    const momentum = momentumScore({ ...s, entryScore: sc.entry, moonScore: sc.moon, riskScore: sc.risk });
    const controls = tokenKeyboard(s.address, this.language, { early: venue.includes('Pump.fun'), safe: true });
    const reply = {
      reply_parameters: { message_id: event.thread.rootMessageId, allow_sending_without_reply: true },
      ...(controls ? { reply_markup: controls } : {})
    };

    if (event.type === 'reference') {
      return this.#send(this.#pick(
        `📍 بدأ مرجع المتابعة — $${s.symbol}\nالسعر المرجعي: $${currentPrice}\n⚡ الزخم ${momentum}/100\n🟢 شراء 30ث: ${buyers} | 🔴 بيع: ${sellers}\nالسيولة: $${money(s.liquidityUsd)}`,
        `📍 تم تثبيت مرجع المتابعة — $${s.symbol}\nالسعر المرجعي: $${currentPrice}\n⚡ الزخم ${momentum}/100\n🟢 Buys 30s: ${buyers} | 🔴 Sells: ${sellers}\nالسيولة: $${money(s.liquidityUsd)}`
      ), reply);
    }

    const ar = [
      `🚀 تحديث $${s.symbol} — تجاوز +${event.milestonePct}%`, '',
      `الصعود من الإشارة: +${pct(event.returnPct)}`,
      `أعلى صعود مسجل: +${pct(event.peakReturnPct)}`,
      `السعر الحالي: ${currentPrice ? `$${currentPrice}` : '—'}`,
      `⚡ الزخم ${momentum}/100 | Entry ${sc.entry}/100 | Risk ${sc.risk}/100`,
      `🟢 شراء 30ث: ${buyers} | 🔴 بيع: ${sellers}`,
      `حجم الشراء: $${money(s.buyVolume30sUsd)} | البيع: $${money(s.sellVolume30sUsd)}`
    ].join('\n');
    const en = [
      `🚀 $${s.symbol} update — crossed +${event.milestonePct}%`, '',
      `الصعود من الإشارة: +${pct(event.returnPct)}`,
      `أعلى صعود مسجل: +${pct(event.peakReturnPct)}`,
      `السعر الحالي: ${currentPrice ? `$${currentPrice}` : '—'}`,
      `⚡ الزخم ${momentum}/100 | Entry ${sc.entry}/100 | Risk ${sc.risk}/100`,
      `🟢 Buys 30s: ${buyers} | 🔴 Sells: ${sellers}`,
      `حجم الشراء: $${money(s.buyVolume30sUsd)} | البيع: $${money(s.sellVolume30sUsd)}`
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
