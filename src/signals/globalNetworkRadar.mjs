import { env } from '../config/env.mjs';
import { telegramApi } from '../notifiers/telegram.mjs';
import { AppSettings } from '../storage/appSettings.mjs';

const GECKO_API = 'https://api.geckoterminal.com/api/v2';
const POLL_MS = 60_000;
const MAX_AGE_MS = 12 * 60 * 1000;
const ALERT_TTL_MS = 6 * 60 * 60 * 1000;
const MAX_ALERTS_PER_CYCLE = 4;
const SKIP_NETWORKS = new Set(['solana', 'bsc', 'robinhood']);
const COMMON_QUOTES = new Set([
  'ETH', 'WETH', 'BNB', 'WBNB', 'BTC', 'WBTC', 'SOL', 'WSOL', 'AVAX', 'WAVAX',
  'MATIC', 'WMATIC', 'POL', 'WPOL', 'FTM', 'WFTM', 'SUI', 'TON', 'USDC', 'USDC.E',
  'USDT', 'USDT0', 'DAI', 'FDUSD', 'USDE', 'USDS', 'BUSD', 'TUSD', 'FRAX', 'WSTETH'
]);

const num = (value, fallback = 0) => {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
};
const lower = (value) => String(value ?? '').trim().toLowerCase();
const cleanSymbol = (value) => String(value ?? 'TOKEN').replace(/^\$/, '').trim() || 'TOKEN';
const money = (value) => {
  const n = num(value);
  if (n >= 1_000_000_000) return `${(n / 1_000_000_000).toFixed(1)}B`;
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return n.toFixed(n >= 100 ? 0 : 2);
};
const priceLabel = (value) => {
  const n = num(value);
  if (!(n > 0)) return '—';
  return n >= 0.01 ? n.toLocaleString('en-US', { maximumFractionDigits: 8 }) : n.toExponential(6);
};

function includedTokenMap(payload) {
  const out = new Map();
  for (const item of Array.isArray(payload?.included) ? payload.included : []) {
    if (String(item?.type ?? '').toLowerCase() !== 'token') continue;
    const attrs = item?.attributes ?? {};
    const address = String(attrs.address ?? '').trim();
    if (!address) continue;
    out.set(String(item.id), {
      address,
      name: attrs.name ? String(attrs.name) : undefined,
      symbol: attrs.symbol ? String(attrs.symbol) : undefined,
      imageUrl: attrs.image_url ? String(attrs.image_url) : undefined
    });
  }
  return out;
}

function pickTrackedToken(pool, tokenMap) {
  const baseId = String(pool?.relationships?.base_token?.data?.id ?? '');
  const quoteId = String(pool?.relationships?.quote_token?.data?.id ?? '');
  const base = tokenMap.get(baseId) ?? null;
  const quote = tokenMap.get(quoteId) ?? null;
  if (!base && !quote) return null;
  if (!base) return { token: quote, side: 'quote' };
  if (!quote) return { token: base, side: 'base' };

  const baseCommon = COMMON_QUOTES.has(String(base.symbol ?? '').toUpperCase());
  const quoteCommon = COMMON_QUOTES.has(String(quote.symbol ?? '').toUpperCase());
  if (baseCommon && !quoteCommon) return { token: quote, side: 'quote' };
  return { token: base, side: 'base' };
}

