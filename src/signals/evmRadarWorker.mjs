import { env } from '../config/env.mjs';
import { scoreToken } from '../core/scoring.mjs';
import { telegramApi } from '../notifiers/telegram.mjs';
import { AppSettings } from '../storage/appSettings.mjs';

const GECKO_API = 'https://api.geckoterminal.com/api/v2';
const DEX_API = 'https://api.dexscreener.com';
const GOPLUS_API = 'https://api.gopluslabs.io/api/v1/token_security';
const EVM_ADDRESS = /^0x[0-9a-fA-F]{40}$/;
const POLL_MS = 30_000;
const MAX_AGE_MS = 10 * 60 * 1000;
const SECURITY_REFRESH_MS = 2 * 60 * 1000;
const MAX_TRACKED_PER_NETWORK = 30;

const NETWORKS = [
  {
    key: 'bsc',
    chainId: '56',
    labelAr: 'BNB Smart Chain',
    labelEn: 'BNB Smart Chain',
    explorer: 'https://bscscan.com/token/',
    quoteTokens: [
      '0xbb4cdb9cbd36b01bd1cbaebf2de08d9173bc095c', // WBNB
      '0x55d398326f99059ff775485246999027b3197955', // USDT
      '0x8ac76a51cc950d9822d68b83fe1ad97b32cd580d', // USDC
      '0xc5f0f7b66764f6ec8c8dff7ba683102295e16409'  // FDUSD
    ]
  },
  {
    key: 'robinhood',
    chainId: '4663',
    labelAr: 'Robinhood Chain',
    labelEn: 'Robinhood Chain',
    explorer: 'https://robinhoodchain.blockscout.com/token/',
    quoteTokens: [
      '0x0bd7d308f8e1639fab988df18a8011f41eacad73', // WETH
      '0x5fc5360d0400a0fd4f2af552add042d716f1d168', // USDG
      '0x5d3a1ff2b6bab83b63cd9ad0787074081a52ef34'  // USDE
    ]
  }
];

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const num = (value, fallback = 0) => {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
};
const boolFlag = (value) => String(value ?? '') === '1';
const falseFlag = (value) => String(value ?? '') === '0';
const lower = (value) => String(value ?? '').toLowerCase();
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

function relationAddress(id) {
  const value = String(id ?? '');
  const match = value.match(/(0x[0-9a-fA-F]{40})$/);
  return match?.[1] ?? (EVM_ADDRESS.test(value) ? value : '');
}

function includedTokenMap(payload) {
  const map = new Map();
  for (const item of Array.isArray(payload?.included) ? payload.included : []) {
    if (String(item?.type ?? '').toLowerCase() !== 'token') continue;
    const attrs = item?.attributes ?? {};
    const address = String(attrs.address ?? relationAddress(item?.id)).trim();
    if (!EVM_ADDRESS.test(address)) continue;
    map.set(String(item.id), {
      address,
      name: attrs.name ? String(attrs.name) : undefined,
      symbol: attrs.symbol ? String(attrs.symbol) : undefined,
      imageUrl: attrs.image_url ? String(attrs.image_url) : undefined
    });
  }
  return map;
}

function poolCandidate(pool, network, tokenMap) {
  const attrs = pool?.attributes ?? {};
  const baseRel = pool?.relationships?.base_token?.data?.id;
  const quoteRel = pool?.relationships?.quote_token?.data?.id;
  const base = tokenMap.get(String(baseRel)) ?? { address: relationAddress(baseRel) };
  const quote = tokenMap.get(String(quoteRel)) ?? { address: relationAddress(quoteRel) };
  if (!EVM_ADDRESS.test(base.address ?? '') || !EVM_ADDRESS.test(quote.address ?? '')) return null;

  const quotes = new Set(network.quoteTokens.map(lower));
  const baseIsQuote = quotes.has(lower(base.address));
  const quoteIsQuote = quotes.has(lower(quote.address));
  if (baseIsQuote && quoteIsQuote) return null;
  const token = baseIsQuote && !quoteIsQuote ? quote : base;
  const createdAt = Date.parse(attrs.pool_created_at ?? '') || Date.now();

  return {
    networkType: 'evm',
    chain: network.key,
    chainId: network.chainId,
    networkLabel: network.labelEn,
    address: token.address,
    name: token.name ?? 'New token',
    symbol: token.symbol ?? 'NEW',
    imageUrl: token.imageUrl,
    source: `geckoterminal:${network.key}:${String(pool?.relationships?.dex?.data?.id ?? 'dex')}`,
    dexPairAddress: String(attrs.address ?? '').trim() || undefined,
    listedAt: createdAt,
    observedAt: Date.now(),
    priceUsd: 0,
    liquidityUsd: num(attrs.reserve_in_usd),
    marketCapUsd: num(attrs.market_cap_usd, num(attrs.fdv_usd)),
    discoverySource: 'geckoterminal-new-pools'
  };
}

