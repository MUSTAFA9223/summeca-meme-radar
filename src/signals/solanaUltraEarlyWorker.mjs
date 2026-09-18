import { env } from '../config/env.mjs';
import { PUMP_FUN_PROGRAM_ID, resolvePumpCreateMint } from '../feeds/heliusDirectCreate.mjs';
import { telegramApi } from '../notifiers/telegram.mjs';
import { AppSettings } from '../storage/appSettings.mjs';
import { fetchTokenOverview, fetchTokenSecurity } from '../feeds/birdeye.mjs';
import { fetchPumpNativeMarkets } from '../feeds/pumpFunNative.mjs';
import { fetchHeliusHolderProfile, holderProfileFromTokenAccounts } from '../feeds/heliusTokenHolders.mjs';
import { SolanaTradeCandidateBridge } from './solanaTradeCandidateBridge.mjs';

const SOLANA = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, Math.max(0, ms)));
const finite = (value, fallback = 0) => Number.isFinite(Number(value)) ? Number(value) : fallback;
const optionalFinite = (value) => value == null || value === '' ? null : (Number.isFinite(Number(value)) ? Number(value) : null);
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
const numEnv = (name, fallback, min, max) => Math.max(min, Math.min(max, finite(process.env[name], fallback)));

export function isSolanaPaperProbeEligible({
  rejectionReason = null,
  score = 0,
  minScore = 68
} = {}) {
  return !rejectionReason && finite(score) >= finite(minScore, 68);
}

export function selectSolanaMarketCandidates(entries, {
  now = Date.now(),
  pollMs = 1_500,
  limit = 30,
  maxCandidateAgeMs = 8 * 60_000,
  openPaperAddresses = new Set()
} = {}) {
  return [...entries]
    .filter(([mint, state]) => {
      const openPaper = openPaperAddresses.has(String(mint));
      const ageMs = Math.max(0, now - finite(state?.createdAt, now));
      const due = now - finite(state?.lastMarketAt, 0) >= pollMs;
      return due && (openPaper || ageMs <= maxCandidateAgeMs);
    })
    .sort(([mintA, a], [mintB, b]) => {
      const aOpen = openPaperAddresses.has(String(mintA));
      const bOpen = openPaperAddresses.has(String(mintB));
      if (aOpen !== bOpen) return aOpen ? -1 : 1;

      const aInitial = a?.initialBuy === true;
      const bInitial = b?.initialBuy === true;
      if (aInitial !== bInitial) return aInitial ? -1 : 1;

      const aFresh = now - finite(a?.createdAt, 0) <= 4 * 60_000;
      const bFresh = now - finite(b?.createdAt, 0) <= 4 * 60_000;
      if (aFresh !== bFresh) return aFresh ? -1 : 1;

      return finite(b?.createdAt, 0) - finite(a?.createdAt, 0);
    })
    .slice(0, Math.max(1, Math.floor(limit)));
}

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
      [
        { text: '🔎 تحليل / Analyze', callback_data: `term:a:sol:${token}` },
        { text: '📋 نسخ العقد / CA', copy_text: { text: token } }
      ],
      [
        { text: '🟢 Buy', callback_data: `term:b:sol:${token}` },
        { text: '🔴 Sell', callback_data: `term:s:sol:${token}` },
        { text: '📊 Positions', callback_data: 'term:p' }
      ],
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
    dexId: String(pair?.dexId ?? ''),
    source: 'dexscreener',
    hasFlow: true
  };
}

class SolanaProfileRpc {
  constructor() {
    const custom = String(process.env.SOLANA_PROFILE_RPC_URL ?? '').trim();
    this.endpoints = [custom, 'https://rpc.solanatracker.io/public', 'https://solana-rpc.publicnode.com', 'https://api.mainnet-beta.solana.com'].filter(Boolean);
    this.index = 0;
    this.id = 0;
    this.tail = Promise.resolve();
    this.nextAt = 0;
  }

