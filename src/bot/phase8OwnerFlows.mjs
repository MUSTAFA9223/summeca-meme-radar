import crypto from 'node:crypto';
import { env } from '../config/env.mjs';
import { AppSettings } from '../storage/appSettings.mjs';
import { telegramApi } from '../notifiers/telegram.mjs';
import { fetchPumpNativeMarket } from '../feeds/pumpFunNative.mjs';
import { manualTradeCaps } from './phase6ManualConfirm.mjs';
import {
  createPrivyTradingWallet,
  getActiveTradingWallet,
  listTradingWallets,
  setActiveTradingWallet
} from '../trading/walletRegistry.mjs';

const SOLANA = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
const WATCH_KEY = 'telegram_manual_watchlist_v1';
const COPY_KEY = 'telegram_copy_wallets_v2';
const WALLET_CREATE_REQUEST_KEY = 'telegram_wallet_create_request_v1';
const settings = new AppSettings(env.supabaseUrl, env.supabaseSecretKey);
const pendingInput = new Map();
const copyEvents = new Map();
const state = {
  started: false,
  watchRunning: false,
  copyRunning: false,
  watchCursor: 0,
  copyCursor: 0
};

const finite = (value, fallback = 0) => Number.isFinite(Number(value)) ? Number(value) : fallback;
const clamp = (value, min, max) => Math.max(min, Math.min(max, finite(value, min)));
const short = (value) => {
  const s = String(value ?? '');
  return s.length > 16 ? `${s.slice(0, 7)}…${s.slice(-5)}` : s;
};
const money = (value) => {
  const n = finite(value);
  if (Math.abs(n) >= 1_000_000) return `$${(n / 1_000_000).toFixed(2)}M`;
  if (Math.abs(n) >= 1_000) return `$${(n / 1_000).toFixed(1)}K`;
  return `$${n.toFixed(n >= 10 ? 2 : 4)}`;
};
const priceText = (value) => {
  const n = finite(value);
  if (!(n > 0)) return '—';
  return n >= 0.01 ? `$${n.toLocaleString('en-US', { maximumFractionDigits: 8 })}` : `$${n.toExponential(6)}`;
};
const pctText = (value) => {
  const n = finite(value);
  return `${n >= 0 ? '+' : ''}${n.toFixed(1)}%`;
};

function parseJson(raw, fallback = []) {
  try {
    const value = JSON.parse(String(raw || ''));
    return value ?? fallback;
  } catch {
    return fallback;
  }
}

async function loadList(key) {
  if (!settings.enabled) return [];
  const value = parseJson(await settings.get(key).catch(() => '[]'), []);
  return Array.isArray(value) ? value : [];
}

async function saveList(key, rows) {
  if (!settings.enabled) throw new Error('Supabase app_settings is required for this feature');
  await settings.set(key, JSON.stringify(Array.isArray(rows) ? rows : []));
}

async function ownerChatId() {
  if (env.telegramChatId) return String(env.telegramChatId);
  if (!settings.enabled) return '';
  return String(await settings.get('telegram_chat_id').catch(() => '') || '');
}

async function send(text, keyboard = [], extra = {}) {
  const chatId = await ownerChatId();
  if (!chatId || !env.telegramBotToken) return null;
  return telegramApi(env.telegramBotToken, 'sendMessage', {
    chat_id: chatId,
    text,
    ...extra,
    ...(Array.isArray(keyboard) && keyboard.length ? { reply_markup: { inline_keyboard: keyboard } } : {})
  });
}

async function fetchJson(url, options = {}, timeoutMs = 5_500) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, { ...options, signal: controller.signal });
    const text = await response.text().catch(() => '');
    let body = null;
    try { body = text ? JSON.parse(text) : null; } catch { body = text; }
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return body;
  } finally {
    clearTimeout(timer);
  }
}