async function fetchNewPools(network, timeoutMs = 8500) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(`${GECKO_API}/networks/${encodeURIComponent(network.key)}/new_pools?include=base_token,quote_token,dex&page=1`, {
      signal: controller.signal,
      headers: { accept: 'application/json;version=20230203' }
    });
    if (!response.ok) throw new Error(`GeckoTerminal ${network.key} HTTP ${response.status}`);
    const payload = await response.json();
    const tokenMap = includedTokenMap(payload);
    return (Array.isArray(payload?.data) ? payload.data : [])
      .map((pool) => poolCandidate(pool, network, tokenMap))
      .filter(Boolean);
  } finally {
    clearTimeout(timer);
  }
}

function bestPair(pairs, address, networkKey) {
  const key = lower(address);
  return (Array.isArray(pairs) ? pairs : [])
    .filter((pair) => lower(pair?.chainId) === lower(networkKey)
      && [pair?.baseToken?.address, pair?.quoteToken?.address].some((item) => lower(item) === key))
    .sort((a, b) => (num(b?.liquidity?.usd) * 1000 + num(b?.volume?.m5)) - (num(a?.liquidity?.usd) * 1000 + num(a?.volume?.m5)))[0] ?? null;
}

function snapshotFromPair(base, pair) {
  if (!pair) return base;
  const address = lower(base.address);
  const token = lower(pair?.baseToken?.address) === address ? pair.baseToken : pair.quoteToken;
  const pairCreatedAt = num(pair?.pairCreatedAt);
  const listedAt = num(base.listedAt) || pairCreatedAt || Date.now();
  const ageSec = Math.max(1, (Date.now() - listedAt) / 1000);
  const observedWindowSec = Math.max(30, Math.min(300, ageSec));
  const windows30 = Math.max(1, observedWindowSec / 30);
  const tx5 = pair?.txns?.m5 ?? {};
  const tx1h = pair?.txns?.h1 ?? {};
  const buys5 = num(tx5.buys);
  const sells5 = num(tx5.sells);
  const trades5 = buys5 + sells5;
  const trades1h = num(tx1h.buys) + num(tx1h.sells);
  const volume5mUsd = num(pair?.volume?.m5);
  const volume1hUsd = num(pair?.volume?.h1);
  const volume30sUsd = volume5mUsd / windows30;
  const buyShare = buys5 / Math.max(1, trades5);
  const sellShare = sells5 / Math.max(1, trades5);
  const previousTrade5mAvg = Math.max(1, (trades1h - trades5) / 11);
  const previousVolume5mAvg = Math.max(1, (volume1hUsd - volume5mUsd) / 11);
  const hasHistory = ageSec >= 360;
  return {
    ...base,
    name: token?.name ? String(token.name) : base.name,
    symbol: token?.symbol ? String(token.symbol) : base.symbol,
    source: `dexscreener:${base.chain}:${String(pair?.dexId ?? 'dex')}`,
    imageUrl: pair?.info?.imageUrl ? String(pair.info.imageUrl) : base.imageUrl,
    priceUsd: num(pair?.priceUsd),
    liquidityUsd: num(pair?.liquidity?.usd),
    marketCapUsd: num(pair?.marketCap, num(pair?.fdv)),
    buys30s: buys5 / windows30,
    sells30s: sells5 / windows30,
    buyVolume30sUsd: volume30sUsd * buyShare,
    sellVolume30sUsd: volume30sUsd * sellShare,
    volume5mUsd,
    priceChange5mPct: num(pair?.priceChange?.m5),
    priceChange1hPct: num(pair?.priceChange?.h1),
    buyerAcceleration: hasHistory ? trades5 / previousTrade5mAvg : 0,
    volumeAcceleration: hasHistory ? volume5mUsd / previousVolume5mAvg : 0,
    dexPairAddress: pair?.pairAddress ? String(pair.pairAddress) : base.dexPairAddress,
    listedAt,
    observedAt: Date.now(),
    marketDataVerified: num(pair?.priceUsd) > 0 && (trades5 > 0 || volume5mUsd > 0)
  };
}

