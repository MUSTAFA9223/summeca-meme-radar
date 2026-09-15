import { env } from '../config/env.mjs';
import { scoreToken } from '../core/scoring.mjs';
import { telegramApi } from '../notifiers/telegram.mjs';
import { AppSettings } from '../storage/appSettings.mjs';

const GECKO = 'https://api.geckoterminal.com/api/v2';
const DEX = 'https://api.dexscreener.com';
const GOPLUS = 'https://api.gopluslabs.io/api/v1/token_security';
const EVM = /^0x[0-9a-fA-F]{40}$/;
const TRANSFER = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';
const ZERO_TOPIC = `0x${'0'.repeat(64)}`;
const POLL_MS = 15_000;
const DISCOVERY_MS = 30_000;
const DISCOVERY_429_MS = 90_000;
const RPC_DISCOVERY_MS = 12_000;
const RPC_429_MS = 45_000;
const MAX_AGE_MS = 10 * 60_000;
const TRACK_MS = 2 * 60 * 60_000;
const SECURITY_MS = 2 * 60_000;
const MAX_ACTIVE = 30;

const NETWORKS = [
  {
    key: 'bsc', chainId: '56', label: 'BNB Smart Chain', explorer: 'https://bscscan.com/token/',
    quotes: [
      '0xbb4cdb9cbd36b01bd1cbaebf2de08d9173bc095c',
      '0x55d398326f99059ff775485246999027b3197955',
      '0x8ac76a51cc950d9822d68b83fe1ad97b32cd580d',
      '0xc5f0f7b66764f6ec8c8dff7ba683102295e16409'
    ]
  },
  {
    key: 'robinhood', chainId: '4663', label: 'Robinhood Chain', explorer: 'https://robinhoodchain.blockscout.com/token/',
    rpc: 'https://rpc.mainnet.chain.robinhood.com',
    quotes: [
      '0x0bd7d308f8e1639fab988df18a8011f41eacad73',
      '0x5fc5360d0400a0fd4f2af552add042d716f1d168',
      '0x5d3a1ff2b6bab83b63cd9ad0787074081a52ef34'
    ]
  }
];

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const n = (v, fallback = 0) => Number.isFinite(Number(v)) ? Number(v) : fallback;
const low = (v) => String(v ?? '').toLowerCase();
const flag = (v) => String(v ?? '') === '1';
const noFlag = (v) => String(v ?? '') === '0';
const is429 = (e) => /HTTP 429|rate.?limit/i.test(String(e?.message ?? e));
const ageMs = (s, now = Date.now()) => Math.max(0, now - n(s?.listedAt, now));
const money = (v) => {
  const x = n(v);
  if (x >= 1e9) return `${(x / 1e9).toFixed(1)}B`;
  if (x >= 1e6) return `${(x / 1e6).toFixed(1)}M`;
  if (x >= 1e3) return `${(x / 1e3).toFixed(1)}K`;
  return x.toFixed(x >= 100 ? 0 : 2);
};
const price = (v) => n(v) > 0 ? (n(v) >= 0.01 ? n(v).toLocaleString('en-US', { maximumFractionDigits: 8 }) : n(v).toExponential(6)) : '—';
const net = (key) => NETWORKS.find((x) => x.key === key);

async function json(url, options = {}, timeoutMs = 8500) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const r = await fetch(url, { ...options, signal: controller.signal });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    return await r.json();
  } finally { clearTimeout(timer); }
}

function relationAddress(id) {
  const value = String(id ?? '');
  return value.match(/(0x[0-9a-fA-F]{40})$/)?.[1] ?? (EVM.test(value) ? value : '');
}

function tokenMap(payload) {
  const out = new Map();
  for (const item of Array.isArray(payload?.included) ? payload.included : []) {
    if (low(item?.type) !== 'token') continue;
    const a = item?.attributes ?? {};
    const address = String(a.address ?? relationAddress(item?.id));
    if (!EVM.test(address)) continue;
    out.set(String(item.id), { address, name: a.name, symbol: a.symbol, imageUrl: a.image_url });
  }
  return out;
}

