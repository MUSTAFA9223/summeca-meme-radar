async function telegramApi(token, method, body = {}) {
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

const normalizeLanguage = (language) => {
  const value = String(language ?? 'ar').trim().toLowerCase();
  return ['ar', 'en', 'bilingual'].includes(value) ? value : 'ar';
};

const money = (value) => Number(value ?? 0).toLocaleString('en-US', { maximumFractionDigits: 0 });

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
    this.language = normalizeLanguage(language);
  }

  get enabled() {
    return Boolean(this.token && this.chatId);
  }

  async #send(text) {
    if (!this.enabled) return false;
    await telegramApi(this.token, 'sendMessage', { chat_id: this.chatId, text });
    return true;
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
    const ar = [
      '🔥 رادار SUMMECA للعملات الميم',
      '',
      `${s.symbol} — ${s.name}`,
      `درجة الدخول: ${sc.entry}/100 | فرصة الصعود: ${sc.moon}/100 | المخاطرة: ${sc.risk}/100`,
      `السيولة: $${money(s.liquidityUsd)}`,
      p ? `🧪 شراء تجريبي: $${p.usdSize.toFixed(2)} بسعر ${p.entryPriceUsd}` : '👀 مراقبة فقط',
      '',
      `عنوان العملة: ${s.address}`
    ].join('\n');

    const en = [
      '🔥 SUMMECA MEME RADAR',
      '',
      `${s.symbol} — ${s.name}`,
      `Entry: ${sc.entry}/100 | Moon: ${sc.moon}/100 | Risk: ${sc.risk}/100`,
      `Liquidity: $${money(s.liquidityUsd)}`,
      p ? `🧪 PAPER BUY: $${p.usdSize.toFixed(2)} @ ${p.entryPriceUsd}` : 'Watch only',
      '',
      `CA: ${s.address}`
    ].join('\n');

    await this.#send(this.#pick(ar, en));
  }

  async exit(p) {
    const pnl = (p.pnlPct ?? 0).toFixed(1);
    const ar = `🧪 خروج تجريبي — ${p.symbol}\nالربح/الخسارة: ${pnl}%\nالسبب: ${translateExitReason(p.exitReason)}`;
    const en = `🧪 PAPER EXIT ${p.symbol}\nPnL: ${pnl}%\nReason: ${p.exitReason ?? 'n/a'}`;
    await this.#send(this.#pick(ar, en));
  }
}