export function parseGlobalPools(payload, observedAt = Date.now()) {
  const tokenMap = includedTokenMap(payload);
  const parsed = [];
  for (const pool of Array.isArray(payload?.data) ? payload.data : []) {
    const attrs = pool?.attributes ?? {};
    const network = String(pool?.relationships?.network?.data?.id ?? '').trim();
    if (!network || SKIP_NETWORKS.has(lower(network))) continue;

    const selected = pickTrackedToken(pool, tokenMap);
    if (!selected?.token?.address) continue;
    const token = selected.token;
    const createdAt = Date.parse(attrs.pool_created_at ?? '') || observedAt;
    const ageSec = Math.max(1, (observedAt - createdAt) / 1000);
    const observedWindowSec = Math.max(30, Math.min(300, ageSec));
    const windows30 = Math.max(1, observedWindowSec / 30);
    const tx5 = attrs.transactions?.m5 ?? {};
    const buys5 = num(tx5.buys);
    const sells5 = num(tx5.sells);
    const volume5mUsd = num(attrs.volume_usd?.m5);
    const volume30sUsd = volume5mUsd / windows30;
    const tradeTotal = Math.max(1, buys5 + sells5);
    const buyShare = buys5 / tradeTotal;
    const sellShare = sells5 / tradeTotal;
    const priceUsd = selected.side === 'quote'
      ? num(attrs.quote_token_price_usd)
      : num(attrs.base_token_price_usd);

    parsed.push({
      networkType: 'global',
      chain: network,
      networkLabel: network,
      address: token.address,
      name: token.name ?? 'New token',
      symbol: token.symbol ?? 'NEW',
      imageUrl: token.imageUrl,
      source: `geckoterminal-global:${network}:${String(pool?.relationships?.dex?.data?.id ?? 'dex')}`,
      dexPairAddress: String(attrs.address ?? '').trim() || undefined,
      listedAt: createdAt,
      observedAt,
      priceUsd,
      liquidityUsd: num(attrs.reserve_in_usd),
      marketCapUsd: num(attrs.market_cap_usd, num(attrs.fdv_usd)),
      buys30s: buys5 / windows30,
      sells30s: sells5 / windows30,
      trades5m: buys5 + sells5,
      buyVolume30sUsd: volume30sUsd * buyShare,
      sellVolume30sUsd: volume30sUsd * sellShare,
      uniqueBuyers30s: num(tx5.buyers) / windows30,
      volume5mUsd,
      priceChange5mPct: num(attrs.price_change_percentage?.m5),
      priceChange1hPct: num(attrs.price_change_percentage?.h1),
      marketDataVerified: priceUsd > 0 && (buys5 + sells5 > 0 || volume5mUsd > 0),
      discoverySource: 'geckoterminal-all-networks'
    });
  }
  return parsed;
}

export function globalMomentumDecision(snapshot, now = Date.now()) {
  const ageMs = Math.max(0, now - num(snapshot?.listedAt, now));
  const price = num(snapshot?.priceUsd);
  const liquidity = num(snapshot?.liquidityUsd);
  const volume5 = num(snapshot?.volume5mUsd);
  const buys = num(snapshot?.buys30s);
  const sells = num(snapshot?.sells30s);
  const trades5m = num(snapshot?.trades5m);
  const price5 = num(snapshot?.priceChange5mPct);
  const ratio = buys / Math.max(1, sells);

  if (ageMs > MAX_AGE_MS) return { ok: false, reason: 'too-old', score: 0 };
  if (!(price > 0) || snapshot?.marketDataVerified !== true) return { ok: false, reason: 'market-unverified', score: 0 };
  if (liquidity < 2_000 && volume5 < 5_000) return { ok: false, reason: 'thin-market', score: 0 };
  if (trades5m < 8 && volume5 < 5_000) return { ok: false, reason: 'low-activity', score: 0 };
  if (ratio < 1.2 && price5 < 12) return { ok: false, reason: 'weak-buy-flow', score: 0 };

  let score = 0;
  score += Math.min(35, Math.max(0, price5) * 1.4);
  score += Math.min(25, Math.log10(volume5 + 1) * 5);
  score += Math.min(20, Math.log10(liquidity + 1) * 4);
  score += Math.min(20, Math.max(0, ratio - 1) * 10);
  score += Math.min(15, trades5m / 3);
  if (ageMs <= 3 * 60 * 1000) score += 8;

  const explosive = price5 >= 10
    || (ratio >= 1.8 && buys >= 3 && volume5 >= 2_000)
    || (trades5m >= 20 && ratio >= 1.35 && volume5 >= 5_000);
  return { ok: explosive && score >= 60, reason: explosive ? 'score' : 'not-explosive', score: Math.round(score) };
}

async function fetchGlobalFeed(path, timeoutMs = 9000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(`${GECKO_API}${path}`, {
      signal: controller.signal,
      headers: { accept: 'application/json;version=20230203' }
    });
    if (!response.ok) {
      const error = new Error(`GeckoTerminal global HTTP ${response.status}`);
      error.status = response.status;
      throw error;
    }
    return response.json();
  } finally {
    clearTimeout(timer);
  }
}

