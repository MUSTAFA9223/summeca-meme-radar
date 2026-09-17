import { env } from '../config/env.mjs';
import { PUMP_FUN_PROGRAM_ID, resolvePumpCreateMint } from '../feeds/heliusDirectCreate.mjs';
import { telegramApi } from '../notifiers/telegram.mjs';
import { AppSettings } from '../storage/appSettings.mjs';

const SOLANA = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, Math.max(0, ms)));
const finite = (value, fallback = 0) => Number.isFinite(Number(value)) ? Number(value) : fallback;
const short = (value) => {
  const text = String(value ?? '');
  return text.length > 14 ? `${text.slice(0, 7)}…${text.slice(-5)}` : text;
};
const money = (value) => {
  const n = finite(value);
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(2)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return n.toFixed(n >= 100 ? 0 : 2);
};
const boolEnv = (name, fallback = true) => {
  const raw = String(process.env[name] ?? (fallback ? 'true' : 'false')).trim().toLowerCase();
  return !['false', '0', 'off', 'no'].includes(raw);
};

class SolanaTelegramSink {
  constructor() {
    this.settings = new AppSettings(env.supabaseUrl, env.supabaseSecretKey);
    this.chatId = '';
  }

  async resolveChatId() {
    if (this.chatId) return this.chatId;
    if (env.telegramChatId) return (this.chatId = String(env.telegramChatId));
    if (!this.settings.enabled) return '';
    this.chatId = String(await this.settings.get('telegram_chat_id').catch(() => '') || '');
    return this.chatId;
  }

  keyboard(mint, marketUrl = '') {
    const token = String(mint ?? '');
    const rows = [
      [{ text: '📋 نسخ العقد / Copy CA', copy_text: { text: token } }],
      [
        { text: '🚀 Pump.fun', url: `https://pump.fun/coin/${encodeURIComponent(token)}` },
        { text: '🟢 GMGN', url: `https://gmgn.ai/sol/token/${encodeURIComponent(token)}` }
      ],
      [{ text: '🔥 FOMO', url: `https://fomo.family/tokens/solana/${encodeURIComponent(token)}` }]
    ];
    if (marketUrl) rows.push([{ text: '📊 فتح السوق / Open market', url: marketUrl }]);
    return { inline_keyboard: rows };
  }

  async send(text, mint, { marketUrl = '', replyTo = 0 } = {}) {
    if (!env.telegramBotToken) return null;
    const chatId = await this.resolveChatId();
    if (!chatId) return null;
    return telegramApi(env.telegramBotToken, 'sendMessage', {
      chat_id: chatId,
      text,
      reply_markup: this.keyboard(mint, marketUrl),
      ...(replyTo ? { reply_parameters: { message_id: Number(replyTo), allow_sending_without_reply: true } } : {})
    });
  }
}

const sink = new SolanaTelegramSink();

async function fetchMarkets(mints) {
  if (!mints.length) return [];
  const response = await fetch(`https://api.dexscreener.com/tokens/v1/solana/${mints.map(encodeURIComponent).join(',')}`, {
    headers: { accept: 'application/json' }
  });
  if (response.status === 429) {
    await sleep(1_500);
    throw new Error('DexScreener Solana HTTP 429');
  }
  if (!response.ok) throw new Error(`DexScreener Solana HTTP ${response.status}`);
  const rows = await response.json().catch(() => []);
  return Array.isArray(rows) ? rows : [];
}

function normalizeMarket(pair, mint) {
  const base = String(pair?.baseToken?.address ?? '');
  const quote = String(pair?.quoteToken?.address ?? '');
  if (base !== mint && quote !== mint) return null;
  const token = base === mint ? pair.baseToken : pair.quoteToken;
  return {
    mint,
    symbol: token?.symbol || 'TOKEN',
    priceUsd: finite(pair?.priceUsd),
    liquidityUsd: finite(pair?.liquidity?.usd),
    marketCapUsd: finite(pair?.marketCap, finite(pair?.fdv)),
    buys5m: finite(pair?.txns?.m5?.buys),
    sells5m: finite(pair?.txns?.m5?.sells),
    volume5mUsd: finite(pair?.volume?.m5),
    priceChange5mPct: finite(pair?.priceChange?.m5),
    pairCreatedAt: finite(pair?.pairCreatedAt),
    url: pair?.url || '',
    dexId: String(pair?.dexId ?? '')
  };
}

export class SolanaUltraEarlyWorker {
  constructor() {
    this.enabled = boolEnv('SOLANA_ULTRA_ENABLED', true);
    this.rawLaunchAlerts = boolEnv('SOLANA_RAW_LAUNCH_ALERTS', false);
    this.marketPollMs = Math.max(1_000, Math.min(5_000, finite(process.env.SOLANA_ULTRA_MARKET_POLL_MS, 1_500)));
    this.ws = null;
    this.active = false;
    this.reconnectAttempt = 0;
    this.seenSignatures = new Set();
    this.pending = new Map();
    this.marketRunning = false;
  }

  isCreate(logs) {
    const text = (Array.isArray(logs) ? logs : []).join('\n').toLowerCase();
    return /instruction:\s*create(?:v2)?\b/.test(text);
  }