async function fetchMarketBatch(network, candidates, timeoutMs = 8000) {
  const unique = [...new Map(candidates.map((item) => [lower(item.address), item])).values()].slice(0, 30);
  if (!unique.length) return new Map();
  const addresses = unique.map((item) => item.address).join(',');
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(`${DEX_API}/tokens/v1/${encodeURIComponent(network.key)}/${addresses}`, {
      signal: controller.signal,
      headers: { accept: 'application/json' }
    });
    if (!response.ok) throw new Error(`DexScreener ${network.key} HTTP ${response.status}`);
    const pairs = await response.json();
    const out = new Map();
    for (const base of unique) out.set(lower(base.address), snapshotFromPair(base, bestPair(pairs, base.address, network.key)));
    return out;
  } finally {
    clearTimeout(timer);
  }
}

function holderPercent(row) {
  const holders = Array.isArray(row?.holders) ? row.holders : [];
  let total = 0;
  for (const holder of holders.slice(0, 10)) {
    const tag = lower(holder?.tag);
    const ignored = holder?.is_locked === '1' || /burn|dead|black hole|lp|liquidity|pair|pool/.test(tag);
    if (!ignored) total += num(holder?.percent) * 100;
  }
  return total;
}

function securitySnapshot(row = {}) {
  const buyTax = String(row.buy_tax ?? '').trim() === '' ? null : num(row.buy_tax) * 100;
  const sellTax = String(row.sell_tax ?? '').trim() === '' ? null : num(row.sell_tax) * 100;
  const dangerous = {
    cannotBuy: boolFlag(row.cannot_buy),
    cannotSellAll: boolFlag(row.cannot_sell_all),
    transferPausable: boolFlag(row.transfer_pausable),
    hiddenOwner: boolFlag(row.hidden_owner),
    ownerChangeBalance: boolFlag(row.owner_change_balance),
    canTakeBackOwnership: boolFlag(row.can_take_back_ownership),
    selfDestruct: boolFlag(row.selfdestruct),
    blacklist: boolFlag(row.is_blacklisted),
    mintable: boolFlag(row.is_mintable)
  };
  const riskFlag = Object.values(dangerous).some(Boolean);
  const securityVerified = boolFlag(row.is_open_source)
    && falseFlag(row.is_honeypot)
    && falseFlag(row.is_in_dex) === false
    && String(row.is_in_dex ?? '') === '1'
    && sellTax !== null
    && sellTax <= 10
    && (buyTax === null || buyTax <= 10)
    && !riskFlag;

  return {
    securityVerified,
    securitySource: 'goplus',
    isOpenSource: boolFlag(row.is_open_source),
    honeypot: boolFlag(row.is_honeypot),
    isInDex: boolFlag(row.is_in_dex),
    buyTaxPct: buyTax,
    sellTaxPct: sellTax,
    top10HolderPct: holderPercent(row),
    creatorPct: num(row.creator_percent) * 100,
    holderCount: num(row.holder_count),
    isProxy: boolFlag(row.is_proxy),
    ...dangerous
  };
}

async function fetchSecurityBatch(network, addresses, timeoutMs = 9000) {
  const unique = [...new Set(addresses.map((address) => lower(address)).filter((address) => EVM_ADDRESS.test(address)))].slice(0, 30);
  if (!unique.length) return new Map();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const query = encodeURIComponent(unique.join(','));
    const response = await fetch(`${GOPLUS_API}/${encodeURIComponent(network.chainId)}?contract_addresses=${query}`, {
      signal: controller.signal,
      headers: { accept: 'application/json' }
    });
    if (!response.ok) throw new Error(`GoPlus ${network.key} HTTP ${response.status}`);
    const payload = await response.json();
    if (Number(payload?.code) !== 1 || !payload?.result) throw new Error(`GoPlus ${network.key} invalid response`);
    const out = new Map();
    for (const [address, row] of Object.entries(payload.result)) out.set(lower(address), securitySnapshot(row));
    return out;
  } finally {
    clearTimeout(timer);
  }
}