async function marketFor(mint) {
  const rows = await fetchJson(
    `https://api.dexscreener.com/tokens/v1/solana/${encodeURIComponent(mint)}`,
    { headers: { accept: 'application/json' } },
    4_500
  ).catch(() => []);
  const pair = (Array.isArray(rows) ? rows : [])
    .sort((a, b) => finite(b?.liquidity?.usd) - finite(a?.liquidity?.usd))[0];

  if (pair) {
    const base = String(pair?.baseToken?.address ?? '');
    const token = base === mint ? pair.baseToken : pair.quoteToken;
    return {
      symbol: token?.symbol || 'TOKEN',
      name: token?.name || token?.symbol || 'Token',
      priceUsd: finite(pair?.priceUsd),
      liquidityUsd: finite(pair?.liquidity?.usd),
      marketCapUsd: finite(pair?.marketCap, finite(pair?.fdv)),
      volume5mUsd: finite(pair?.volume?.m5),
      buys5m: finite(pair?.txns?.m5?.buys),
      sells5m: finite(pair?.txns?.m5?.sells),
      priceChange5mPct: finite(pair?.priceChange?.m5),
      source: 'dexscreener',
      url: pair?.url || ''
    };
  }

  const pump = await fetchPumpNativeMarket(mint, { includeFlow: true }).catch(() => null);
  if (!pump) return null;
  return {
    symbol: pump.symbol || 'TOKEN',
    name: pump.name || pump.symbol || 'Token',
    priceUsd: finite(pump.priceUsd),
    liquidityUsd: finite(pump.liquidityUsd),
    marketCapUsd: finite(pump.marketCapUsd),
    volume5mUsd: finite(pump.volume5mUsd),
    buys5m: finite(pump.buys5m),
    sells5m: finite(pump.sells5m),
    priceChange5mPct: finite(pump.priceChange5mPct),
    source: pump.flowSource || 'pump-native',
    url: `https://pump.fun/coin/${encodeURIComponent(mint)}`
  };
}

function watchKeyboard(mint) {
  return [
    [
      { text: '🔎 تحليل', callback_data: `term:a:sol:${mint}` },
      { text: '🔐 شراء حقيقي', callback_data: `p6:b:sol:${mint}` }
    ],
    [
      { text: '⏹ إيقاف المتابعة', callback_data: `p8:woff:${mint}` },
      { text: '📋 نسخ العقد', copy_text: { text: mint } }
    ]
  ];
}

export async function addManualWatch({ mint, rootMessageId, chatId = null }) {
  const address = String(mint || '').trim();
  if (!SOLANA.test(address)) throw new Error('Invalid Solana mint');
  if (!settings.enabled) throw new Error('Watchlist storage is unavailable');
  const market = await marketFor(address).catch(() => null);
  const rows = await loadList(WATCH_KEY);
  const existing = rows.find((row) => row.mint === address);
  const next = {
    mint: address,
    rootMessageId: Number(rootMessageId || existing?.rootMessageId || 0),
    chatId: String(chatId || existing?.chatId || await ownerChatId()),
    symbol: market?.symbol || existing?.symbol || 'TOKEN',
    referencePriceUsd: market?.priceUsd || existing?.referencePriceUsd || null,
    peakPriceUsd: market?.priceUsd || existing?.peakPriceUsd || null,
    lastReturnPct: 0,
    lastMilestone: 0,
    lastSentAt: Date.now(),
    addedAt: existing?.addedAt || new Date().toISOString(),
    active: true
  };
  const filtered = rows.filter((row) => row.mint !== address);
  filtered.unshift(next);
  await saveList(WATCH_KEY, filtered.slice(0, 50));
  return { row: next, market };
}

async function removeManualWatch(mint) {
  const rows = await loadList(WATCH_KEY);
  const next = rows.map((row) => row.mint === mint ? { ...row, active: false, stoppedAt: new Date().toISOString() } : row);
  await saveList(WATCH_KEY, next);
  return next.find((row) => row.mint === mint) || null;
}

async function watchDashboard() {
  const rows = (await loadList(WATCH_KEY)).filter((row) => row.active);
  const lines = ['👀 قائمة متابعة العملات', ''];
  if (!rows.length) lines.push('لا توجد عملات تحت المتابعة الآن.');
  for (const row of rows.slice(0, 12)) {
    lines.push(`• $${row.symbol || 'TOKEN'} • ${short(row.mint)} • ${pctText(row.lastReturnPct)}`);
  }
  lines.push('', 'كل تحديث جديد يصل كرد على رسالة العملة الأصلية.');
  return {
    text: lines.join('\n'),
    keyboard: rows.slice(0, 6).map((row) => [
      { text: `⏹ $${row.symbol || 'TOKEN'}`, callback_data: `p8:woff:${row.mint}` },
      { text: '🔎', callback_data: `term:a:sol:${row.mint}` }
    ])
  };
}

function milestoneFor(returnPct) {
  const marks = [10, 20, 30, 50, 75, 100, 150, 200, 300, 500, 1000];
  let hit = 0;
  for (const mark of marks) if (returnPct >= mark) hit = mark;
  return hit;
}