function fromPool(pool, network, tokens) {
  const a = pool?.attributes ?? {};
  const baseId = pool?.relationships?.base_token?.data?.id;
  const quoteId = pool?.relationships?.quote_token?.data?.id;
  const base = tokens.get(String(baseId)) ?? { address: relationAddress(baseId) };
  const quote = tokens.get(String(quoteId)) ?? { address: relationAddress(quoteId) };
  if (!EVM.test(base.address ?? '') || !EVM.test(quote.address ?? '')) return null;
  const quotes = new Set(network.quotes.map(low));
  const token = quotes.has(low(base.address)) ? quote : base;
  if (quotes.has(low(token.address))) return null;
  const listedAt = Date.parse(a.pool_created_at ?? '') || Date.now();
  return {
    networkType: 'evm', chain: network.key, chainId: network.chainId, networkLabel: network.label,
    address: token.address, name: token.name ?? 'New token', symbol: token.symbol ?? 'NEW', imageUrl: token.imageUrl,
    source: `geckoterminal:${network.key}:${String(pool?.relationships?.dex?.data?.id ?? 'dex')}`,
    dexPairAddress: String(a.address ?? '') || undefined, listedAt, observedAt: Date.now(),
    priceUsd: 0, liquidityUsd: n(a.reserve_in_usd), marketCapUsd: n(a.market_cap_usd, n(a.fdv_usd)),
    discoverySource: 'geckoterminal-new-pools'
  };
}

async function discoverGecko(network) {
  const payload = await json(`${GECKO}/networks/${network.key}/new_pools?include=base_token,quote_token,dex&page=1`, {
    headers: { accept: 'application/json;version=20230203' }
  }).catch((e) => { throw new Error(`GeckoTerminal ${network.key} ${e.message}`); });
  const tokens = tokenMap(payload);
  return (payload?.data ?? []).map((p) => fromPool(p, network, tokens)).filter(Boolean);
}

async function rpc(endpoint, method, params) {
  const body = await json(endpoint, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 'summeca-evm-radar', method, params })
  }, 6500).catch((e) => { throw new Error(`Robinhood RPC ${method} ${e.message}`); });
  if (body?.error) throw new Error(`Robinhood RPC ${method} ${body.error.code}: ${body.error.message}`);
  return body?.result ?? null;
}

async function discoverRobinhoodMints(network, state) {
  if (!network.rpc) return [];
  const latest = Number.parseInt(String(await rpc(network.rpc, 'eth_blockNumber', []) ?? '0x0'), 16);
  if (!(latest > 0)) return [];
  const from = state.lastBlock > 0 ? state.lastBlock + 1 : Math.max(0, latest - 4);
  const to = Math.min(latest, from + 24);
  if (from > to) return [];
  const logs = await rpc(network.rpc, 'eth_getLogs', [{
    fromBlock: `0x${from.toString(16)}`, toBlock: `0x${to.toString(16)}`, topics: [TRANSFER, ZERO_TOPIC]
  }]);
  state.lastBlock = to;
  const quotes = new Set(network.quotes.map(low));
  const addresses = [...new Set((logs ?? []).map((x) => low(x?.address)).filter((x) => EVM.test(x) && !quotes.has(x)))].slice(0, 80);
  const now = Date.now();
  return addresses.map((address) => ({
    networkType: 'evm', chain: network.key, chainId: network.chainId, networkLabel: network.label,
    address, name: 'New Robinhood token', symbol: 'NEW', source: 'robinhood-rpc:mint',
    listedAt: now, observedAt: now, priceUsd: 0, liquidityUsd: 0, marketCapUsd: 0,
    discoverySource: 'robinhood-rpc-mint'
  }));
}

function bestPair(pairs, address, network) {
  const a = low(address);
  return (Array.isArray(pairs) ? pairs : [])
    .filter((p) => low(p?.chainId) === low(network) && [p?.baseToken?.address, p?.quoteToken?.address].some((x) => low(x) === a))
    .sort((x, y) => (n(y?.liquidity?.usd) * 1000 + n(y?.volume?.m5)) - (n(x?.liquidity?.usd) * 1000 + n(x?.volume?.m5)))[0] ?? null;
}