  call(method, params = []) {
    const task = this.tail.then(async () => {
      let lastError = null;
      for (let attempt = 0; attempt < Math.min(4, this.endpoints.length + 1); attempt += 1) {
        const waitMs = Math.max(0, this.nextAt - Date.now());
        if (waitMs) await sleep(waitMs);
        this.nextAt = Date.now() + 450;
        const endpoint = this.endpoints[(this.index + attempt) % this.endpoints.length];
        try {
          const controller = new AbortController();
          const timer = setTimeout(() => controller.abort(), 4_500);
          const response = await fetch(endpoint, {
            method: 'POST',
            signal: controller.signal,
            headers: { 'content-type': 'application/json', accept: 'application/json' },
            body: JSON.stringify({ jsonrpc: '2.0', id: ++this.id, method, params })
          }).finally(() => clearTimeout(timer));
          if (response.status === 429) {
            lastError = new Error(`${method} HTTP 429`);
            await sleep(Math.min(4_000, 750 * (attempt + 1)));
            continue;
          }
          if (!response.ok) throw new Error(`${method} HTTP ${response.status}`);
          const body = await response.json();
          if (body?.error) throw new Error(`${method} ${body.error.code}: ${body.error.message}`);
          this.index = (this.index + attempt) % this.endpoints.length;
          return body?.result;
        } catch (error) {
          lastError = error;
        }
      }
      throw lastError || new Error(`${method} failed`);
    });
    this.tail = task.catch(() => undefined);
    return task;
  }
}

const profileRpc = new SolanaProfileRpc();

async function fetchProgramAccountHolderProfile(mint) {
  const rows = await profileRpc.call('getProgramAccounts', [
    'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA',
    {
      commitment: 'processed',
      encoding: 'jsonParsed',
      filters: [
        { dataSize: 165 },
        { memcmp: { offset: 0, bytes: mint } }
      ]
    }
  ]);
  if (!Array.isArray(rows) || !rows.length) return null;
  const accounts = [];
  for (const row of rows) {
    const info = row?.account?.data?.parsed?.info ?? {};
    const owner = String(info?.owner ?? '').trim();
    const amount = info?.tokenAmount?.amount ?? info?.token_amount?.amount ?? 0;
    if (!owner || !(Number(amount) > 0)) continue;
    accounts.push({ owner, amount });
  }
  if (!accounts.length) return null;
  return holderProfileFromTokenAccounts(accounts, {
    complete: true,
    provider: 'solana-getProgramAccounts'
  });
}

async function fetchHolderProfile(mint) {
  const [supplyResult, largestResult] = await Promise.all([
    profileRpc.call('getTokenSupply', [mint, { commitment: 'processed' }]),
    profileRpc.call('getTokenLargestAccounts', [mint, { commitment: 'processed' }])
  ]);
  const supply = finite(supplyResult?.value?.amount);
  if (!(supply > 0)) return null;
  const balances = (Array.isArray(largestResult?.value) ? largestResult.value : [])
    .map((row) => finite(row?.amount))
    .filter((amount) => amount > 0)
    .sort((a, b) => b - a);
  if (!balances.length) return null;

  const shares = balances.map((amount) => amount / supply * 100);
  const curveExcluded = shares[0] >= 20;
  const userShares = curveExcluded ? shares.slice(1) : shares;
  const observedAccounts = userShares.filter((pct) => pct > 0).length;
  const topUserPct = userShares[0] || 0;
  const top5UsersPct = userShares.slice(0, 5).reduce((sum, pct) => sum + pct, 0);
  const top10UsersPct = userShares.slice(0, 10).reduce((sum, pct) => sum + pct, 0);
  const meaningfulWallets = userShares.filter((pct) => pct >= 0.35 && pct <= 8).length;
  const pass = observedAccounts >= 4
    && topUserPct <= 12
    && top5UsersPct <= 30
    && top10UsersPct <= 45
    && meaningfulWallets >= 2;

  return {
    pass,
    provider: 'solana-rpc',
    limitedEvidence: false,
    curveExcluded,
    curveSharePct: curveExcluded ? shares[0] : 0,
    observedAccounts,
    topUserPct,
    top5UsersPct,
    top10UsersPct,
    meaningfulWallets
  };
}