async function watchCycle() {
  if (state.watchRunning || !settings.enabled) return;
  state.watchRunning = true;
  try {
    const rows = await loadList(WATCH_KEY);
    const active = rows.filter((row) => row.active && SOLANA.test(String(row.mint || '')));
    if (!active.length) return;
    const perCycle = Math.max(1, Math.min(4, finite(process.env.WATCH_TOKENS_PER_CYCLE, 2)));
    const picked = [];
    for (let i = 0; i < Math.min(perCycle, active.length); i += 1) {
      picked.push(active[(state.watchCursor + i) % active.length]);
    }
    state.watchCursor = (state.watchCursor + picked.length) % active.length;

    let changed = false;
    const periodicMs = clamp(process.env.WATCH_PERIODIC_UPDATE_MS ?? 90_000, 30_000, 10 * 60_000);
    for (const row of picked) {
      const market = await marketFor(row.mint).catch(() => null);
      if (!market?.priceUsd) continue;
      if (!(finite(row.referencePriceUsd) > 0)) row.referencePriceUsd = market.priceUsd;
      const ret = ((market.priceUsd / row.referencePriceUsd) - 1) * 100;
      row.peakPriceUsd = Math.max(finite(row.peakPriceUsd), market.priceUsd);
      row.lastReturnPct = ret;
      row.symbol = market.symbol || row.symbol;
      const milestone = milestoneFor(ret);
      const milestoneNew = milestone > finite(row.lastMilestone);
      const periodic = Date.now() - finite(row.lastSentAt) >= periodicMs;
      changed = true;

      if ((milestoneNew || periodic) && row.rootMessageId) {
        const kind = milestoneNew ? `🚀 تجاوز +${milestone}%` : '📍 تحديث متابعة';
        const ratio = market.buys5m / Math.max(1, market.sells5m);
        await send([
          `${kind} — $${row.symbol || 'TOKEN'}`,
          '',
          `من بداية المتابعة: ${pctText(ret)}`,
          `السعر: ${priceText(market.priceUsd)}`,
          `القيمة السوقية: ${money(market.marketCapUsd)} • السيولة: ${money(market.liquidityUsd)}`,
          `5 دقائق: شراء ${market.buys5m} / بيع ${market.sells5m} • النسبة ${ratio.toFixed(2)}x`,
          `حجم 5 دقائق: ${money(market.volume5mUsd)} • الحركة: ${pctText(market.priceChange5mPct)}`,
          '',
          '↩️ هذا التحديث مرتبط برسالة العملة الأصلية.'
        ].join('\n'), watchKeyboard(row.mint), {
          reply_parameters: {
            message_id: Number(row.rootMessageId),
            allow_sending_without_reply: true
          }
        }).catch(() => {});
        if (milestoneNew) row.lastMilestone = milestone;
        row.lastSentAt = Date.now();
      }
    }
    if (changed) await saveList(WATCH_KEY, rows);
  } finally {
    state.watchRunning = false;
  }
}

function rpcEndpoints() {
  return [
    env.heliusApiKey ? `https://mainnet.helius-rpc.com/?api-key=${encodeURIComponent(env.heliusApiKey)}` : '',
    'https://solana-rpc.publicnode.com',
    'https://api.mainnet-beta.solana.com'
  ].filter(Boolean);
}

async function solanaRpc(method, params = []) {
  let last = null;
  for (const endpoint of rpcEndpoints()) {
    try {
      const body = await fetchJson(endpoint, {
        method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: `p8-${Date.now()}`, method, params })
      }, 6_500);
      if (body?.error) throw new Error(body.error.message || `RPC ${body.error.code}`);
      return body?.result;
    } catch (error) {
      last = error;
    }
  }
  throw last || new Error(`Solana RPC ${method} failed`);
}

function accountKeyText(entry) {
  if (typeof entry === 'string') return entry;
  return String(entry?.pubkey || entry?.address || '');
}

function atomicTokenMap(rows, ownerAddress) {
  const map = new Map();
  for (const row of Array.isArray(rows) ? rows : []) {
    if (String(row?.owner || '') !== ownerAddress) continue;
    const mint = String(row?.mint || '');
    const amount = String(row?.uiTokenAmount?.amount ?? '0');
    if (!mint || !/^\d+$/.test(amount)) continue;
    map.set(mint, BigInt(amount));
  }
  return map;
}