function marketSnapshot(base, pair) {
  if (!pair) return base;
  const token = low(pair?.baseToken?.address) === low(base.address) ? pair.baseToken : pair.quoteToken;
  const listedAt = n(pair?.pairCreatedAt) > 0 ? n(pair.pairCreatedAt) : n(base.listedAt, Date.now());
  const ageSec = Math.max(1, (Date.now() - listedAt) / 1000);
  const windows30 = Math.max(1, Math.max(30, Math.min(300, ageSec)) / 30);
  const m5 = pair?.txns?.m5 ?? {}, h1 = pair?.txns?.h1 ?? {};
  const buys5 = n(m5.buys), sells5 = n(m5.sells), trades5 = buys5 + sells5;
  const trades1h = n(h1.buys) + n(h1.sells);
  const vol5 = n(pair?.volume?.m5), vol1h = n(pair?.volume?.h1), vol30 = vol5 / windows30;
  const buyShare = buys5 / Math.max(1, trades5), sellShare = sells5 / Math.max(1, trades5);
  return {
    ...base, name: token?.name ?? base.name, symbol: token?.symbol ?? base.symbol,
    source: `dexscreener:${base.chain}:${String(pair?.dexId ?? 'dex')}`, imageUrl: pair?.info?.imageUrl ?? base.imageUrl,
    priceUsd: n(pair?.priceUsd), liquidityUsd: n(pair?.liquidity?.usd), marketCapUsd: n(pair?.marketCap, n(pair?.fdv)),
    buys30s: buys5 / windows30, sells30s: sells5 / windows30,
    buyVolume30sUsd: vol30 * buyShare, sellVolume30sUsd: vol30 * sellShare, volume5mUsd: vol5,
    priceChange5mPct: n(pair?.priceChange?.m5), priceChange1hPct: n(pair?.priceChange?.h1),
    buyerAcceleration: ageSec >= 360 ? trades5 / Math.max(1, (trades1h - trades5) / 11) : 0,
    volumeAcceleration: ageSec >= 360 ? vol5 / Math.max(1, (vol1h - vol5) / 11) : 0,
    dexPairAddress: pair?.pairAddress ?? base.dexPairAddress, listedAt, observedAt: Date.now(),
    marketDataVerified: n(pair?.priceUsd) > 0 && (trades5 > 0 || vol5 > 0)
  };
}

async function markets(network, items) {
  const unique = [...new Map(items.map((x) => [low(x.address), x])).values()].slice(0, 30);
  if (!unique.length) return new Map();
  const pairs = await json(`${DEX}/tokens/v1/${network.key}/${unique.map((x) => x.address).join(',')}`, {
    headers: { accept: 'application/json' }
  }, 8000).catch((e) => { throw new Error(`DexScreener ${network.key} ${e.message}`); });
  return new Map(unique.map((x) => [low(x.address), marketSnapshot(x, bestPair(pairs, x.address, network.key))]));
}

function holderPct(row) {
  let total = 0;
  for (const h of (row?.holders ?? []).slice(0, 10)) {
    const ignored = h?.is_locked === '1' || /burn|dead|black hole|lp|liquidity|pair|pool/.test(low(h?.tag));
    if (!ignored) total += n(h?.percent) * 100;
  }
  return total;
}

function securityRow(row = {}) {
  const buyTax = String(row.buy_tax ?? '') === '' ? null : n(row.buy_tax) * 100;
  const sellTax = String(row.sell_tax ?? '') === '' ? null : n(row.sell_tax) * 100;
  const danger = {
    cannotBuy: flag(row.cannot_buy), cannotSellAll: flag(row.cannot_sell_all), transferPausable: flag(row.transfer_pausable),
    hiddenOwner: flag(row.hidden_owner), ownerChangeBalance: flag(row.owner_change_balance),
    canTakeBackOwnership: flag(row.can_take_back_ownership), selfDestruct: flag(row.selfdestruct),
    blacklist: flag(row.is_blacklisted), mintable: flag(row.is_mintable)
  };
  const securityVerified = flag(row.is_open_source) && noFlag(row.is_honeypot) && String(row.is_in_dex ?? '') === '1'
    && sellTax !== null && sellTax <= 10 && (buyTax === null || buyTax <= 10) && !Object.values(danger).some(Boolean);
  return {
    securityVerified, securityEvidencePresent: Object.keys(row).length > 0, securitySource: 'goplus',
    isOpenSource: flag(row.is_open_source), honeypot: flag(row.is_honeypot), isInDex: flag(row.is_in_dex),
    buyTaxPct: buyTax, sellTaxPct: sellTax, top10HolderPct: holderPct(row), creatorPct: n(row.creator_percent) * 100,
    holderCount: n(row.holder_count), isProxy: flag(row.is_proxy), ...danger
  };
}