async function fetchBirdeyeHolderProfile(mint) {
  if (!env.birdeyeApiKey) return null;
  const [overview, security] = await Promise.all([
    fetchTokenOverview(env.birdeyeApiKey, mint),
    fetchTokenSecurity(env.birdeyeApiKey, mint)
  ]);
  const holderCount = optionalFinite(overview?.holderCount);
  const top10 = optionalFinite(security?.top10HolderPct);
  if (!(holderCount > 0) || !(top10 > 0)) return null;
  return {
    pass: holderCount >= 20 && top10 <= 45,
    provider: 'birdeye',
    limitedEvidence: true,
    curveExcluded: false,
    curveSharePct: null,
    observedAccounts: holderCount,
    topUserPct: null,
    top5UsersPct: null,
    top10UsersPct: top10,
    meaningfulWallets: null
  };
}

function qualityScore(state, market, profile) {
  const ageSec = (Date.now() - state.createdAt) / 1000;
  const ratio = market.buys5m / Math.max(1, market.sells5m);
  let score = 0;
  if (state.initialBuy) score += 15;
  if (ageSec <= 60) score += 12;
  else if (ageSec <= 180) score += 7;
  if (market.marketCapUsd > 0 && market.marketCapUsd <= 1_200_000) score += 10;
  else if (market.marketCapUsd > 0 && market.marketCapUsd <= 1_800_000) score += 5;
  if (market.buys5m >= 5) score += 10;
  if (market.buys5m >= 10) score += 5;
  if (market.sells5m >= 1) score += 5;
  if (ratio >= 1.4) score += 10;
  if (ratio >= 2) score += 5;
  if (market.volume5mUsd >= 400) score += 8;
  if (market.volume5mUsd >= 1_500) score += 5;
  if (market.priceChange5mPct <= 35) score += 5;
  if (profile?.pass) score += 20;
  if (profile?.meaningfulWallets >= 3) score += 5;
  return Math.min(100, score);
}