export function parseSolanaCopyTrade(tx, walletAddress) {
  const wallet = String(walletAddress || '');
  if (!tx?.transaction?.message || !SOLANA.test(wallet)) return null;
  const keys = (tx.transaction.message.accountKeys || []).map(accountKeyText);
  const walletIndex = keys.indexOf(wallet);
  if (walletIndex < 0) return null;
  const preBalances = Array.isArray(tx?.meta?.preBalances) ? tx.meta.preBalances : [];
  const postBalances = Array.isArray(tx?.meta?.postBalances) ? tx.meta.postBalances : [];
  const solDeltaLamports = BigInt(Math.trunc(finite(postBalances[walletIndex]) - finite(preBalances[walletIndex])));

  const pre = atomicTokenMap(tx?.meta?.preTokenBalances, wallet);
  const post = atomicTokenMap(tx?.meta?.postTokenBalances, wallet);
  const mints = new Set([...pre.keys(), ...post.keys()]);
  let chosen = null;
  for (const mint of mints) {
    const delta = (post.get(mint) || 0n) - (pre.get(mint) || 0n);
    if (delta === 0n) continue;
    if (!chosen || (delta < 0n ? -delta : delta) > (chosen.delta < 0n ? -chosen.delta : chosen.delta)) {
      chosen = { mint, delta };
    }
  }
  if (!chosen || !SOLANA.test(chosen.mint)) return null;

  const feeLamports = BigInt(Math.trunc(finite(tx?.meta?.fee)));
  if (chosen.delta > 0n && solDeltaLamports < 0n) {
    const spent = -solDeltaLamports;
    const tradeLamports = spent > feeLamports ? spent - feeLamports : 0n;
    if (tradeLamports < 500_000n) return null;
    return {
      side: 'buy',
      mint: chosen.mint,
      tokenDeltaAtomic: chosen.delta.toString(),
      sourceLamports: tradeLamports.toString(),
      solDeltaLamports: solDeltaLamports.toString()
    };
  }
  if (chosen.delta < 0n && solDeltaLamports > 0n) {
    if (solDeltaLamports < 500_000n) return null;
    return {
      side: 'sell',
      mint: chosen.mint,
      tokenDeltaAtomic: (-chosen.delta).toString(),
      sourceLamports: solDeltaLamports.toString(),
      solDeltaLamports: solDeltaLamports.toString()
    };
  }
  return null;
}

function copyFixedButtons(mint) {
  const cap = manualTradeCaps().maxBuySol;
  const values = [...new Set([0.005, 0.01, 0.025, 0.05, cap]
    .filter((v) => v >= 0.001 && v <= cap)
    .map((v) => Number(v.toFixed(4))))];
  return values.slice(0, 4).map((value) => ({
    text: `${value} SOL`,
    callback_data: `p8f:${Math.round(value * 1000)}:${mint}`
  }));
}

function rememberCopyEvent(event) {
  const id = crypto.randomBytes(5).toString('hex');
  copyEvents.set(id, { ...event, expiresAt: Date.now() + 30 * 60_000 });
  if (copyEvents.size > 100) {
    const oldest = [...copyEvents.entries()].sort((a, b) => a[1].expiresAt - b[1].expiresAt).slice(0, 20);
    for (const [key] of oldest) copyEvents.delete(key);
  }
  return id;
}

async function addCopyWallet(address, label = '') {
  const wallet = String(address || '').trim();
  if (!SOLANA.test(wallet)) throw new Error('عنوان محفظة Solana غير صالح');
  const rows = await loadList(COPY_KEY);
  if (rows.some((row) => row.address === wallet)) return rows.find((row) => row.address === wallet);

  const latest = await solanaRpc('getSignaturesForAddress', [wallet, { limit: 1 }]).catch(() => []);
  const record = {
    address: wallet,
    label: String(label || `Trader ${rows.length + 1}`).slice(0, 50),
    enabled: true,
    lastSignature: latest?.[0]?.signature || null,
    addedAt: new Date().toISOString(),
    lastEventAt: null
  };
  rows.unshift(record);
  await saveList(COPY_KEY, rows.slice(0, 30));
  return record;
}