async function security(network, addresses) {
  const unique = [...new Set(addresses.map(low).filter((x) => EVM.test(x)))].slice(0, 30);
  if (!unique.length) return new Map();
  const payload = await json(`${GOPLUS}/${network.chainId}?contract_addresses=${encodeURIComponent(unique.join(','))}`, {
    headers: { accept: 'application/json' }
  }, 9000).catch((e) => { throw new Error(`GoPlus ${network.key} ${e.message}`); });
  if (Number(payload?.code) !== 1 || !payload?.result) throw new Error(`GoPlus ${network.key} invalid response`);
  return new Map(Object.entries(payload.result).map(([address, row]) => [low(address), securityRow(row)]));
}

export function isRisingEvmMomentum(s) {
  const buys = n(s?.buys30s), sells = n(s?.sells30s), ratio = buys / Math.max(1, sells);
  if (n(s?.priceChange5mPct) >= 5) return true;
  if (ratio >= 1.8 && buys >= 4 && n(s?.volume5mUsd) >= 2000) return true;
  return n(s?.buyerAcceleration) >= 1.5 && n(s?.volumeAcceleration) >= 1.5 && ratio >= 1.25;
}

function knownDanger(s) {
  const r = [];
  if (s?.honeypot === true) r.push('honeypot');
  if (s?.cannotSellAll === true) r.push('cannot sell all');
  if (s?.cannotBuy === true) r.push('cannot buy');
  if (s?.transferPausable === true) r.push('transfer can be paused');
  if (s?.hiddenOwner === true) r.push('hidden owner');
  if (s?.ownerChangeBalance === true) r.push('owner can change balances');
  if (s?.canTakeBackOwnership === true) r.push('ownership can be reclaimed');
  if (s?.selfDestruct === true) r.push('self-destruct capability');
  if (s?.blacklist === true) r.push('blacklist risk');
  if (s?.mintable === true) r.push('mintable token');
  if (s?.sellTaxPct != null && n(s.sellTaxPct) > 10) r.push(`sell tax ${n(s.sellTaxPct).toFixed(1)}%`);
  if (s?.buyTaxPct != null && n(s.buyTaxPct) > 10) r.push(`buy tax ${n(s.buyTaxPct).toFixed(1)}%`);
  if (n(s?.top10HolderPct) > 40) r.push(`top-10 concentration ${n(s.top10HolderPct).toFixed(1)}%`);
  if (n(s?.creatorPct) > 8) r.push(`creator concentration ${n(s.creatorPct).toFixed(1)}%`);
  return r;
}

export function evaluateEvmSafety(s, scores) {
  const r = [], trades = n(s?.buys30s) + n(s?.sells30s);
  if (!(n(s?.priceUsd) > 0)) r.push('price unavailable');
  if (s?.marketDataVerified !== true) r.push('market data not verified');
  if (s?.securityVerified !== true) r.push('GoPlus security not verified');
  if (!(trades >= 5 || n(s?.volume5mUsd) >= 1000)) r.push('insufficient verified trading activity');
  if (!(n(s?.sells30s) >= 1)) r.push('no verified sell observed');
  r.push(...knownDanger(s));
  if (n(s?.liquidityUsd) < 5000) r.push(`liquidity too low $${n(s?.liquidityUsd).toFixed(0)}`);
  if (n(scores?.risk, 100) > 35) r.push(`risk score ${n(scores?.risk)}/100`);
  return { ok: r.length === 0, reasons: r };
}

