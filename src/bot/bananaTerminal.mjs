import { env } from '../config/env.mjs';
import { telegramApi } from '../notifiers/telegram.mjs';
import { AppSettings } from '../storage/appSettings.mjs';

const NETWORKS = {
  s: { label: 'SOLANA', dex: 'solana', unit: 'SOL' },
  b: { label: 'BNB CHAIN', dex: 'bsc', unit: 'BNB' },
  a: { label: 'ARC', dex: 'arc', unit: 'USDC' },
  r: { label: 'ROBINHOOD CHAIN', dex: 'robinhood', unit: 'ETH' }
};
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const finite = (value, fallback = 0) => Number.isFinite(Number(value)) ? Number(value) : fallback;
const money = (value) => {
  const n = finite(value);
  if (n >= 1_000_000) return `$${(n / 1_000_000).toFixed(2)}M`;
  if (n >= 1_000) return `$${(n / 1_000).toFixed(1)}K`;
  return `$${n.toFixed(n >= 100 ? 0 : 2)}`;
};
const short = (value) => {
  const text = String(value ?? '');
  return text.length > 16 ? `${text.slice(0, 8)}…${text.slice(-6)}` : text;
};

class TerminalRpc {
  constructor() {
    this.urls = [
      String(process.env.SOLANA_PROFILE_RPC_URL ?? '').trim(),
      'https://solana-rpc.publicnode.com',
      'https://api.mainnet-beta.solana.com'
    ].filter(Boolean);
    this.id = 0;
    this.cursor = 0;
  }
  async call(method, params = []) {
    let lastError = null;
    for (let i = 0; i < this.urls.length; i += 1) {
      const endpoint = this.urls[(this.cursor + i) % this.urls.length];
      try {
        const response = await fetch(endpoint, {
          method: 'POST',
          headers: { 'content-type': 'application/json', accept: 'application/json' },
          body: JSON.stringify({ jsonrpc: '2.0', id: ++this.id, method, params })
        });
        if (response.status === 429) { await sleep(400 + (i * 300)); continue; }
        if (!response.ok) throw new Error(`${method} HTTP ${response.status}`);
        const body = await response.json();
        if (body?.error) throw new Error(`${method}: ${body.error.message}`);
        this.cursor = (this.cursor + i) % this.urls.length;
        return body?.result;
      } catch (error) { lastError = error; }
    }
    throw lastError || new Error(`${method} failed`);
  }
}

async function dexSnapshot(code, token) {
  const cfg = NETWORKS[code];
  if (!cfg) return null;
  const response = await fetch(`https://api.dexscreener.com/tokens/v1/${cfg.dex}/${encodeURIComponent(token)}`, {
    headers: { accept: 'application/json' }
  });
  if (!response.ok) return null;
  const rows = await response.json().catch(() => []);
  const pair = (Array.isArray(rows) ? rows : [])
    .filter((row) => String(row?.chainId ?? '').toLowerCase() === cfg.dex)
    .sort((a, b) => finite(b?.liquidity?.usd) - finite(a?.liquidity?.usd))[0];
  if (!pair) return null;
  const base = String(pair?.baseToken?.address ?? '');
  const asset = base.toLowerCase() === String(token).toLowerCase() ? pair.baseToken : pair.quoteToken;
  return {
    symbol: asset?.symbol || 'TOKEN',
    price: finite(pair?.priceUsd),
    liquidity: finite(pair?.liquidity?.usd),
    marketCap: finite(pair?.marketCap, finite(pair?.fdv)),
    buys: finite(pair?.txns?.m5?.buys),
    sells: finite(pair?.txns?.m5?.sells),
    volume: finite(pair?.volume?.m5),
    move: finite(pair?.priceChange?.m5),
    url: pair?.url || ''
  };
}

async function solanaHolderProfile(rpc, mint) {
  try {
    const [largest, supply] = await Promise.all([
      rpc.call('getTokenLargestAccounts', [mint, { commitment: 'confirmed' }]),
      rpc.call('getTokenSupply', [mint, { commitment: 'confirmed' }])
    ]);
    const total = finite(supply?.value?.uiAmount, 0);
    const rows = Array.isArray(largest?.value) ? largest.value : [];
    const pcts = total > 0 ? rows.slice(0, 10).map((row) => (finite(row?.uiAmount) / total) * 100) : [];
    return {
      accounts: rows.length,
      top1: pcts[0] || 0,
      top5: pcts.slice(0, 5).reduce((a, b) => a + b, 0),
      top10: pcts.reduce((a, b) => a + b, 0)
    };
  } catch {
    return null;
  }
}