async function copyDashboard() {
  const rows = await loadList(COPY_KEY);
  const active = rows.filter((row) => row.enabled);
  const lines = [
    '🧠 COPY TRADING — محافظ المتداولين',
    '',
    `المضافة: ${rows.length} • النشطة: ${active.length}`,
    'يمكنك إضافة أي محفظة Solana متحركة من داخل البوت؛ لا تحتاج وضعها في Secrets أو Railway.',
    ''
  ];
  if (!rows.length) lines.push('لا توجد محافظ بعد. اضغط «إضافة محفظة» ثم أرسل العنوان.');
  rows.slice(0, 10).forEach((row, i) => {
    lines.push(`${row.enabled ? '🟢' : '⚪'} ${i + 1}. ${row.label || 'Trader'} • ${short(row.address)}`);
  });
  lines.push('', 'عند اكتشاف شراء/بيع سترى أزرار مبلغ ثابت أو نسبة من صفقة المتداول. التنفيذ الحقيقي يمر دائمًا بـ التأكيد اليدوي.');
  const keyboard = [[{ text: '➕ إضافة محفظة', callback_data: 'p8:cadd' }, { text: '🔄 تحديث', callback_data: 'p8:copy' }]];
  rows.slice(0, 8).forEach((row, i) => keyboard.push([
    { text: `${row.enabled ? '⏸' : '▶️'} ${row.label || `Trader ${i + 1}`}`, callback_data: `p8:ctoggle:${i}` },
    { text: '🗑 حذف', callback_data: `p8:cdel:${i}` }
  ]));
  return { text: lines.join('\n'), keyboard };
}

async function walletBalanceSol(address) {
  if (!SOLANA.test(String(address || ''))) return 0;
  const result = await solanaRpc('getBalance', [address, { commitment: 'processed' }]).catch(() => null);
  return finite(result?.value) / 1e9;
}

async function tradingWalletDashboard() {
  const wallets = await listTradingWallets();
  const active = await getActiveTradingWallet();
  const lines = ['👛 محافظ التداول في SUMMECA', ''];
  if (!wallets.length) lines.push('لا توجد محفظة تداول مهيأة.');
  for (let i = 0; i < wallets.length; i += 1) {
    const row = wallets[i];
    const balance = i < 4 ? await walletBalanceSol(row.address) : null;
    lines.push(`${row.id === active?.id ? '🟢' : '⚪'} ${i + 1}. ${row.label} • ${short(row.address)}${balance != null ? ` • ${balance.toFixed(4)} SOL` : ''}`);
  }
  lines.push('', 'يمكنك إنشاء محفظة Solana داخل البوت عبر Privy ثم إرسال SOL أو العملات إليها. المفتاح الخاص لا يُعرض في تيليجرام ولا يُحفظ في Supabase.');
  if (active) {
    lines.push('', `المحفظة النشطة: ${active.label}`, `العنوان: ${active.address}`);
  }
  const keyboard = [
    [{ text: '➕ إنشاء محفظة', callback_data: 'p8:wcreate' }, { text: '🔄 تحديث', callback_data: 'p8:wallets' }]
  ];
  wallets.slice(0, 8).forEach((row, i) => keyboard.push([
    { text: row.id === active?.id ? `✅ ${row.label}` : `اختيار ${row.label}`, callback_data: `p8:wsel:${i}` },
    { text: '📋 نسخ العنوان', copy_text: { text: row.address } }
  ]));
  return { text: lines.join('\n'), keyboard };
}

async function processWalletCreateRequest() {
  if (!settings.enabled) return null;
  const raw = await settings.get(WALLET_CREATE_REQUEST_KEY).catch(() => '');
  const request = parseJson(raw, null);
  if (!request || typeof request !== 'object' || request.status !== 'pending' || !request.id) return null;

  const processing = {
    ...request,
    status: 'processing',
    processingAt: new Date().toISOString()
  };
  await settings.set(WALLET_CREATE_REQUEST_KEY, JSON.stringify(processing));

  try {
    const wallets = await listTradingWallets();
    const label = String(request.label || `محفظة تداول ${wallets.length + 1}`).slice(0, 80);
    const wallet = await createPrivyTradingWallet({ label });
    const completed = {
      ...processing,
      status: 'completed',
      completedAt: new Date().toISOString(),
      walletId: wallet.id,
      walletAddress: wallet.address,
      walletLabel: wallet.label
    };
    await settings.set(WALLET_CREATE_REQUEST_KEY, JSON.stringify(completed));
    await send([
      '✅ تم إنشاء محفظة التداول الجديدة',
      '',
      `الاسم: ${wallet.label}`,
      `العنوان: ${wallet.address}`,
      '',
      'أصبحت هذه المحفظة هي المحفظة النشطة داخل البوت.',
      'يمكنك الآن إرسال SOL أو العملات إلى هذا العنوان، ثم استخدام أزرار الشراء والبيع من داخل SUMMECA.',
      '',
      '🔐 لا يتم عرض المفتاح الخاص أو عبارة الاسترداد داخل تيليجرام أو Supabase.'
    ].join('\n'), [
      [{ text: '📋 نسخ عنوان المحفظة', copy_text: { text: wallet.address } }],
      [{ text: '👛 فتح محافظي', callback_data: 'p8:wallets' }]
    ]).catch(() => {});
    return wallet;
  } catch (error) {
    const failed = {
      ...processing,
      status: 'failed',
      failedAt: new Date().toISOString(),
      error: String(error?.message ?? error).slice(0, 220)
    };
    await settings.set(WALLET_CREATE_REQUEST_KEY, JSON.stringify(failed)).catch(() => {});
    await send('❌ تعذر إنشاء محفظة التداول الجديدة. لم يتم تغيير أي محفظة أو مفتاح.').catch(() => {});
    throw error;
  }
}