export function evaluateEarlyEvmCandidate(s, scores, safety, entryThreshold = 82) {
  const r = [], trades = n(s?.buys30s) + n(s?.sells30s), threshold = Math.max(60, n(entryThreshold, 82) - 20);
  if (String(s?.chain) !== 'robinhood') r.push('Robinhood-only');
  if (s?.marketDataVerified !== true || !(n(s?.priceUsd) > 0)) r.push('market not verified');
  if (ageMs(s) > MAX_AGE_MS) r.push('launch no longer early');
  if (!isRisingEvmMomentum(s)) r.push('momentum not rising');
  if (n(s?.liquidityUsd) < 3000) r.push('liquidity below early minimum');
  if (!(trades >= 3 || n(s?.volume5mUsd) >= 1000)) r.push('insufficient early activity');
  if (n(s?.priceChange5mPct) > 80) r.push('move already overextended');
  if (n(scores?.entry) < threshold) r.push(`entry score below ${threshold}`);
  if (n(scores?.risk, 100) > 65) r.push('risk too high');
  r.push(...knownDanger(s));
  return { ok: r.length === 0 && safety?.ok !== true, threshold, reasons: r };
}

export function evaluateRunnerWatchCandidate(s, scores) {
  const r = [];
  if (String(s?.chain) !== 'robinhood') r.push('Robinhood-only');
  if (s?.marketDataVerified !== true || !(n(s?.priceUsd) > 0)) r.push('market not verified');
  if (ageMs(s) > MAX_AGE_MS) r.push('launch no longer fresh');
  if (n(s?.priceChange5mPct) < 80) r.push('not explosive');
  if (n(s?.liquidityUsd) < 5000) r.push('liquidity below runner minimum');
  if (n(s?.volume5mUsd) < 5000) r.push('volume below runner minimum');
  if (n(scores?.risk, 100) > 65) r.push('risk too high');
  r.push(...knownDanger(s));
  return { ok: r.length === 0, reasons: r };
}

function keyboard(s) {
  const network = net(s.chain), address = s.address;
  return { inline_keyboard: [
    [{ text: '📋 CA', copy_text: { text: address } }, { text: '📊 DEX', url: `https://dexscreener.com/${network.key}/${address}` }],
    [{ text: '🦎 GeckoTerminal', url: `https://www.geckoterminal.com/${network.key}/tokens/${address}` }, { text: '🔎 Explorer', url: `${network.explorer}${address}` }]
  ] };
}

function details(s, scores) {
  const buys = n(s.buys30s), sells = n(s.sells30s), ratio = buys / Math.max(1, sells);
  return [
    `$${String(s.symbol ?? 'TOKEN').replace(/^\$/, '')} • ${s.name ?? 'Token'}`,
    `CA: ${s.address}`,
    `MC: $${money(s.marketCapUsd)} | Vol 5m: $${money(s.volume5mUsd)}`,
    `💧 Liquidity: $${money(s.liquidityUsd)} | 💵 Price: $${price(s.priceUsd)}`,
    `🟢 Buy 30s: ${buys.toFixed(1)} | 🔴 Sell: ${sells.toFixed(1)} | Ratio ${ratio.toFixed(2)}x`,
    `📈 5m: ${n(s.priceChange5mPct).toFixed(1)}% | 🎯 Entry ${scores.entry}/100 | 🚀 Moon ${scores.moon}/100 | 🛡️ Risk ${scores.risk}/100`
  ];
}

function pick(language, ar, en) { return language === 'en' ? en : language === 'bilingual' ? `${ar}\n\n────────────\n\n${en}` : ar; }
function approvedText(s, sc, language) {
  return pick(language,
    [`🔥 SUMMECA TRENDING — إشارة ${net(s.chain)?.label}`, '', ...details(s, sc), '', '✅ اجتازت فحص السوق + الزخم + أمان العقد.', '⚠️ رصد فقط؛ التداول الآلي الحقيقي على هذه الشبكة غير مفعّل.'].join('\n'),
    [`🔥 SUMMECA TRENDING — ${net(s.chain)?.label} SIGNAL`, '', ...details(s, sc), '', '✅ Market + momentum + contract-security gates passed.', '⚠️ Monitoring only; autonomous live EVM execution is disabled.'].join('\n'));
}
function pendingText(s, sc, safety, language) {
  const pending = (safety?.reasons ?? []).filter((x) => !knownDanger(s).includes(x)).slice(0, 4).join(' | ') || 'contract evidence still pending';
  return pick(language,
    ['⚡ SUMMECA ROBINHOOD EARLY MOMENTUM — الأمان قيد التحقق', '', ...details(s, sc), '', '👀 تم اكتشاف الزخم مبكرًا وبدأت المتابعة.', `⚠️ الناقص: ${pending}`, '⛔ متابعة فقط — لا دخول حقيقي حتى نجاح فحص الأمان.'].join('\n'),
    ['⚡ SUMMECA ROBINHOOD EARLY MOMENTUM — SAFETY PENDING', '', ...details(s, sc), '', '👀 Early momentum detected; tracking started.', `⚠️ Pending: ${pending}`, '⛔ Tracking only — no live entry until strict safety passes.'].join('\n'));
}
function runnerText(s, sc, language) {
  return pick(language,
    ['🚀 SUMMECA ROBINHOOD RUNNER — زخم انفجاري مكتشف', '', ...details(s, sc), '', '⚠️ تم اكتشافها بعد امتداد سعري كبير بالفعل.', '⛔ ليست نقطة دخول جديدة — متابعة فقط لتجنب مطاردة الشمعة.'].join('\n'),
    ['🚀 SUMMECA EARLY MOMENTUM — ROBINHOOD RUNNER / EXPLOSIVE MOVE', '', ...details(s, sc), '', '⚠️ Detected after a large price extension.', '⛔ Not a fresh entry — tracking only; do not chase the candle.'].join('\n'));
}