function isRisingMomentum(snapshot) {
  const buys = num(snapshot.buys30s);
  const sells = num(snapshot.sells30s);
  const ratio = buys / Math.max(1, sells);
  const price5 = num(snapshot.priceChange5mPct);
  const volume5 = num(snapshot.volume5mUsd);
  const buyerAcceleration = num(snapshot.buyerAcceleration);
  const volumeAcceleration = num(snapshot.volumeAcceleration);
  if (price5 >= 5) return true;
  if (ratio >= 1.8 && buys >= 4 && volume5 >= 2_000) return true;
  return buyerAcceleration >= 1.5 && volumeAcceleration >= 1.5 && ratio >= 1.25;
}

function evaluateEvmSafety(snapshot, scores) {
  const reasons = [];
  const trades = num(snapshot.buys30s) + num(snapshot.sells30s);
  if (!(num(snapshot.priceUsd) > 0)) reasons.push('price unavailable');
  if (snapshot.marketDataVerified !== true) reasons.push('market data not verified');
  if (snapshot.securityVerified !== true) reasons.push('GoPlus security not verified');
  if (!(trades >= 5 || num(snapshot.volume5mUsd) >= 1000)) reasons.push('insufficient verified trading activity');
  if (!(num(snapshot.sells30s) >= 1)) reasons.push('no verified sell observed');
  if (snapshot.honeypot === true) reasons.push('honeypot');
  if (snapshot.cannotSellAll === true) reasons.push('cannot sell all');
  if (snapshot.cannotBuy === true) reasons.push('cannot buy');
  if (snapshot.transferPausable === true) reasons.push('transfer can be paused');
  if (snapshot.hiddenOwner === true) reasons.push('hidden owner');
  if (snapshot.ownerChangeBalance === true) reasons.push('owner can change balances');
  if (snapshot.canTakeBackOwnership === true) reasons.push('ownership can be reclaimed');
  if (snapshot.selfDestruct === true) reasons.push('self-destruct capability');
  if (snapshot.blacklist === true) reasons.push('blacklist risk');
  if (snapshot.mintable === true) reasons.push('mintable token');
  if (num(snapshot.sellTaxPct) > 10) reasons.push(`sell tax ${num(snapshot.sellTaxPct).toFixed(1)}%`);
  if (snapshot.buyTaxPct !== null && num(snapshot.buyTaxPct) > 10) reasons.push(`buy tax ${num(snapshot.buyTaxPct).toFixed(1)}%`);
  if (num(snapshot.top10HolderPct) > 40) reasons.push(`top-10 concentration ${num(snapshot.top10HolderPct).toFixed(1)}%`);
  if (num(snapshot.creatorPct) > 8) reasons.push(`creator concentration ${num(snapshot.creatorPct).toFixed(1)}%`);
  if (num(snapshot.liquidityUsd) < 5000) reasons.push(`liquidity too low $${num(snapshot.liquidityUsd).toFixed(0)}`);
  if (num(scores?.risk, 100) > 35) reasons.push(`risk score ${num(scores.risk)}/100`);
  return { ok: reasons.length === 0, reasons };
}

function networkFor(key) {
  return NETWORKS.find((item) => item.key === key);
}

function keyboard(snapshot) {
  const network = networkFor(snapshot.chain);
  if (!network) return undefined;
  const address = snapshot.address;
  return {
    inline_keyboard: [
      [
        { text: '📋 CA', copy_text: { text: address } },
        { text: '📊 DEX', url: `https://dexscreener.com/${network.key}/${address}` }
      ],
      [
        { text: '🦎 GeckoTerminal', url: `https://www.geckoterminal.com/${network.key}/tokens/${address}` },
        { text: '🔎 Explorer', url: `${network.explorer}${address}` }
      ]
    ]
  };
}

