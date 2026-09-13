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

export class TelegramNotifier {
  constructor(token, chatId) {
    this.token = token;
    this.chatId = chatId;
  }

  get enabled() {
    return Boolean(this.token && this.chatId);
  }

  async #send(text) {
    if (!this.enabled) return false;
    await telegramApi(this.token, 'sendMessage', { chat_id: this.chatId, text });
    return true;
  }

  async test() {
    return this.#send('✅ SUMMECA Meme Radar connected\n\nLive alerts are ready. Trading remains PAPER ONLY.');
  }

  async signal(s, sc, p) {
    await this.#send([
      '🔥 SUMMECA MEME RADAR',
      '',
      `${s.symbol} — ${s.name}`,
      `Entry: ${sc.entry}/100 | Moon: ${sc.moon}/100 | Risk: ${sc.risk}/100`,
      `Liquidity: $${Math.round(s.liquidityUsd).toLocaleString()}`,
      p ? `🧪 PAPER BUY: $${p.usdSize.toFixed(2)} @ ${p.entryPriceUsd}` : 'Watch only',
      '',
      `CA: ${s.address}`
    ].join('\n'));
  }

  async exit(p) {
    await this.#send(`🧪 PAPER EXIT ${p.symbol}\nPnL: ${(p.pnlPct ?? 0).toFixed(1)}%\nReason: ${p.exitReason ?? 'n/a'}`);
  }
}