function quality(market, holders) {
  if (!market) return { score: 0, risk: 'HIGH' };
  const ratio = market.buys / Math.max(1, market.sells);
  let score = 0;
  if (market.liquidity >= 10_000) score += 20;
  if (market.marketCap > 0 && market.marketCap <= 1_500_000) score += 15;
  if (market.buys >= 8) score += 15;
  if (market.sells >= 1) score += 10;
  if (ratio >= 1.5) score += 15;
  if (market.volume >= 1_000) score += 10;
  if (market.move <= 30) score += 5;
  if (holders) {
    if (holders.top1 <= 12) score += 4;
    if (holders.top5 <= 30) score += 3;
    if (holders.top10 <= 45) score += 3;
  }
  return { score: Math.min(100, score), risk: score >= 80 ? 'LOWER' : score >= 60 ? 'MEDIUM' : 'HIGH' };
}

export class BananaTerminal {
  constructor() {
    this.settings = new AppSettings(env.supabaseUrl, env.supabaseSecretKey);
    this.chatId = '';
    this.rpc = new TerminalRpc();
  }

  async resolveChatId() {
    if (this.chatId) return this.chatId;
    if (env.telegramChatId) return (this.chatId = String(env.telegramChatId));
    if (this.settings.enabled) this.chatId = String(await this.settings.get('telegram_chat_id').catch(() => '') || '');
    return this.chatId;
  }

  async send(text, keyboard) {
    const chatId = await this.resolveChatId();
    if (!chatId || !env.telegramBotToken) return null;
    return telegramApi(env.telegramBotToken, 'sendMessage', {
      chat_id: chatId,
      text,
      ...(keyboard ? { reply_markup: { inline_keyboard: keyboard } } : {})
    });
  }

  static tokenKeyboard(code, token) {
    return [
      [
        { text: '🔎 Analyze', callback_data: `bn:a:${code}:${token}` },
        { text: '📋 CA', copy_text: { text: token } }
      ],
      [
        { text: '🟢 Buy', callback_data: `bn:b:${code}:m:${token}` },
        { text: '🔴 Sell', callback_data: `bn:s:${code}:m:${token}` }
      ],
      [{ text: '📊 Positions', callback_data: 'bn:p' }]
    ];
  }

  async showPositions() {
    return this.send([
      '📊 SUMMECA POSITIONS',
      '',
      env.liveTradingEnabled ? '🟢 Live trading mode is enabled.' : '🛡️ Safe mode: LIVE_TRADING_ENABLED=false',
      'لا توجد مراكز Live ينشئها هذا الـTerminal أثناء Safe Mode.',
      '',
      'يمكنك استخدام واجهة Buy/Sell وتجربة شاشة التأكيد بدون تنفيذ أموال حقيقية.'
    ].join('\n'), [[{ text: '🏠 القائمة', callback_data: 'menu:home' }]]);
  }

  async analyze(code, token) {
    const cfg = NETWORKS[code];
    if (!cfg) return false;
    const market = await dexSnapshot(code, token).catch(() => null);
    const holders = code === 's' ? await solanaHolderProfile(this.rpc, token) : null;
    const q = quality(market, holders);
    const ratio = market ? market.buys / Math.max(1, market.sells) : 0;
    return this.send([
      `🔎 SUMMECA TOKEN ANALYSIS — ${cfg.label}`,
      '',
      `${market ? `$${market.symbol}` : 'TOKEN'} • ${short(token)}`,
      market ? `💵 Price: $${market.price || 0}` : '🟡 DEX market not confirmed yet',
      market ? `💧 Liquidity: ${money(market.liquidity)} | MC: ${money(market.marketCap)}` : '',
      market ? `5m: Buy ${market.buys} / Sell ${market.sells} | Ratio ${ratio.toFixed(2)}x` : '',
      market ? `Vol: ${money(market.volume)} | Move: ${market.move.toFixed(1)}%` : '',
      holders ? `👥 Holders profile: Top1 ${holders.top1.toFixed(1)}% | Top5 ${holders.top5.toFixed(1)}% | Top10 ${holders.top10.toFixed(1)}%` : (code === 's' ? '👥 Holder profile temporarily unavailable' : '👥 Holder concentration: pending network-specific analyzer'),
      '',
      `🎯 Quality: ${q.score}/100 | Risk: ${q.risk}`,
      '⚠️ التحليل يقلل المخاطر لكنه لا يضمن استمرار الصعود.',
      `CA: ${token}`
    ].filter(Boolean).join('\n'), BananaTerminal.tokenKeyboard(code, token));
  }