async function sendRoot(token, chatId, text, s) {
  if (s.imageUrl) {
    try { return await telegramApi(token, 'sendPhoto', { chat_id: chatId, photo: s.imageUrl, caption: text.slice(0, 1024), reply_markup: keyboard(s) }); }
    catch (e) { console.warn(`[evm-radar:photo] ${s.chain} ${e.message}`); }
  }
  return telegramApi(token, 'sendMessage', { chat_id: chatId, text, reply_markup: keyboard(s) });
}

async function reply(token, chatId, rootMessageId, text) {
  return telegramApi(token, 'sendMessage', { chat_id: chatId, text, reply_parameters: { message_id: Number(rootMessageId), allow_sending_without_reply: true } });
}

async function milestone(token, chatId, language, s, state, reached) {
  const current = n(s.priceUsd), gain = state.referencePriceUsd > 0 ? ((current / state.referencePriceUsd) - 1) * 100 : 0;
  state.peakReturnPct = Math.max(state.peakReturnPct, gain);
  const arStatus = state.status === 'pending' ? '⚠️ الأمان قيد التحقق — متابعة فقط' : state.status === 'runner' ? '🚀 حركة ممتدة — لا مطاردة' : '✅ الإشارة معتمدة';
  const enStatus = state.status === 'pending' ? '⚠️ Safety pending — tracking only' : state.status === 'runner' ? '🚀 Extended move — no chase' : '✅ Approved monitoring signal';
  return reply(token, chatId, state.rootMessageId, pick(language,
    `📈 تحديث $${s.symbol ?? 'TOKEN'} — تجاوز +${reached}% • ${net(s.chain)?.label}\nالعائد: ${gain.toFixed(1)}% | القمة: ${state.peakReturnPct.toFixed(1)}%\nالسعر: $${price(current)}\n${arStatus}`,
    `📈 $${s.symbol ?? 'TOKEN'} update — crossed +${reached}% • ${net(s.chain)?.label}\nReturn: ${gain.toFixed(1)}% | Peak: ${state.peakReturnPct.toFixed(1)}%\nPrice: $${price(current)}\n${enStatus}`));
}

async function telegramContext() {
  const settings = new AppSettings(env.supabaseUrl, env.supabaseSecretKey);
  let chatId = String(env.telegramChatId ?? '').trim(), language = env.telegramLanguage;
  if (settings.enabled) {
    try {
      chatId ||= String(await settings.get('telegram_chat_id') ?? '').trim();
      const saved = low(await settings.get('telegram_language'));
      if (['ar', 'en', 'bilingual'].includes(saved)) language = saved;
    } catch (e) { console.warn(`[evm-radar:settings] ${e.message}`); }
  }
  return { chatId, language };
}