async function copyCycle() {
  if (state.copyRunning || !settings.enabled) return;
  state.copyRunning = true;
  try {
    const rows = await loadList(COPY_KEY);
    const enabled = rows.filter((row) => row.enabled && SOLANA.test(String(row.address || '')));
    if (!enabled.length) return;
    const perCycle = Math.max(1, Math.min(5, finite(process.env.COPY_WALLETS_PER_CYCLE, 2)));
    const picked = [];
    for (let i = 0; i < Math.min(perCycle, enabled.length); i += 1) {
      picked.push(enabled[(state.copyCursor + i) % enabled.length]);
    }
    state.copyCursor = (state.copyCursor + picked.length) % enabled.length;
    let changed = false;

    for (const row of picked) {
      const sigRows = await solanaRpc('getSignaturesForAddress', [row.address, { limit: 8 }]).catch(() => []);
      if (!Array.isArray(sigRows) || !sigRows.length) continue;
      if (!row.lastSignature) {
        row.lastSignature = sigRows[0].signature;
        changed = true;
        continue;
      }
      const fresh = [];
      for (const sig of sigRows) {
        if (sig.signature === row.lastSignature) break;
        if (!sig.err) fresh.push(sig);
      }
      row.lastSignature = sigRows[0].signature;
      changed = true;
      for (const sig of fresh.reverse().slice(-3)) {
        const tx = await solanaRpc('getTransaction', [
          sig.signature,
          { encoding: 'jsonParsed', maxSupportedTransactionVersion: 0, commitment: 'confirmed' }
        ]).catch(() => null);
        const trade = parseSolanaCopyTrade(tx, row.address);
        if (!trade) continue;
        row.lastEventAt = new Date().toISOString();
        const sourceSol = Number(BigInt(trade.sourceLamports || '0')) / 1e9;
        const eventId = rememberCopyEvent({
          ...trade,
          sourceWallet: row.address,
          sourceLabel: row.label,
          signature: sig.signature,
          sourceSol
        });

        if (trade.side === 'buy') {
          await send([
            '🧠 إشارة نسخ — تم رصد شراء',
            '',
            `${row.label} • ${short(row.address)}`,
            `العملة: ${short(trade.mint)}`,
            `حجم صفقة المصدر ≈ ${sourceSol.toFixed(4)} SOL`,
            '',
            'اختر مبلغًا ثابتًا أو نسبة من حجم صفقة المصدر.',
            '⚠️ لن يتم التنفيذ مباشرة؛ ستفتح شاشة Quote ثم التأكيد اليدوي.'
          ].join('\n'), [
            copyFixedButtons(trade.mint),
            [25, 50, 100].map((p) => ({ text: `${p}% من المصدر`, callback_data: `p8p:${p}:${eventId}` })),
            [
              { text: '🔎 تحليل', callback_data: `term:a:sol:${trade.mint}` },
              { text: '🔗 Solscan', url: `https://solscan.io/tx/${encodeURIComponent(sig.signature)}` }
            ]
          ]).catch(() => {});
        } else {
          await send([
            '🧠 إشارة نسخ — تم رصد بيع',
            '',
            `${row.label} • ${short(row.address)}`,
            `العملة: ${short(trade.mint)}`,
            `ما استلمه المصدر ≈ ${sourceSol.toFixed(4)} SOL`,
            '',
            'إذا كنت تملك نفس العملة في محفظة SUMMECA، اختر نسبة البيع.',
            '⚠️ ستظهر شاشة Quote والتأكيد اليدوي قبل أي تنفيذ.'
          ].join('\n'), [
            [25, 50, 100].map((p) => ({ text: `Sell ${p}%`, callback_data: `p8s:${p}:${trade.mint}` })),
            [
              { text: '🔎 تحليل', callback_data: `term:a:sol:${trade.mint}` },
              { text: '🔗 Solscan', url: `https://solscan.io/tx/${encodeURIComponent(sig.signature)}` }
            ]
          ]).catch(() => {});
        }
      }
    }
    if (changed) await saveList(COPY_KEY, rows);
  } finally {
    state.copyRunning = false;
  }
}