  async buyMenu(code, token) {
    const cfg = NETWORKS[code];
    if (!cfg) return false;
    return this.send(`🟢 BUY — ${cfg.label}\n\nاختر الحجم. لن تُنفذ الصفقة قبل شاشة تأكيد أخرى.`, [
      [
        { text: `0.05 ${cfg.unit}`, callback_data: `bn:b:${code}:005:${token}` },
        { text: `0.10 ${cfg.unit}`, callback_data: `bn:b:${code}:010:${token}` },
        { text: `0.25 ${cfg.unit}`, callback_data: `bn:b:${code}:025:${token}` }
      ],
      [{ text: '⬅️ رجوع', callback_data: `bn:a:${code}:${token}` }]
    ]);
  }

  async sellMenu(code, token) {
    const cfg = NETWORKS[code];
    if (!cfg) return false;
    return this.send(`🔴 SELL — ${cfg.label}\n\nاختر نسبة المركز. لن تُنفذ الصفقة قبل شاشة تأكيد أخرى.`, [
      [
        { text: '25%', callback_data: `bn:s:${code}:25:${token}` },
        { text: '50%', callback_data: `bn:s:${code}:50:${token}` },
        { text: '100%', callback_data: `bn:s:${code}:100:${token}` }
      ],
      [{ text: '⬅️ رجوع', callback_data: `bn:a:${code}:${token}` }]
    ]);
  }

  async confirm(side, code, amount, token) {
    const cfg = NETWORKS[code];
    if (!cfg) return false;
    const label = side === 'b' ? 'BUY' : 'SELL';
    const shown = side === 'b' ? `${Number(amount) / 100} ${cfg.unit}` : `${amount}%`;
    return this.send([
      `⚠️ FINAL CONFIRM — ${label}`,
      '',
      `${cfg.label} • ${short(token)}`,
      `${side === 'b' ? 'Amount' : 'Position'}: ${shown}`,
      '',
      env.liveTradingEnabled
        ? 'Live mode is enabled, but this new terminal does not execute until the execution adapter is explicitly connected.'
        : '🛡️ SAFE MODE: التداول الحقيقي معطّل حاليًا. الضغط على Confirm سيختبر المسار فقط ولن يرسل معاملة.',
      `CA: ${token}`
    ].join('\n'), [
      [{ text: '✅ Confirm', callback_data: `bn:x:${side}:${code}:${amount}:${token}` }],
      [{ text: '❌ Cancel', callback_data: `bn:a:${code}:${token}` }]
    ]);
  }

  async executeSafe(side, code, amount, token) {
    const cfg = NETWORKS[code];
    if (!cfg) return false;
    // Deliberately no signing/broadcasting here. This phase validates UX and safety gates only.
    return this.send([
      '🛡️ SAFE MODE — NO TRANSACTION SENT',
      '',
      `${side === 'b' ? 'BUY' : 'SELL'} • ${cfg.label}`,
      `CA: ${token}`,
      '',
      'تم اختبار مسار التأكيد بنجاح، لكن لم يتم توقيع أو إرسال أي معاملة حقيقية.'
    ].join('\n'), [[{ text: '🔎 Analyze', callback_data: `bn:a:${code}:${token}` }, { text: '📊 Positions', callback_data: 'bn:p' }]]);
  }

  async handleCallback(data) {
    if (data === 'bn:p' || data === 'menu:positions') { await this.showPositions(); return true; }
    const parts = String(data ?? '').split(':');
    if (parts[0] !== 'bn') return false;
    const action = parts[1];
    if (action === 'a' && parts.length >= 4) { await this.analyze(parts[2], parts.slice(3).join(':')); return true; }
    if ((action === 'b' || action === 's') && parts.length >= 5) {
      const [, , code, value, ...rest] = parts;
      const token = rest.join(':');
      if (value === 'm') await (action === 'b' ? this.buyMenu(code, token) : this.sellMenu(code, token));
      else await this.confirm(action, code, value, token);
      return true;
    }
    if (action === 'x' && parts.length >= 6) {
      const side = parts[2]; const code = parts[3]; const amount = parts[4]; const token = parts.slice(5).join(':');
      await this.executeSafe(side, code, amount, token); return true;
    }
    return false;
  }
}

let singleton = null;
export function getBananaTerminal() {
  if (!singleton) singleton = new BananaTerminal();
  return singleton;
}