  hasInitialBuy(logs) {
    const text = (Array.isArray(logs) ? logs : []).join('\n').toLowerCase();
    return /instruction:\s*buy\b|instruction:\s*buyexact/i.test(text);
  }

  rememberMint(mint, signature, initialBuy) {
    if (!SOLANA.test(mint)) return null;
    const prior = this.pending.get(mint);
    const state = prior || {
      createdAt: Date.now(),
      signature,
      initialBuy: Boolean(initialBuy),
      lastMarketAt: 0,
      rootMessageId: 0,
      launchSent: false,
      marketLiveSent: false,
      earlySent: false,
      topSent: false
    };
    if (initialBuy) state.initialBuy = true;
    this.pending.set(mint, state);
    if (this.pending.size > 700) {
      const oldest = [...this.pending.entries()].sort((a, b) => a[1].createdAt - b[1].createdAt).slice(0, 100);
      for (const [key] of oldest) this.pending.delete(key);
    }
    return state;
  }

  async sendLaunch(mint, state) {
    if (state.launchSent) return;
    state.launchSent = true;
    const age = Math.max(0, Math.round((Date.now() - state.createdAt) / 1000));
    const message = await sink.send([
      '🚨⚡ SUMMECA NEW LAUNCH — SOLANA / PUMP.FUN',
      '',
      '🟣 تم اكتشاف إنشاء العقد على السلسلة الآن — قبل انتظار السيولة أو DEX.',
      `⏱️ العمر عند التنبيه: ~${age}s`,
      `🟢 شراء أولي داخل معاملة الإنشاء: ${state.initialBuy ? 'نعم' : 'غير مؤكد'}`,
      `🔗 TX: ${state.signature}`,
      '',
      '⚠️ هذا تنبيه إطلاق مبكر جدًا، وليس توصية شراء أو ضمان صعود.',
      `CA: ${mint}`
    ].join('\n'), mint);
    state.rootMessageId = Number(message?.message_id ?? 0);
    console.log(`[solana:ultra-launch] mint=${short(mint)} initialBuy=${state.initialBuy ? 'yes' : 'no'} age=${age}s`);
  }

  async resolveCreate(signature, logs) {
    if (!signature || this.seenSignatures.has(signature)) return;
    this.seenSignatures.add(signature);
    if (this.seenSignatures.size > 7000) this.seenSignatures.clear();
    const initialBuy = this.hasInitialBuy(logs);
    try {
      const mint = await resolvePumpCreateMint(env.heliusApiKey, signature, { retries: 2, retryDelayMs: 180 });
      if (!mint) return;
      const state = this.rememberMint(mint, signature, initialBuy);
      console.log(`[solana:ultra-new] mint=${short(mint)} sig=${short(signature)} initialBuy=${initialBuy ? 'yes' : 'no'}`);
      if (state && (initialBuy || this.rawLaunchAlerts)) await this.sendLaunch(mint, state);
    } catch (error) {
      console.warn('[solana:ultra-resolve]', error.message);
    }
  }

  connect() {
    if (!this.enabled || !this.active || typeof WebSocket === 'undefined') return;
    const ws = new WebSocket('wss://api.mainnet-beta.solana.com');
    this.ws = ws;
    ws.addEventListener('open', () => {
      this.reconnectAttempt = 0;
      ws.send(JSON.stringify({
        jsonrpc: '2.0',
        id: 701,
        method: 'logsSubscribe',
        params: [{ mentions: [PUMP_FUN_PROGRAM_ID] }, { commitment: 'processed' }]
      }));
      console.log(`SUMMECA SOLANA ULTRA: processed Pump.fun stream connected poll=${this.marketPollMs}ms`);
    });
    ws.addEventListener('message', (event) => {
      let message;
      try { message = JSON.parse(String(event.data)); } catch { return; }
      if (message?.method !== 'logsNotification') return;
      const value = message?.params?.result?.value ?? {};
      if (value?.err || !this.isCreate(value?.logs)) return;
      void this.resolveCreate(String(value?.signature ?? ''), value?.logs ?? []);
    });
    ws.addEventListener('error', () => { try { ws.close(); } catch {} });
    ws.addEventListener('close', () => {
      if (!this.active || this.ws !== ws) return;
      this.ws = null;
      const delay = Math.min(20_000, 750 * (2 ** this.reconnectAttempt++));
      console.warn(`[solana:ultra-ws] reconnect in ${delay}ms`);
      setTimeout(() => this.connect(), delay).unref?.();
    });
  }