function messageText(snapshot, scores, language = 'ar') {
  const network = networkFor(snapshot.chain);
  const buys = num(snapshot.buys30s);
  const sells = num(snapshot.sells30s);
  const ratio = buys / Math.max(1, sells);
  const venue = String(snapshot.source ?? '').split(':').at(-1) || 'DEX';
  const ar = [
    `🔥 SUMMECA TRENDING — إشارة ${network?.labelAr ?? snapshot.chain}`,
    '',
    `$${String(snapshot.symbol ?? 'TOKEN').replace(/^\$/, '')} • ${snapshot.name ?? 'Token'}`,
    `🌐 الشبكة: ${network?.labelAr ?? snapshot.chain}  |  📍 ${venue}`,
    `CA: ${snapshot.address}`,
    '',
    `MC: $${money(snapshot.marketCapUsd)}  |  Vol 5m: $${money(snapshot.volume5mUsd)}`,
    `💧 Liquidity: $${money(snapshot.liquidityUsd)}  |  💵 Price: $${priceLabel(snapshot.priceUsd)}`,
    `🟢 Buy 30s: ${buys.toFixed(1)}  |  🔴 Sell: ${sells.toFixed(1)}  |  Ratio ${ratio.toFixed(2)}x`,
    `📈 5m: ${num(snapshot.priceChange5mPct).toFixed(1)}%  |  Holders: ${Math.round(num(snapshot.holderCount)) || '—'}`,
    '',
    `⚡ Entry ${scores.entry}/100  |  🚀 Moon ${scores.moon}/100  |  🛡️ Risk ${scores.risk}/100`,
    `🔐 GoPlus: ناجح  |  Buy tax: ${snapshot.buyTaxPct === null ? '—' : `${num(snapshot.buyTaxPct).toFixed(1)}%`}  |  Sell tax: ${snapshot.sellTaxPct === null ? '—' : `${num(snapshot.sellTaxPct).toFixed(1)}%`}`,
    `👥 Top10: ${num(snapshot.top10HolderPct).toFixed(1)}%  |  Creator: ${num(snapshot.creatorPct).toFixed(1)}%`,
    '',
    '✅ اجتازت فحص السوق + الزخم + أمان العقد.',
    '⚠️ هذه إشارة رصد وليست ضمانًا للربح. التداول الآلي الحقيقي على هذه الشبكة غير مفعّل.'
  ].join('\n');
  const en = [
    `🔥 SUMMECA TRENDING — ${network?.labelEn ?? snapshot.chain} SIGNAL`,
    '',
    `$${String(snapshot.symbol ?? 'TOKEN').replace(/^\$/, '')} • ${snapshot.name ?? 'Token'}`,
    `🌐 Network: ${network?.labelEn ?? snapshot.chain}  |  📍 ${venue}`,
    `CA: ${snapshot.address}`,
    '',
    `MC: $${money(snapshot.marketCapUsd)}  |  Vol 5m: $${money(snapshot.volume5mUsd)}`,
    `💧 Liquidity: $${money(snapshot.liquidityUsd)}  |  💵 Price: $${priceLabel(snapshot.priceUsd)}`,
    `🟢 Buys 30s: ${buys.toFixed(1)}  |  🔴 Sells: ${sells.toFixed(1)}  |  Ratio ${ratio.toFixed(2)}x`,
    `📈 5m: ${num(snapshot.priceChange5mPct).toFixed(1)}%  |  Holders: ${Math.round(num(snapshot.holderCount)) || '—'}`,
    '',
    `⚡ Entry ${scores.entry}/100  |  🚀 Moon ${scores.moon}/100  |  🛡️ Risk ${scores.risk}/100`,
    `🔐 GoPlus: PASSED  |  Buy tax: ${snapshot.buyTaxPct === null ? '—' : `${num(snapshot.buyTaxPct).toFixed(1)}%`}  |  Sell tax: ${snapshot.sellTaxPct === null ? '—' : `${num(snapshot.sellTaxPct).toFixed(1)}%`}`,
    `👥 Top10: ${num(snapshot.top10HolderPct).toFixed(1)}%  |  Creator: ${num(snapshot.creatorPct).toFixed(1)}%`,
    '',
    '✅ Market + momentum + contract-security gates passed.',
    '⚠️ Monitoring signal only; profit is not guaranteed. Autonomous live execution is not enabled on this network.'
  ].join('\n');
  if (language === 'en') return en;
  if (language === 'bilingual') return `${ar}\n\n────────────\n\n${en}`;
  return ar;
}