function result(text, keyboard = []) {
  return { handled: true, text, keyboard };
}

export async function handlePhase8Callback(callback, terminal) {
  const data = String(callback?.data || '');
  const message = callback?.message;
  const chatId = String(message?.chat?.id || '');
  if (data.startsWith('watch:add:')) {
    const mint = data.slice('watch:add:'.length);
    const added = await addManualWatch({ mint, rootMessageId: message?.message_id, chatId });
    return result([
      `👀 تمت إضافة $${added.market?.symbol || 'TOKEN'} للمتابعة`,
      '',
      `Reference: ${priceText(added.market?.priceUsd)}`,
      'من الآن كل milestone/تحديث مهم سيصل كـ Reply تحت رسالة العملة نفسها.'
    ].join('\n'), watchKeyboard(mint));
  }
  if (data === 'p8:watch') return { handled: true, ...(await watchDashboard()) };
  if (data.startsWith('p8:woff:')) {
    const mint = data.slice('p8:woff:'.length);
    await removeManualWatch(mint);
    return result(`⏹ تم إيقاف متابعة ${short(mint)}.`, [[{ text: '👀 Watchlist', callback_data: 'p8:watch' }]]);
  }
  if (data === 'p8:copy') return { handled: true, ...(await copyDashboard()) };
  if (data === 'p8:cadd') {
    pendingInput.set(chatId, { type: 'copy-wallet', expiresAt: Date.now() + 5 * 60_000 });
    return result('➕ أرسل الآن عنوان محفظة Solana للمتداول الذي تريد متابعته ونسخ إشاراته.\n\nلن نطلب private key أو seed phrase.');
  }
  if (data.startsWith('p8:ctoggle:')) {
    const index = Number(data.split(':')[2]);
    const rows = await loadList(COPY_KEY);
    if (!Number.isInteger(index) || !rows[index]) return result('❌ المحفظة غير موجودة.');
    rows[index].enabled = !rows[index].enabled;
    await saveList(COPY_KEY, rows);
    return { handled: true, ...(await copyDashboard()) };
  }
  if (data.startsWith('p8:cdel:')) {
    const index = Number(data.split(':')[2]);
    const rows = await loadList(COPY_KEY);
    if (!Number.isInteger(index) || !rows[index]) return result('❌ المحفظة غير موجودة.');
    const [removed] = rows.splice(index, 1);
    await saveList(COPY_KEY, rows);
    return result(`🗑 تم حذف ${removed?.label || 'المحفظة'} من نسخ التداول.`, [[{ text: '🧠 نسخ التداول', callback_data: 'p8:copy' }]]);
  }
  if (data === 'p8:wallets') return { handled: true, ...(await tradingWalletDashboard()) };
  if (data === 'p8:wcreate') {
    const wallets = await listTradingWallets();
    const wallet = await createPrivyTradingWallet({ label: `محفظة تداول ${wallets.length + 1}` });
    return result([
      '✅ تم إنشاء محفظة تداول Solana داخل SUMMECA',
      '',
      `${wallet.label}`,
      `العنوان: ${wallet.address}`,
      '',
      'أرسل SOL أو العملات لهذا العنوان؛ وتم تعيينها تلقائيًا كمحفظة التداول النشطة.',
      '🔐 المفتاح الخاص وعبارة الاسترداد لا يُعرضان في البوت ولا يُحفظان في Supabase.'
    ].join('\n'), [
      [{ text: '📋 نسخ العنوان', copy_text: { text: wallet.address } }],
      [{ text: '👛 المحافظ', callback_data: 'p8:wallets' }]
    ]);
  }
  if (data.startsWith('p8:wsel:')) {
    const index = Number(data.split(':')[2]);
    const wallets = await listTradingWallets();
    if (!Number.isInteger(index) || !wallets[index]) return result('❌ المحفظة غير موجودة.');
    const wallet = await setActiveTradingWallet(wallets[index].id);
    return result(`✅ المحفظة النشطة الآن:\n${wallet.label}\n${wallet.address}`, [[{ text: '👛 المحافظ', callback_data: 'p8:wallets' }]]);
  }
  if (data.startsWith('p8f:')) {
    const [, milliText, mint] = data.split(':');
    const amount = Number(milliText) / 1000;
    if (!SOLANA.test(mint) || !(amount > 0)) return result('❌ بيانات النسخ غير صالحة.');
    return terminal.handle(`p6:bp:${amount}:sol:${mint}`);
  }
  if (data.startsWith('p8p:')) {
    const [, pctRaw, eventId] = data.split(':');
    const event = copyEvents.get(eventId);
    if (!event || event.expiresAt <= Date.now() || event.side !== 'buy') return result('⌛ انتهت صلاحية إشارة النسخ. انتظر الإشارة التالية.');
    const pct = clamp(pctRaw, 1, 100);
    const amount = event.sourceSol * pct / 100;
    const cap = manualTradeCaps().maxBuySol;
    if (!(amount >= 0.001)) return result(`ℹ️ ${pct}% من صفقة المصدر أقل من 0.001 SOL. اختر مبلغًا ثابتًا.`);
    if (amount > cap) return result(`🛡️ ${pct}% = ${amount.toFixed(4)} SOL ويتجاوز حد الحماية الحالي ${cap.toFixed(4)} SOL. اختر مبلغًا ثابتًا ضمن الحد.`);
    return terminal.handle(`p6:bp:${Number(amount.toFixed(6))}:sol:${event.mint}`);
  }
  if (data.startsWith('p8s:')) {
    const [, pctRaw, mint] = data.split(':');
    const pct = Math.round(clamp(pctRaw, 1, 100));
    if (!SOLANA.test(mint) || ![25, 50, 100].includes(pct)) return result('❌ بيانات بيع بالنسخ غير صالحة.');
    return terminal.handle(`p6:sp:${pct}:sol:${mint}`);
  }
  return { handled: false };
}

