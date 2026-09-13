export class TelegramNotifier {
  constructor(token, chatId) { this.token = token; this.chatId = chatId; }
  get enabled() { return Boolean(this.token && this.chatId); }
  async #send(text) {
    if (!this.enabled) return;
    const r = await fetch(`https://api.telegram.org/bot${this.token}/sendMessage`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ chat_id: this.chatId, text })
    });
    if (!r.ok) throw new Error(`Telegram HTTP ${r.status}`);
  }
  async signal(s, sc, p) {
    await this.#send(['🔥 SUMMECA MEME RADAR', '', `${s.symbol} — ${s.name}`,
      `Entry: ${sc.entry}/100 | Moon: ${sc.moon}/100 | Risk: ${sc.risk}/100`,
      `Liquidity: $${Math.round(s.liquidityUsd).toLocaleString()}`,
      p ? `🧪 PAPER BUY: $${p.usdSize.toFixed(2)} @ ${p.entryPriceUsd}` : 'Watch only', '', `CA: ${s.address}`].join('\n'));
  }
  async exit(p) { await this.#send(`🧪 PAPER EXIT ${p.symbol}\nPnL: ${(p.pnlPct ?? 0).toFixed(1)}%\nReason: ${p.exitReason ?? 'n/a'}`); }
}