async function sendSignal(token, chatId, language, snapshot, scores) {
  const body = {
    chat_id: chatId,
    text: messageText(snapshot, scores, language),
    reply_markup: keyboard(snapshot)
  };
  if (snapshot.imageUrl) {
    try {
      const result = await telegramApi(token, 'sendPhoto', {
        chat_id: chatId,
        photo: snapshot.imageUrl,
        caption: body.text.slice(0, 1024),
        reply_markup: body.reply_markup
      });
      return result;
    } catch (error) {
      console.warn(`[evm-radar:photo] ${snapshot.chain} ${error.message}`);
    }
  }
  return telegramApi(token, 'sendMessage', body);
}

async function sendMilestone(token, chatId, language, snapshot, state, milestone) {
  const current = num(snapshot.priceUsd);
  const returnPct = state.referencePriceUsd > 0 ? ((current / state.referencePriceUsd) - 1) * 100 : 0;
  state.peakReturnPct = Math.max(state.peakReturnPct, returnPct);
  const network = networkFor(snapshot.chain);
  const ar = [
    `📈 تحديث ${network?.labelAr ?? snapshot.chain} — $${snapshot.symbol ?? 'TOKEN'}`,
    `🎯 وصل: +${milestone}%`,
    `العائد من الإشارة: ${returnPct.toFixed(1)}%  |  القمة: ${state.peakReturnPct.toFixed(1)}%`,
    `السعر: $${priceLabel(current)}`,
    `Buy/Sell 30s: ${num(snapshot.buys30s).toFixed(1)} / ${num(snapshot.sells30s).toFixed(1)}`
  ].join('\n');
  const en = [
    `📈 ${network?.labelEn ?? snapshot.chain} update — $${snapshot.symbol ?? 'TOKEN'}`,
    `🎯 Reached: +${milestone}%`,
    `Return from signal: ${returnPct.toFixed(1)}%  |  Peak: ${state.peakReturnPct.toFixed(1)}%`,
    `Price: $${priceLabel(current)}`,
    `Buy/Sell 30s: ${num(snapshot.buys30s).toFixed(1)} / ${num(snapshot.sells30s).toFixed(1)}`
  ].join('\n');
  const text = language === 'en' ? en : language === 'bilingual' ? `${ar}\n\n────────────\n\n${en}` : ar;
  await telegramApi(token, 'sendMessage', {
    chat_id: chatId,
    text,
    reply_parameters: { message_id: Number(state.rootMessageId), allow_sending_without_reply: true }
  });
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
      console.warn(`[evm-radar:settings] ${error.message}`);
    }
  }
  return { chatId, language };
}