function keyboard(snapshot) {
  const rows = [[{ text: '📋 CA', copy_text: { text: String(snapshot.address) } }]];
  if (snapshot.dexPairAddress) {
    rows[0].push({
      text: '🦎 GeckoTerminal',
      url: `https://www.geckoterminal.com/${encodeURIComponent(snapshot.chain)}/pools/${encodeURIComponent(snapshot.dexPairAddress)}`
    });
  }
  return { inline_keyboard: rows };
}

function signalText(snapshot, decision, language) {
  const buys = num(snapshot.buys30s);
  const sells = num(snapshot.sells30s);
  const ratio = buys / Math.max(1, sells);
  const venue = String(snapshot.source ?? '').split(':').at(-1) || 'DEX';
  const ar = [
    '⚡ SUMMECA EARLY MOMENTUM — SAFETY PENDING',
    '',
    `$${cleanSymbol(snapshot.symbol)} • ${snapshot.name ?? 'Token'}`,
    `🌐 الشبكة: ${snapshot.chain}  |  📍 ${venue}`,
    `CA: ${snapshot.address}`,
    '',
    `MC/FDV: $${money(snapshot.marketCapUsd)}  |  Vol 5m: $${money(snapshot.volume5mUsd)}`,
    `💧 Liquidity: $${money(snapshot.liquidityUsd)}  |  💵 Price: $${priceLabel(snapshot.priceUsd)}`,
    `🟢 شراء 30ث: ${buys.toFixed(1)}  |  🔴 بيع: ${sells.toFixed(1)}  |  Ratio ${ratio.toFixed(2)}x`,
    `📈 5m: ${num(snapshot.priceChange5mPct).toFixed(1)}%  |  ⚡ Global momentum: ${decision.score}/100`,
    '',
    '🌍 تم التقاطها من الرادار العالمي متعدد الشبكات.',
    '⚠️ بيانات السوق والزخم متوفرة، لكن فحص أمان العقد لم يكتمل على هذه الشبكة بعد.',
    '⛔ لا تداول آلي من هذه الإشارة حتى نجاح فحص أمان خاص بالشبكة.'
  ].join('\n');
  const en = [
    '⚡ SUMMECA EARLY MOMENTUM — SAFETY PENDING',
    '',
    `$${cleanSymbol(snapshot.symbol)} • ${snapshot.name ?? 'Token'}`,
    `🌐 Network: ${snapshot.chain}  |  📍 ${venue}`,
    `CA: ${snapshot.address}`,
    '',
    `MC/FDV: $${money(snapshot.marketCapUsd)}  |  Vol 5m: $${money(snapshot.volume5mUsd)}`,
    `💧 Liquidity: $${money(snapshot.liquidityUsd)}  |  💵 Price: $${priceLabel(snapshot.priceUsd)}`,
    `🟢 Buys 30s: ${buys.toFixed(1)}  |  🔴 Sells: ${sells.toFixed(1)}  |  Ratio ${ratio.toFixed(2)}x`,
    `📈 5m: ${num(snapshot.priceChange5mPct).toFixed(1)}%  |  ⚡ Global momentum: ${decision.score}/100`,
    '',
    '🌍 Detected by the all-network market radar.',
    '⚠️ Market/momentum data is available, but chain-specific contract security is not fully verified yet.',
    '⛔ No autonomous execution from this signal until a chain-specific safety gate passes.'
  ].join('\n');
  if (language === 'en') return en;
  if (language === 'bilingual') return `${ar}\n\n────────────\n\n${en}`;
  return ar;
}

async function sendSignal(token, chatId, language, snapshot, decision) {
  const text = signalText(snapshot, decision, language);
  const replyMarkup = keyboard(snapshot);
  if (snapshot.imageUrl) {
    try {
      return await telegramApi(token, 'sendPhoto', {
        chat_id: chatId,
        photo: snapshot.imageUrl,
        caption: text.slice(0, 1024),
        reply_markup: replyMarkup
      });
    } catch (error) {
      console.warn(`[global-radar:photo] ${snapshot.chain} ${error.message}`);
    }
  }
  return telegramApi(token, 'sendMessage', { chat_id: chatId, text, reply_markup: replyMarkup });
}