export class SolanaUltraEarlyWorker {
  constructor() {
    this.enabled = boolEnv('SOLANA_ULTRA_ENABLED', true);
    this.rawLaunchAlerts = boolEnv('SOLANA_RAW_LAUNCH_ALERTS', false);
    this.marketPollMs = numEnv('SOLANA_ULTRA_MARKET_POLL_MS', 1_500, 1_000, 5_000);
    this.minScore = numEnv('SOLANA_QUALIFIED_MIN_SCORE', 72, 50, 95);
    this.paperProbeMinScore = numEnv('SOLANA_PAPER_PROBE_MIN_SCORE', 68, 55, 90);
    this.topScore = numEnv('SOLANA_TOP_MIN_SCORE', 86, 70, 100);
    this.profileRefreshMs = numEnv('SOLANA_HOLDER_REFRESH_MS', 4_000, 2_000, 15_000);
    this.pendingMaxAgeMs = numEnv('SOLANA_PENDING_MAX_AGE_MS', 8 * 60_000, 4 * 60_000, 20 * 60_000);
    this.pumpNativeMaxPerCycle = numEnv('PUMP_NATIVE_MAX_PER_CYCLE', 4, 1, 8);
    this.ws = null;
    this.active = false;
    this.reconnectAttempt = 0;
    this.seenSignatures = new Set();
    this.pending = new Map();
    this.marketRunning = false;
    this.bridge = new SolanaTradeCandidateBridge();
    this.funnel = {
      detected: 0,
      market: 0,
      plausible: 0,
      profilePass: 0,
      qualified: 0,
      paperOpened: 0,
      rejectionReasons: new Map(),
      lastLogAt: 0
    };
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
      lastProfileAt: 0,
      profile: null,
      rootMessageId: 0,
      launchSent: false,
      qualifiedSent: false,
      topSent: false
    };
    if (initialBuy) state.initialBuy = true;
    if (!prior) this.funnel.detected += 1;
    this.pending.set(mint, state);
    if (this.pending.size > 700) {
      const oldest = [...this.pending.entries()].sort((a, b) => a[1].createdAt - b[1].createdAt).slice(0, 100);
      for (const [key] of oldest) this.pending.delete(key);
    }
    return state;
  }

  async sendRawLaunch(mint, state) {
    if (state.launchSent || !this.rawLaunchAlerts) return;
    state.launchSent = true;
    const age = Math.max(0, Math.round((Date.now() - state.createdAt) / 1000));
    const message = await sink.send([
      '🚨 SUMMECA RAW LAUNCH — SOLANA / PUMP.FUN',
      '',
      `⏱️ العمر: ~${age}s`,
      `🟢 شراء أولي: ${state.initialBuy ? 'نعم' : 'غير مؤكد'}`,
      '⚠️ RAW = رصد خام قبل فلتر الجودة.',
      `CA: ${mint}`
    ].join('\n'), mint);
    state.rootMessageId = Number(message?.message_id ?? 0);
  }

  async sendQualified(mint, state, market, profile, score) {
    if (state.qualifiedSent) return;
    state.qualifiedSent = true;
    const age = Math.max(1, Math.round((Date.now() - state.createdAt) / 1000));
    const ratio = market.buys5m / Math.max(1, market.sells5m);
    const message = await sink.send([
      '✅⚡ SUMMECA QUALIFIED LAUNCH — SOLANA',
      '',
      `$${market.symbol} • Pump.fun`,
      `🎯 Quality Score: ${score}/100`,
      `⏱️ العمر: ${age}s`,
      `🟢 شراء أولي داخل الإنشاء: ${state.initialBuy ? 'نعم' : 'لا'}`,
      `💧 السيولة: $${money(market.liquidityUsd)} | MC: $${money(market.marketCapUsd)}`,
      `5m: شراء ${market.buys5m} / بيع ${market.sells5m} | Ratio ${ratio.toFixed(2)}x`,
      `Vol: $${money(market.volume5mUsd)}`,
      `👥 الحائزون/الحسابات المرصودة: ${profile.observedAccounts ?? '—'}`,
      `🐋 محافظ بحيازة مؤثرة: ${profile.meaningfulWallets ?? '—'}`,
      `🔝 أكبر حامل خارج حساب المنحنى: ${profile.topUserPct == null ? '—' : `${profile.topUserPct.toFixed(1)}%`}`,
      `Top 5 خارج المنحنى: ${profile.top5UsersPct == null ? '—' : `${profile.top5UsersPct.toFixed(1)}%`}`,
      `مصدر الحيازة: ${profile.provider || 'solana-rpc'}${profile.limitedEvidence ? ' (fallback)' : ''}`,
      '🛡️ توزيع الحيازة: PASSED',
      '',
      '⚠️ اجتياز الفلتر لا يضمن استمرار الصعود.',
      `CA: ${mint}`
    ].join('\n'), mint, { marketUrl: market.url, replyTo: state.rootMessageId });
    if (!state.rootMessageId) state.rootMessageId = Number(message?.message_id ?? 0);
    console.log(`[solana:qualified] mint=${short(mint)} score=${score} holders=${profile.observedAccounts ?? 'na'} top=${profile.topUserPct == null ? 'na' : `${profile.topUserPct.toFixed(1)}%`} age=${age}s`);
  }

  async sendTop(mint, state, market, profile, score) {
    if (state.topSent) return;
    state.topSent = true;
    const age = Math.max(1, Math.round((Date.now() - state.createdAt) / 1000));
    const ratio = market.buys5m / Math.max(1, market.sells5m);
    await sink.send([
      '💎🔥 SUMMECA TOP-TIER — SOLANA',
      '',
      `$${market.symbol} • Pump.fun`,
      `🎯 Quality Score: ${score}/100`,
      `⏱️ العمر: ${age}s`,
      `💧 السيولة: $${money(market.liquidityUsd)} | MC: $${money(market.marketCapUsd)}`,
      `5m: شراء ${market.buys5m} / بيع ${market.sells5m} | Ratio ${ratio.toFixed(2)}x`,
      `Vol: $${money(market.volume5mUsd)}`,
      `🐋 حيازات مؤثرة: ${profile.meaningfulWallets ?? '—'} | Top holder: ${profile.topUserPct == null ? '—' : `${profile.topUserPct.toFixed(1)}%`}`,
      '✅ شراء أولي + نشاط سوق + توزيع حيازة + ضغط شراء قوي',
      '',
      '⚠️ TOP-TIER = أقوى شروط الرادار، وليس ضمان ربح.',
      `CA: ${mint}`
    ].join('\n'), mint, { marketUrl: market.url, replyTo: state.rootMessageId });
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
      console.log(`[solana:ultra-new] mint=${short(mint)} sig=${short(signature)} initialBuy=${initialBuy ? 'yes' : 'no'} notify=filtered`);
      if (state) await this.sendRawLaunch(mint, state);
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
      console.log(`SUMMECA SOLANA ULTRA: filtered Pump.fun stream connected poll=${this.marketPollMs}ms score>=${this.minScore}`);
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

  async profileFor(mint, state) {
    const now = Date.now();
    if (state.profile && now - state.lastProfileAt < this.profileRefreshMs) return state.profile;
    state.lastProfileAt = now;
    const prior = state.profile;

    try {
      const helius = await fetchHeliusHolderProfile(env.heliusApiKey, mint);
      if (helius) {
        state.profile = helius;
        console.log(`[solana:holder-profile] mint=${short(mint)} provider=helius-token-accounts holders=${helius.observedAccounts} top=${helius.topUserPct.toFixed(1)}% pass=${helius.pass ? 'yes' : 'no'} complete=${helius.complete ? 'yes' : 'no'}`);
        return helius;
      }
    } catch (error) {
      if (error?.code !== 'HELIUS_HOLDER_COOLDOWN') {
        console.warn(`[solana:holder-helius] mint=${short(mint)} ${error.message}`);
      }
    }

    try {
      const gpa = await fetchProgramAccountHolderProfile(mint);
      if (gpa) {
        state.profile = gpa;
        console.log(`[solana:holder-profile] mint=${short(mint)} provider=solana-getProgramAccounts holders=${gpa.observedAccounts} top=${gpa.topUserPct.toFixed(1)}% pass=${gpa.pass ? 'yes' : 'no'}`);
        return gpa;
      }
    } catch (error) {
      console.warn(`[solana:holder-gpa] mint=${short(mint)} ${error.message}`);
    }

    try {
      const direct = await fetchHolderProfile(mint);
      if (direct) {
        state.profile = direct;
        return direct;
      }
    } catch (error) {
      console.warn(`[solana:holder-rpc] mint=${short(mint)} ${error.message}`);
    }

    try {
      const fallback = await fetchBirdeyeHolderProfile(mint);
      if (fallback) {
        state.profile = fallback;
        console.log(`[solana:holder-fallback] mint=${short(mint)} provider=birdeye holders=${fallback.observedAccounts} top10=${fallback.top10UsersPct.toFixed(1)}%`);
        return fallback;
      }
    } catch (error) {
      console.warn(`[solana:holder-fallback] mint=${short(mint)} ${error.message}`);
    }

    return prior || null;
  }

  rejectionReason(state, market) {
    const ageMs = Date.now() - state.createdAt;
    const ratio = market.buys5m / Math.max(1, market.sells5m);
    if (!state.initialBuy) return 'no-initial-buy';
    if (ageMs > 4 * 60_000) return 'candidate-too-old';
    if (!(market.marketCapUsd > 0)) return 'market-cap-unavailable';
    if (market.marketCapUsd > 1_800_000) return 'market-cap-too-high';
    if (market.buys5m < 4) return 'insufficient-buys-5m';
    if (market.volume5mUsd < 250) return 'insufficient-volume-5m';
    if (ratio < 1.2) return 'weak-buy-sell-ratio';
    if (market.priceChange5mPct > 55) return 'move-overextended';
    return null;
  }

  noteRejection(reason) {
    const key = String(reason || 'unknown');
    this.funnel.rejectionReasons.set(key, (this.funnel.rejectionReasons.get(key) || 0) + 1);
  }

  logFunnel() {
    const now = Date.now();
    if (now - this.funnel.lastLogAt < 60_000) return;
    this.funnel.lastLogAt = now;
    const rejected = [...this.funnel.rejectionReasons.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 5)
      .map(([reason, count]) => `${reason}=${count}`)
      .join(',');
    console.log(`[solana:funnel] detected=${this.funnel.detected} market=${this.funnel.market} plausible=${this.funnel.plausible} profilePass=${this.funnel.profilePass} qualified=${this.funnel.qualified} paper=${this.funnel.paperOpened} rejects=[${rejected}]`);
  }

  async handleMarket(mint, state, market) {
    const ageMs = Date.now() - state.createdAt;
    this.funnel.market += 1;

    const existingPaper = this.bridge.hasOpenPaperPosition(mint);
    const reject = this.rejectionReason(state, market);
    if (reject) {
      this.noteRejection(reject);
      await this.bridge.observe({
        mint,
        state,
        market,
        profile: state.profile,
        score: state.lastScore || 0,
        qualified: false,
        rejectionReason: reject
      });
      if (!existingPaper) return;
    } else {
      this.funnel.plausible += 1;
    }

    if (ageMs > 8 * 60_000 && !existingPaper) return;

    const profile = await this.profileFor(mint, state);
    if (!profile) {
      this.noteRejection('profile-provider-pending');
      const score = qualityScore(state, market, null);
      state.lastScore = score;
      const paperEligible = isSolanaPaperProbeEligible({
        rejectionReason: reject,
        score,
        minScore: this.paperProbeMinScore
      });
      const bridgeResult = await this.bridge.observe({
        mint,
        state,
        market,
        profile: null,
        score,
        qualified: false,
        paperEligible,
        rejectionReason: 'profile-provider-pending'
      });
      if (bridgeResult?.paperOpened) this.funnel.paperOpened += 1;
      return;
    }

    if (!profile.pass) {
      this.noteRejection('holder-profile-failed');
      await this.bridge.observe({
        mint,
        state,
        market,
        profile,
        score: state.lastScore || 0,
        qualified: false,
        rejectionReason: 'holder-profile-failed'
      });
      return;
    }
    this.funnel.profilePass += 1;

    const score = qualityScore(state, market, profile);
    state.lastScore = score;
    const ratio = market.buys5m / Math.max(1, market.sells5m);
    const qualified = !reject
      && score >= this.minScore
      && market.buys5m >= 5
      && market.volume5mUsd >= 400
      && ratio >= 1.3;

    let rejectionReason = null;
    if (!qualified) {
      if (score < this.minScore) rejectionReason = 'quality-score-below-threshold';
      else if (market.buys5m < 5) rejectionReason = 'qualified-buys-below-threshold';
      else if (market.volume5mUsd < 400) rejectionReason = 'qualified-volume-below-threshold';
      else if (ratio < 1.3) rejectionReason = 'qualified-ratio-below-threshold';
      else rejectionReason = reject || 'qualification-pending';
      this.noteRejection(rejectionReason);
    }

    const bridgeResult = await this.bridge.observe({
      mint,
      state,
      market,
      profile,
      score,
      qualified,
      rejectionReason
    });
    if (bridgeResult?.paperOpened) this.funnel.paperOpened += 1;

    if (qualified) {
      this.funnel.qualified += 1;
      if (!state.qualifiedSent) await this.sendQualified(mint, state, market, profile, score);
    }

    const top = state.qualifiedSent
      && score >= this.topScore
      && market.marketCapUsd <= 1_200_000
      && market.buys5m >= 10
      && market.sells5m >= 1
      && market.volume5mUsd >= 1_500
      && ratio >= 1.7
      && market.priceChange5mPct <= 40;
    if (top && !state.topSent) await this.sendTop(mint, state, market, profile, score);
  }

  async marketCycle() {
    if (this.marketRunning || !this.pending.size) return;
    this.marketRunning = true;
    try {
      const now = Date.now();
      const openPaperAddresses = new Set(this.bridge.openPositions().map((position) => String(position.address)));
      let pruned = 0;
      for (const [mint, state] of this.pending) {
        if (openPaperAddresses.has(String(mint))) continue;
        if (now - finite(state?.createdAt, 0) > this.pendingMaxAgeMs) {
          this.pending.delete(mint);
          pruned += 1;
        }
      }
      if (pruned) console.log(`[solana:scheduler] pruned-stale=${pruned} pending=${this.pending.size}`);
      const selected = selectSolanaMarketCandidates(this.pending.entries(), {
        now,
        pollMs: this.marketPollMs,
        limit: 30,
        maxCandidateAgeMs: this.pendingMaxAgeMs,
        openPaperAddresses
      });
      if (!selected.length) return;
      for (const [, state] of selected) state.lastMarketAt = now;
      const mints = selected.map(([mint]) => mint);
      const best = new Map();
      try {
        const rows = await fetchMarkets(mints);
        for (const pair of rows) {
          const mint = mints.find((candidate) => String(pair?.baseToken?.address ?? '') === candidate || String(pair?.quoteToken?.address ?? '') === candidate);
          if (!mint) continue;
          const market = normalizeMarket(pair, mint);
          if (!market) continue;
          const prior = best.get(mint);
          if (!prior || market.liquidityUsd > prior.liquidityUsd || market.volume5mUsd > prior.volume5mUsd) best.set(mint, market);
        }
      } catch (error) {
        console.warn('[solana:dex-market]', error?.message ?? error);
      }

      const missing = selected.filter(([mint]) => !best.has(mint));
      const pumpRows = await fetchPumpNativeMarkets(missing.map(([mint]) => mint), {
        limit: this.pumpNativeMaxPerCycle
      });
      const pumpByMint = new Map(pumpRows.map((market) => [market.mint, market]));

      for (const [mint, state] of selected) {
        const market = best.get(mint);
        if (market) {
          await this.handleMarket(mint, state, market);
          continue;
        }

        const pumpMarket = pumpByMint.get(mint);
        if (pumpMarket) {
          state.lastPumpMarket = pumpMarket;
          if (openPaperAddresses.has(String(mint))) {
            await this.handleMarket(mint, state, pumpMarket);
          } else {
            await this.bridge.recordStage({
              mint,
              state,
              stage: 'pump_indexed',
              reason: 'awaiting-flow-index',
              metadata: {
                marketSource: 'pump-native',
                symbol: pumpMarket.symbol,
                priceUsd: pumpMarket.priceUsd,
                marketCapUsd: pumpMarket.marketCapUsd,
                creator: pumpMarket.creator,
                complete: pumpMarket.complete,
                bondingCurve: pumpMarket.bondingCurve,
                lastTradeAt: pumpMarket.lastTradeAt
              }
            });
          }
          continue;
        }

        await this.bridge.recordStage({
          mint,
          state,
          stage: 'market_pending',
          reason: 'market-not-indexed-yet'
        });
      }
      this.logFunnel();
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
    void this.bridge.initialize().then((positions) => {
      for (const position of positions || []) {
        const state = this.rememberMint(position.address, 'restored-paper', true);
        if (!state) continue;
        state.createdAt = Number(position.entryAt) || Date.now();
        state.qualifiedSent = true;
        state.lastScore = 72;
      }
    }).catch((error) => console.warn('[solana:paper-bridge:init]', error?.message ?? error));
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