  async handleMarket(mint, state, market) {
    const ageMs = Date.now() - state.createdAt;
    const ratio = market.buys5m / Math.max(1, market.sells5m);

    if (!state.marketLiveSent && market.priceUsd > 0 && market.buys5m >= 1 && ageMs <= 5 * 60_000) {
      if (!state.launchSent) await this.sendLaunch(mint, state);
      state.marketLiveSent = true;
      await sink.send([
        '⚡📈 SUMMECA MARKET LIVE — SOLANA',
        '',
        `$${market.symbol} • Pump.fun`,
        `⏱️ بعد الإنشاء: ${Math.max(1, Math.round(ageMs / 1000))}s`,
        `💵 السعر: $${market.priceUsd || 0}`,
        `MC: $${money(market.marketCapUsd)} | Liquidity: $${money(market.liquidityUsd)}`,
        `5m: شراء ${market.buys5m} / بيع ${market.sells5m} | Vol $${money(market.volume5mUsd)}`,
        '',
        '🟡 السوق ظهر الآن؛ ما زلنا في مرحلة مبكرة جدًا.',
        `CA: ${mint}`
      ].join('\n'), mint, { marketUrl: market.url, replyTo: state.rootMessageId });
    }

    const earlyOk = ageMs <= 4 * 60_000
      && market.marketCapUsd > 0 && market.marketCapUsd <= 2_000_000
      && market.buys5m >= 3
      && market.volume5mUsd >= 250
      && ratio >= 1.2;
    if (!state.earlySent && earlyOk) {
      state.earlySent = true;
      await sink.send([
        '👀⚡ SUMMECA EARLY WATCH — SOLANA',
        '',
        `$${market.symbol} • Pump.fun`,
        `⏱️ العمر: ${Math.max(1, Math.round(ageMs / 1000))}s`,
        `💧 السيولة: $${money(market.liquidityUsd)} | MC: $${money(market.marketCapUsd)}`,
        `5m: شراء ${market.buys5m} / بيع ${market.sells5m} | Ratio ${ratio.toFixed(2)}x`,
        `Vol: $${money(market.volume5mUsd)}`,
        '',
        '⚠️ رصد مبكر؛ لا يعني أن السعر سيواصل الصعود.',
        `CA: ${mint}`
      ].join('\n'), mint, { marketUrl: market.url, replyTo: state.rootMessageId });
    }

    const topOk = ageMs <= 7 * 60_000
      && market.marketCapUsd > 0 && market.marketCapUsd <= 1_500_000
      && market.buys5m >= 8
      && market.sells5m >= 1
      && market.volume5mUsd >= 1_500
      && ratio >= 1.6;
    if (!state.topSent && topOk) {
      state.topSent = true;
      await sink.send([
        '💎🔥 SUMMECA TOP-TIER — SOLANA',
        '',
        `$${market.symbol} • Pump.fun`,
        `⏱️ العمر: ${Math.max(1, Math.round(ageMs / 1000))}s`,
        `💧 السيولة: $${money(market.liquidityUsd)} | MC: $${money(market.marketCapUsd)}`,
        `5m: شراء ${market.buys5m} / بيع ${market.sells5m} | Ratio ${ratio.toFixed(2)}x`,
        `Vol: $${money(market.volume5mUsd)}`,
        '✅ عقد حديث + نشاط شراء/بيع فعلي + فلتر Market Cap مبكر',
        '',
        '⚠️ TOP-TIER = شروط الرادار فقط، وليس ضمان ربح.',
        `CA: ${mint}`
      ].join('\n'), mint, { marketUrl: market.url, replyTo: state.rootMessageId });
    }
  }

  async marketCycle() {
    if (this.marketRunning || !this.pending.size) return;
    this.marketRunning = true;
    try {
      const now = Date.now();
      for (const [mint, state] of this.pending) {
        if (now - state.createdAt > 20 * 60_000) this.pending.delete(mint);
      }
      const selected = [...this.pending.entries()]
        .filter(([, state]) => now - state.lastMarketAt >= this.marketPollMs)
        .slice(0, 30);
      if (!selected.length) return;
      for (const [, state] of selected) state.lastMarketAt = now;
      const mints = selected.map(([mint]) => mint);
      const rows = await fetchMarkets(mints);
      const best = new Map();
      for (const pair of rows) {
        const mint = mints.find((candidate) => String(pair?.baseToken?.address ?? '') === candidate || String(pair?.quoteToken?.address ?? '') === candidate);
        if (!mint) continue;
        const market = normalizeMarket(pair, mint);
        if (!market) continue;
        const prior = best.get(mint);
        if (!prior || market.liquidityUsd > prior.liquidityUsd || market.volume5mUsd > prior.volume5mUsd) best.set(mint, market);
      }
      for (const [mint, state] of selected) {
        const market = best.get(mint);
        if (market) await this.handleMarket(mint, state, market);
      }
    } catch (error) {
      console.warn('[solana:ultra-market]', error.message);
    } finally {
      this.marketRunning = false;
    }
  }

  start() {
    if (!this.enabled) {
      console.log('SUMMECA SOLANA ULTRA: disabled');
      return false;
    }
    if (typeof WebSocket === 'undefined') {
      console.warn('SUMMECA SOLANA ULTRA: WebSocket unavailable');
      return false;
    }
    this.active = true;
    this.connect();
    setInterval(() => void this.marketCycle(), this.marketPollMs).unref?.();
    return true;
  }
}

let singleton = null;
export async function startSolanaUltraEarlyWorker() {
  if (!singleton) singleton = new SolanaUltraEarlyWorker();
  singleton.start();
  return singleton;
}