async function resolveTelegramContext() {
  const settings = new AppSettings(env.supabaseUrl, env.supabaseSecretKey);
  let chatId = String(env.telegramChatId ?? '').trim();
  let language = env.telegramLanguage;
  if (settings.enabled) {
    try {
      chatId ||= String(await settings.get('telegram_chat_id') ?? '').trim();
      const savedLanguage = String(await settings.get('telegram_language') ?? '').trim().toLowerCase();
      if (['ar', 'en', 'bilingual'].includes(savedLanguage)) language = savedLanguage;
    } catch (error) {
      console.warn(`[global-radar:settings] ${error.message}`);
    }
  }
  return { chatId, language };
}

export async function startGlobalNetworkRadar() {
  if (!env.telegramBotToken) {
    console.log('[global-radar] SKIPPED — Telegram bot token missing');
    return null;
  }
  const { chatId, language } = await resolveTelegramContext();
  if (!chatId) {
    console.log('[global-radar] SKIPPED — Telegram chat is not linked yet');
    return null;
  }

  const alerted = new Map();
  let running = false;
  let rateLimitedUntil = 0;

  const cycle = async () => {
    if (running || Date.now() < rateLimitedUntil) return;
    running = true;
    try {
      const payloads = [];
      try {
        payloads.push(await fetchGlobalFeed('/networks/new_pools?include=base_token,quote_token,dex,network&page=1'));
        await new Promise((resolve) => setTimeout(resolve, 450));
        payloads.push(await fetchGlobalFeed('/networks/trending_pools?include=base_token,quote_token,dex,network&duration=5m&page=1'));
      } catch (error) {
        if (error?.status === 429) {
          rateLimitedUntil = Date.now() + 90_000;
          console.warn('[global-radar] GeckoTerminal rate limited; backing off for 90s');
          return;
        }
        throw error;
      }

      const now = Date.now();
      for (const [key, at] of alerted) if (now - at > ALERT_TTL_MS) alerted.delete(key);
      const merged = new Map();
      for (const payload of payloads) {
        for (const snapshot of parseGlobalPools(payload, now)) {
          const key = `${lower(snapshot.chain)}:${lower(snapshot.address)}`;
          const current = merged.get(key);
          if (!current || num(snapshot.volume5mUsd) > num(current.volume5mUsd)) merged.set(key, snapshot);
        }
      }

      const candidates = [...merged.values()]
        .map((snapshot) => ({ snapshot, decision: globalMomentumDecision(snapshot, now) }))
        .filter((item) => item.decision.ok)
        .sort((a, b) => b.decision.score - a.decision.score);

      let sent = 0;
      for (const { snapshot, decision } of candidates) {
        if (sent >= MAX_ALERTS_PER_CYCLE) break;
        const key = `${lower(snapshot.chain)}:${lower(snapshot.address)}`;
        if (alerted.has(key)) continue;
        try {
          const message = await sendSignal(env.telegramBotToken, chatId, language, snapshot, decision);
          if (message?.message_id) {
            alerted.set(key, now);
            sent += 1;
            console.log(`[global-radar:signal] network=${snapshot.chain} token=${snapshot.symbol} address=${snapshot.address} momentum=${decision.score}`);
          }
        } catch (error) {
          console.warn(`[global-radar:telegram] ${snapshot.chain} ${error.message}`);
        }
      }

      const networks = new Set([...merged.values()].map((item) => item.chain));
      console.log(`[global-radar] pools=${merged.size} networks=${networks.size} candidates=${candidates.length} sent=${sent} dedicated-skipped=solana,bsc,robinhood`);
    } catch (error) {
      console.warn(`[global-radar] ${error.message}`);
    } finally {
      running = false;
    }
  };

  await cycle();
  const timer = setInterval(() => void cycle(), POLL_MS);
  timer.unref?.();
  console.log('[global-radar] READY — all GeckoTerminal-indexed networks + global 5m trending; Solana, BSC and Robinhood remain on dedicated scanners; safety-pending alerts only');
  return { stop: () => clearInterval(timer) };
}