export async function startEvmRadarWorker() {
  if (!env.telegramBotToken) {
    console.log('[evm-radar] SKIPPED — Telegram bot token missing');
    return null;
  }
  const { chatId, language } = await resolveTelegramContext();
  if (!chatId) {
    console.log('[evm-radar] SKIPPED — Telegram chat is not linked yet');
    return null;
  }

  const candidates = new Map();
  const securityCache = new Map();
  const alerted = new Map();
  let running = false;

  const cycle = async () => {
    if (running) return;
    running = true;
    try {
      for (const network of NETWORKS) {
        let discovered = [];
        try {
          discovered = await fetchNewPools(network);
        } catch (error) {
          console.warn(`[evm-radar:discovery] ${network.key} ${error.message}`);
          continue;
        }

        const now = Date.now();
        for (const item of discovered) {
          const age = now - num(item.listedAt, now);
          if (age > MAX_AGE_MS) continue;
          const key = `${network.key}:${lower(item.address)}`;
          candidates.set(key, { ...candidates.get(key), ...item });
        }

        const active = [...candidates.entries()]
          .filter(([key, item]) => key.startsWith(`${network.key}:`) && now - num(item.listedAt, now) <= MAX_AGE_MS)
          .sort((a, b) => num(b[1].listedAt) - num(a[1].listedAt))
          .slice(0, MAX_TRACKED_PER_NETWORK);

        for (const [key, item] of [...candidates]) {
          if (key.startsWith(`${network.key}:`) && now - num(item.listedAt, now) > MAX_AGE_MS && !alerted.has(key)) candidates.delete(key);
        }
        if (!active.length) {
          console.log(`[evm-radar] network=${network.key} discovered=0 active=0`);
          await sleep(250);
          continue;
        }

        let markets = new Map();
        try {
          markets = await fetchMarketBatch(network, active.map(([, item]) => item));
        } catch (error) {
          console.warn(`[evm-radar:market] ${network.key} ${error.message}`);
        }

        const securityNeeded = active
          .map(([, item]) => item.address)
          .filter((address) => {
            const cached = securityCache.get(`${network.key}:${lower(address)}`);
            return !cached || now - cached.at > SECURITY_REFRESH_MS;
          });
        if (securityNeeded.length) {
          try {
            const security = await fetchSecurityBatch(network, securityNeeded);
            for (const address of securityNeeded) {
              const value = security.get(lower(address));
              if (value) securityCache.set(`${network.key}:${lower(address)}`, { at: now, value });
            }
          } catch (error) {
            console.warn(`[evm-radar:security] ${network.key} ${error.message}`);
          }
        }

        let safeCount = 0;
        let risingCount = 0;
        for (const [key, base] of active) {
          const market = markets.get(lower(base.address)) ?? base;
          const security = securityCache.get(key)?.value ?? {};
          const snapshot = { ...base, ...market, ...security, observedAt: Date.now() };
          candidates.set(key, snapshot);
          const scores = scoreToken(snapshot);
          const safety = evaluateEvmSafety(snapshot, scores);
          const rising = isRisingMomentum(snapshot);
          if (safety.ok) safeCount += 1;
          if (rising) risingCount += 1;

          const existingAlert = alerted.get(key);
          if (existingAlert && num(snapshot.priceUsd) > 0) {
            const returnPct = ((num(snapshot.priceUsd) / existingAlert.referencePriceUsd) - 1) * 100;
            existingAlert.peakReturnPct = Math.max(existingAlert.peakReturnPct, returnPct);
            const milestones = [10, 20, 30, 50, 75, 100, 150, 200, 300, 500, 1000];
            const reached = milestones.filter((value) => returnPct >= value).at(-1) ?? 0;
            if (reached > existingAlert.lastMilestone) {
              existingAlert.lastMilestone = reached;
              try { await sendMilestone(env.telegramBotToken, chatId, language, snapshot, existingAlert, reached); }
              catch (error) { console.warn(`[evm-radar:update] ${network.key} ${error.message}`); }
            }
            continue;
          }

          if (!rising || !safety.ok || scores.entry < env.entryScoreThreshold) continue;
          try {
            const message = await sendSignal(env.telegramBotToken, chatId, language, snapshot, scores);
            if (message?.message_id) {
              alerted.set(key, {
                rootMessageId: message.message_id,
                referencePriceUsd: num(snapshot.priceUsd),
                peakReturnPct: 0,
                lastMilestone: 0,
                startedAt: Date.now()
              });
              console.log(`[evm-radar:signal] network=${network.key} token=${snapshot.symbol} address=${snapshot.address} entry=${scores.entry} risk=${scores.risk}`);
            }
          } catch (error) {
            console.error(`[evm-radar:telegram] ${network.key} ${error.message}`);
          }
        }
        console.log(`[evm-radar] network=${network.key} discovered=${discovered.length} active=${active.length} safe=${safeCount} rising=${risingCount}`);
        await sleep(350);
      }
    } finally {
      running = false;
    }
  };

  await cycle();
  const timer = setInterval(() => void cycle().catch((error) => console.error('[evm-radar]', error.message)), POLL_MS);
  timer.unref?.();
  console.log('[evm-radar] READY — BNB Smart Chain + Robinhood Chain; GeckoTerminal discovery + DexScreener market + GoPlus security; signal-only, no autonomous EVM execution');
  return { stop: () => clearInterval(timer) };
}