export async function handlePhase8Message(message, terminal) {
  const chatId = String(message?.chat?.id || '');
  const text = String(message?.text || '').trim();
  const pending = pendingInput.get(chatId);
  if (pending && pending.expiresAt <= Date.now()) pendingInput.delete(chatId);
  if (pendingInput.get(chatId)?.type === 'copy-wallet' && !text.startsWith('/')) {
    pendingInput.delete(chatId);
    if (!SOLANA.test(text)) return result('❌ هذا ليس عنوان Solana صالحًا. اضغط إضافة محفظة وحاول مرة أخرى.');
    const row = await addCopyWallet(text);
    return result([
      '✅ تمت إضافة محفظة المتداول',
      '',
      `${row.label} • ${row.address}`,
      'بدأت المتابعة من آخر Transaction الآن؛ لن نعيد تشغيل التاريخ القديم.',
      'عند اكتشاف شراء/بيع ستظهر لك خيارات مبلغ ثابت أو نسبة.'
    ].join('\n'), [[{ text: '🧠 نسخ التداول', callback_data: 'p8:copy' }]]);
  }

  if (/^\/watch(?:@\w+)?\b/i.test(text)) return { handled: true, ...(await watchDashboard()) };
  if (/^\/(copy|copywallet)(?:@\w+)?\b/i.test(text)) return { handled: true, ...(await copyDashboard()) };
  if (/^\/wallets(?:@\w+)?\b/i.test(text)) return { handled: true, ...(await tradingWalletDashboard()) };
  return { handled: false };
}

export function installPhase8OwnerFlows() {
  if (state.started) return;
  state.started = true;
  const watchMs = clamp(process.env.WATCH_UPDATE_INTERVAL_MS ?? 20_000, 10_000, 120_000);
  const copyMs = clamp(process.env.COPY_WALLET_POLL_MS ?? 10_000, 5_000, 120_000);
  setTimeout(() => void processWalletCreateRequest().catch((error) => console.warn('[phase8:wallet-create]', error.message)), 3_000).unref?.();
  setInterval(() => void processWalletCreateRequest().catch((error) => console.warn('[phase8:wallet-create]', error.message)), 30_000).unref?.();
  setInterval(() => void watchCycle().catch((error) => console.warn('[phase8:watch]', error.message)), watchMs).unref?.();
  setInterval(() => void copyCycle().catch((error) => console.warn('[phase8:copy]', error.message)), copyMs).unref?.();
  console.log(`SUMMECA PHASE 8: متابعة + نسخ تداول + مدير محافظ Privy; watch=${watchMs}ms copy=${copyMs}ms`);
}