export async function startEvmRadarWorker() {
  if (!env.telegramBotToken) { console.log('[evm-radar] SKIPPED — Telegram bot token missing'); return null; }
  const { chatId, language } = await telegramContext();
  if (!chatId) { console.log('[evm-radar] SKIPPED — Telegram chat not linked'); return null; }

  const candidates = new Map(), securityCache = new Map(), alerted = new Map();
  const states = new Map(NETWORKS.map((x) => [x.key, { nextGecko: 0, nextRpc: 0, rpc: { lastBlock: 0 } }]));
  let running = false;
  const remember = (network, item) => {
    if (!EVM.test(item?.address ?? '')) return;
    const key = `${network.key}:${low(item.address)}`;
    candidates.set(key, { ...candidates.get(key), ...item });
  };

  const cycle = async () => {
    if (running) return;
    running = true;
    try {
      for (const network of NETWORKS) {
        const now = Date.now(), state = states.get(network.key);
        let geckoCount = 0, rpcCount = 0;
        if (now >= state.nextGecko) {
          try {
            const found = await discoverGecko(network); geckoCount = found.length;
            found.filter((x) => ageMs(x, now) <= MAX_AGE_MS).forEach((x) => remember(network, x));
            state.nextGecko = now + DISCOVERY_MS;
          } catch (e) {
            console.warn(`[evm-radar:discovery] ${network.key} ${e.message}; existing candidates stay active`);
            state.nextGecko = now + (is429(e) ? DISCOVERY_429_MS : DISCOVERY_MS);
          }
        }
        if (network.rpc && now >= state.nextRpc) {
          try {
            const found = await discoverRobinhoodMints(network, state.rpc); rpcCount = found.length; found.forEach((x) => remember(network, x));
            state.nextRpc = now + RPC_DISCOVERY_MS;
          } catch (e) {
            console.warn(`[evm-radar:rpc-discovery] ${network.key} ${e.message}`);
            state.nextRpc = now + (is429(e) ? RPC_429_MS : RPC_DISCOVERY_MS);
          }
        }

        for (const [key, item] of [...candidates]) {
          if (!key.startsWith(`${network.key}:`)) continue;
          const a = alerted.get(key);
          if (!a && ageMs(item, now) > MAX_AGE_MS) candidates.delete(key);
          if (a && now - a.startedAt > TRACK_MS) { alerted.delete(key); candidates.delete(key); }
        }
        const active = [...candidates.entries()]
          .filter(([key, item]) => key.startsWith(`${network.key}:`) && (alerted.has(key) ? now - alerted.get(key).startedAt <= TRACK_MS : ageMs(item, now) <= MAX_AGE_MS))
          .sort((a, b) => {
            const priority = ([key, item]) => alerted.has(key) ? 3 : (item?.marketDataVerified === true || item?.discoverySource === 'geckoterminal-new-pools' ? 2 : 1);
            return (priority(b) - priority(a)) || n(b[1].listedAt) - n(a[1].listedAt);
          })
          .slice(0, MAX_ACTIVE);
        if (!active.length) { console.log(`[evm-radar] network=${network.key} gecko=${geckoCount} rpc=${rpcCount} active=0`); continue; }

        let market = new Map();
        try { market = await markets(network, active.map(([, x]) => x)); }
        catch (e) { console.warn(`[evm-radar:market] ${network.key} ${e.message}`); }

        const securityNeeded = active.map(([, x]) => x.address).filter((address) => {
          const c = securityCache.get(`${network.key}:${low(address)}`); return !c || now - c.at > SECURITY_MS;
        });
        if (securityNeeded.length) {
          try {
            const sec = await security(network, securityNeeded);
            for (const address of securityNeeded) securityCache.set(`${network.key}:${low(address)}`, {
              at: now, value: sec.get(low(address)) ?? { securityVerified: false, securityEvidencePresent: false, securitySource: 'goplus' }
            });
          } catch (e) { console.warn(`[evm-radar:security] ${network.key} ${e.message}`); }
        }

        let safe = 0, rising = 0, early = 0, pending = 0;
        for (const [key, base] of active) {
          const s = { ...base, ...(market.get(low(base.address)) ?? {}), ...(securityCache.get(key)?.value ?? {}), observedAt: Date.now() };
          candidates.set(key, s);
          const scores = scoreToken(s), safety = evaluateEvmSafety(s, scores), isRising = isRisingEvmMomentum(s);
          const earlyGate = evaluateEarlyEvmCandidate(s, scores, safety, env.entryScoreThreshold);
          const runnerGate = evaluateRunnerWatchCandidate(s, scores);
          safe += Number(safety.ok); rising += Number(isRising); early += Number(earlyGate.ok);

          const existing = alerted.get(key);
          if (existing) {
            const danger = knownDanger(s);
            if (['pending', 'runner'].includes(existing.status) && danger.length && !existing.riskNotified) {
              existing.riskNotified = true; existing.status = 'blocked';
              await reply(env.telegramBotToken, chatId, existing.rootMessageId, pick(language,
                `🚨 طوارئ مخاطرة — $${s.symbol ?? 'TOKEN'}\nتم منع ترقية الإشارة.\n${danger.slice(0, 4).join(' | ')}`,
                `🚨 RISK EMERGENCY — $${s.symbol ?? 'TOKEN'}\nSignal upgrade blocked.\n${danger.slice(0, 4).join(' | ')}`)).catch((e) => console.warn(`[evm-radar:risk] ${e.message}`));
            }
            if (existing.status === 'pending' && safety.ok && scores.entry >= env.entryScoreThreshold) {
              await reply(env.telegramBotToken, chatId, existing.rootMessageId, pick(language,
                `✅ اكتمل فحص الأمان — $${s.symbol ?? 'TOKEN'}\nتحولت المتابعة المبكرة إلى إشارة معتمدة.\nEntry ${scores.entry}/100 | Risk ${scores.risk}/100`,
                `✅ SAFETY PASSED — $${s.symbol ?? 'TOKEN'}\nEarly watch upgraded to approved monitoring.\nEntry ${scores.entry}/100 | Risk ${scores.risk}/100`))
                .then(() => { existing.status = 'approved'; console.log(`[evm-radar:upgrade] ${network.key} ${s.address}`); })
                .catch((e) => console.warn(`[evm-radar:upgrade] ${e.message}`));
            }
            pending += Number(existing.status === 'pending');
            if (existing.status !== 'blocked' && n(s.priceUsd) > 0 && existing.referencePriceUsd > 0) {
              const gain = ((n(s.priceUsd) / existing.referencePriceUsd) - 1) * 100;
              existing.peakReturnPct = Math.max(existing.peakReturnPct, gain);
              const reached = [10, 20, 30, 50, 75, 100, 150, 200, 300, 500, 1000].filter((x) => gain >= x).at(-1) ?? 0;
              if (reached > existing.lastMilestone) {
                existing.lastMilestone = reached;
                await milestone(env.telegramBotToken, chatId, language, s, existing, reached).catch((e) => console.warn(`[evm-radar:update] ${e.message}`));
              }
            }
            continue;
          }

          let status = '', text = '';
          if (isRising && safety.ok && scores.entry >= env.entryScoreThreshold) { status = 'approved'; text = approvedText(s, scores, language); }
          else if (earlyGate.ok) { status = 'pending'; text = pendingText(s, scores, safety, language); }
          else if (runnerGate.ok) { status = 'runner'; text = runnerText(s, scores, language); }
          if (!status) continue;

          try {
            const message = await sendRoot(env.telegramBotToken, chatId, text, s);
            if (message?.message_id) {
              alerted.set(key, { status, rootMessageId: message.message_id, referencePriceUsd: n(s.priceUsd), peakReturnPct: 0, lastMilestone: 0, startedAt: Date.now(), riskNotified: false });
              pending += Number(status === 'pending');
              console.log(`[evm-radar:${status}] network=${network.key} token=${s.symbol} address=${s.address} entry=${scores.entry} risk=${scores.risk} price5=${n(s.priceChange5mPct).toFixed(1)}`);
            }
          } catch (e) { console.error(`[evm-radar:telegram-${status}] ${network.key} ${e.message}`); }
        }
        console.log(`[evm-radar] network=${network.key} gecko=${geckoCount} rpc=${rpcCount} active=${active.length} safe=${safe} rising=${rising} early=${early} pending=${pending}`);
        await sleep(250);
      }
    } finally { running = false; }
  };

  await cycle();
  const timer = setInterval(() => void cycle().catch((e) => console.error('[evm-radar]', e.message)), POLL_MS);
  timer.unref?.();
  console.log('[evm-radar] READY — BNB + Robinhood; Gecko + direct Robinhood RPC mint discovery + DexScreener + GoPlus; safety-pending early alerts + no-chase runner alerts enabled; no autonomous EVM execution');
  return { stop: () => clearInterval(timer) };
}
