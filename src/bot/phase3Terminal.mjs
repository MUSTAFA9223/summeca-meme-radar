import { env } from '../config/env.mjs';
import { AppSettings } from '../storage/appSettings.mjs';
import { telegramApi } from '../notifiers/telegram.mjs';
import { TradingTerminal, normalizeTerminalNetwork, isTerminalAddress } from './tradingTerminal.mjs';

const ORDERS_KEY = 'terminal_paper_orders_v1';
const POSITIONS_KEY = 'terminal_paper_positions_v1';
const SNIPER_PRESET_KEY = 'terminal_sniper_preset_v1';
const finite = (value, fallback = 0) => Number.isFinite(Number(value)) ? Number(value) : fallback;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, Math.max(0, ms)));
const short = (value) => { const text = String(value ?? ''); return text.length > 15 ? `${text.slice(0, 7)}…${text.slice(-5)}` : text; };
const money = (value) => { const n = finite(value); if (Math.abs(n) >= 1e6) return `$${(n / 1e6).toFixed(2)}M`; if (Math.abs(n) >= 1e3) return `$${(n / 1e3).toFixed(1)}K`; return `$${n.toFixed(2)}`; };
const priceText = (value) => { const n = finite(value); if (!(n > 0)) return '—'; return n >= 0.01 ? `$${n.toLocaleString('en-US', { maximumFractionDigits: 8 })}` : `$${n.toExponential(6)}`; };

const NETWORKS = {
  sol: { label: 'SOLANA', dex: 'solana' },
  bsc: { label: 'BNB CHAIN', dex: 'bsc' },
  arc: { label: 'ARC', dex: 'arc' },
  rh: { label: 'ROBINHOOD CHAIN', dex: 'robinhood' }
};

const SNIPER_PRESETS = {
  u: { label: '⚡ مبكر جدًا', maxMc: 500_000, minLiquidity: 3_000, minBuys: 4, maxMove: 35 },
  b: { label: '🛡️ متوازن', maxMc: 1_200_000, minLiquidity: 8_000, minBuys: 8, maxMove: 30 },
  s: { label: '💎 صارم', maxMc: 1_500_000, minLiquidity: 15_000, minBuys: 12, maxMove: 22 }
};

async function fetchJson(url, options = {}, timeoutMs = 5_000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, { ...options, signal: controller.signal });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return await response.json();
  } finally { clearTimeout(timer); }
}

async function marketFor(network, address) {
  const key = normalizeTerminalNetwork(network);
  const cfg = NETWORKS[key];
  if (!cfg || !isTerminalAddress(key, address)) return null;
  const body = await fetchJson(`https://api.dexscreener.com/tokens/v1/${encodeURIComponent(cfg.dex)}/${encodeURIComponent(address)}`, { headers: { accept: 'application/json' } }).catch(() => []);
  const rows = Array.isArray(body) ? body : [];
  const pair = rows.filter((row) => String(row?.chainId ?? '').toLowerCase() === cfg.dex)
    .sort((a, b) => finite(b?.liquidity?.usd) - finite(a?.liquidity?.usd))[0] || rows[0];
  if (!pair) return null;
  const base = String(pair?.baseToken?.address ?? '');
  const token = base.toLowerCase() === String(address).toLowerCase() ? pair.baseToken : pair.quoteToken;
  return {
    symbol: token?.symbol || 'TOKEN',
    priceUsd: finite(pair?.priceUsd),
    liquidityUsd: finite(pair?.liquidity?.usd),
    marketCapUsd: finite(pair?.marketCap, finite(pair?.fdv)),
    buys5m: finite(pair?.txns?.m5?.buys),
    sells5m: finite(pair?.txns?.m5?.sells),
    volume5mUsd: finite(pair?.volume?.m5),
    priceChange5mPct: finite(pair?.priceChange?.m5),
    url: pair?.url || ''
  };
}

async function getJsonSetting(settings, key, fallback = []) {
  if (!settings?.enabled) return fallback;
  try {
    const raw = await settings.get(key);
    const parsed = raw ? JSON.parse(String(raw)) : fallback;
    return parsed ?? fallback;
  } catch { return fallback; }
}

async function setJsonSetting(settings, key, value) {
  if (settings?.enabled) await settings.set(key, JSON.stringify(value)).catch(() => {});
}

async function sniperCode(instance) {
  if (!instance?.settings?.enabled) return 'b';
  const code = String(await instance.settings.get(SNIPER_PRESET_KEY).catch(() => '') || '').toLowerCase();
  return SNIPER_PRESETS[code] ? code : 'b';
}

async function setSniperCode(instance, code) {
  const safe = SNIPER_PRESETS[code] ? code : 'b';
  if (instance?.settings?.enabled) await instance.settings.set(SNIPER_PRESET_KEY, safe).catch(() => {});
  return safe;
}

function orderId(prefix, network, address) {
  return `${prefix}:${Date.now().toString(36)}:${network}:${String(address).toLowerCase()}`;
}

async function limitMenu(instance, network, address) {
  const key = normalizeTerminalNetwork(network);
  if (!isTerminalAddress(key, address)) return { text: '❌ عقد أو شبكة غير صالحين.', keyboard: [] };
  const market = await marketFor(key, address).catch(() => null);
  if (!market?.priceUsd) return { text: '⏳ لا يوجد سعر سوق موثوق لإنشاء أمر شراء محدد الآن.', keyboard: [[{ text: '🔎 تحليل', callback_data: `term:a:${key}:${address}` }]] };
  return {
    text: [
      `🎯 شراء محدد تجريبي — ${NETWORKS[key].label}`, '',
      `$${market.symbol} • ${short(address)}`,
      `السعر الحالي: ${priceText(market.priceUsd)}`,
      '',
      'اختر مستوى الدخول. بعدها تختار المبلغ ثم تؤكد الأمر.',
      '🧪 تجريبي فقط — لا يوجد أمر حقيقي على السلسلة.'
    ].join('\n'),
    keyboard: [
      [{ text: '-5%', callback_data: `p3:ld:5:${key}:${address}` }, { text: '-10%', callback_data: `p3:ld:10:${key}:${address}` }],
      [{ text: '-20%', callback_data: `p3:ld:20:${key}:${address}` }, { text: '-30%', callback_data: `p3:ld:30:${key}:${address}` }],
      [{ text: '📋 الأوامر', callback_data: 'p3:o' }]
    ]
  };
}

async function limitAmount(instance, discountPct, network, address) {
  const key = normalizeTerminalNetwork(network);
  const discount = Math.max(1, Math.min(80, finite(discountPct)));
  const market = await marketFor(key, address).catch(() => null);
  if (!market?.priceUsd) return { text: '❌ تعذر قراءة السعر الحالي.', keyboard: [] };
  const target = market.priceUsd * (1 - discount / 100);
  const amounts = [25, 50, 100, 250];
  return {
    text: `🎯 معاينة أمر الشراء المحدد\n\n$${market.symbol} • ${NETWORKS[key].label}\nالسعر الحالي: ${priceText(market.priceUsd)}\nالسعر المستهدف: ${priceText(target)} (-${discount}%)\n\nاختر المبلغ:`,
    keyboard: [
      amounts.slice(0, 2).map((amount) => ({ text: `$${amount}`, callback_data: `p3:lc:${discount}:${amount}:${key}:${address}` })),
      amounts.slice(2).map((amount) => ({ text: `$${amount}`, callback_data: `p3:lc:${discount}:${amount}:${key}:${address}` }))
    ]
  };
}

async function createLimit(instance, discountPct, amountUsd, network, address) {
  const key = normalizeTerminalNetwork(network);
  const discount = Math.max(1, Math.min(80, finite(discountPct)));
  const amount = Math.max(1, Math.min(5_000, finite(amountUsd)));
  const market = await marketFor(key, address).catch(() => null);
  if (!market?.priceUsd) return { text: '❌ لا يوجد سعر موثوق لإنشاء الأمر.', keyboard: [] };
  const orders = await getJsonSetting(instance.settings, ORDERS_KEY, []);
  const order = {
    id: orderId('limit', key, address), type: 'limit', status: 'open', network: key, address,
    symbol: market.symbol, amountUsd: amount, createdPrice: market.priceUsd,
    targetPrice: market.priceUsd * (1 - discount / 100), discountPct: discount,
    createdAt: new Date().toISOString()
  };
  orders.unshift(order);
  await setJsonSetting(instance.settings, ORDERS_KEY, orders.slice(0, 80));
  return {
    text: `✅ PAPER LIMIT ORDER CREATED\n\n$${market.symbol} • ${NETWORKS[key].label}\nالمبلغ: $${amount.toFixed(2)}\nالسعر الحالي: ${priceText(market.priceUsd)}\nالسعر المستهدف: ${priceText(order.targetPrice)} (-${discount}%)\n\n🤖 سيُراقب كل عدة ثوانٍ ويُنفذ شراء تجريبي عند الوصول للسعر.`,
    keyboard: [[{ text: '📋 الأوامر', callback_data: 'p3:o' }, { text: '🔎 تحليل', callback_data: `term:a:${key}:${address}` }]]
  };
}

async function dcaMenu(instance, network, address) {
  const key = normalizeTerminalNetwork(network);
  if (!isTerminalAddress(key, address)) return { text: '❌ عقد غير صالح.', keyboard: [] };
  const market = await marketFor(key, address).catch(() => null);
  return {
    text: [
      `📆 شراء دوري تجريبي — ${NETWORKS[key].label}`, '',
      `${market ? `$${market.symbol}` : 'TOKEN'} • ${short(address)}`,
      market ? `السعر: ${priceText(market.priceUsd)}` : '',
      '', 'اختر الخطة. تُنفذ الدفعات تجريبيًا فقط.',
      'كل خطة تستخدم مبلغًا إجماليًا مقسمًا بالتساوي.'
    ].filter(Boolean).join('\n'),
    keyboard: [
      [{ text: '$60 × 3 / 1m', callback_data: `p3:dc:60:3:1:${key}:${address}` }],
      [{ text: '$150 × 3 / 5m', callback_data: `p3:dc:150:3:5:${key}:${address}` }],
      [{ text: '$300 × 4 / 15m', callback_data: `p3:dc:300:4:15:${key}:${address}` }],
      [{ text: '📋 الأوامر', callback_data: 'p3:o' }]
    ]
  };
}

async function createDca(instance, totalUsd, installments, intervalMin, network, address) {
  const key = normalizeTerminalNetwork(network);
  const total = Math.max(1, Math.min(5_000, finite(totalUsd)));
  const count = Math.max(2, Math.min(12, Math.floor(finite(installments))));
  const minutes = Math.max(1, Math.min(240, finite(intervalMin)));
  if (!isTerminalAddress(key, address)) return { text: '❌ عقد غير صالح.', keyboard: [] };
  const market = await marketFor(key, address).catch(() => null);
  const orders = await getJsonSetting(instance.settings, ORDERS_KEY, []);
  const order = {
    id: orderId('dca', key, address), type: 'dca', status: 'open', network: key, address,
    symbol: market?.symbol || 'TOKEN', totalUsd: total, installments: count, filled: 0,
    amountPerFill: total / count, intervalMs: minutes * 60_000,
    nextAt: Date.now(), createdAt: new Date().toISOString()
  };
  orders.unshift(order);
  await setJsonSetting(instance.settings, ORDERS_KEY, orders.slice(0, 80));
  return {
    text: `✅ PAPER DCA CREATED\n\n$${order.symbol} • ${NETWORKS[key].label}\nالإجمالي: $${total.toFixed(2)}\nالدفعات: ${count} × $${order.amountPerFill.toFixed(2)}\nالفاصل: ${minutes} دقيقة\n\nأول دفعة ستنفذ في دورة المراقبة القادمة.`,
    keyboard: [[{ text: '📋 الأوامر', callback_data: 'p3:o' }, { text: '📊 المراكز', callback_data: 'term:p' }]]
  };
}

async function ordersDashboard(instance) {
  const orders = await getJsonSetting(instance.settings, ORDERS_KEY, []);
  const active = orders.filter((order) => order.status === 'open').slice(0, 10);
  if (!active.length) return { text: '📋 الأوامر التجريبية\n\nلا توجد أوامر شراء محدد أو شراء دوري مفتوحة.', keyboard: [[{ text: '📊 المراكز', callback_data: 'term:p' }]] };
  const lines = ['📋 الأوامر التجريبية', ''];
  const keyboard = [];
  for (const order of active) {
    if (order.type === 'limit') lines.push(`🎯 $${order.symbol} • ${NETWORKS[order.network]?.label || order.network}\n   $${finite(order.amountUsd).toFixed(0)} @ ${priceText(order.targetPrice)}`);
    else lines.push(`📆 $${order.symbol} • ${NETWORKS[order.network]?.label || order.network}\n   ${order.filled}/${order.installments} منفذة • $${finite(order.amountPerFill).toFixed(0)} لكل دفعة`);
    keyboard.push([{ text: `❌ إلغاء ${order.symbol}`, callback_data: `p3:oc:${encodeURIComponent(order.id)}` }]);
  }
  keyboard.push([{ text: '📊 المراكز', callback_data: 'term:p' }]);
  return { text: lines.join('\n'), keyboard };
}

async function cancelOrder(instance, encodedId) {
  const id = decodeURIComponent(String(encodedId || ''));
  const orders = await getJsonSetting(instance.settings, ORDERS_KEY, []);
  const order = orders.find((row) => row.id === id && row.status === 'open');
  if (!order) return { text: 'ℹ️ الأمر غير موجود أو مغلق.', keyboard: [[{ text: '📋 الأوامر', callback_data: 'p3:o' }]] };
  order.status = 'cancelled';
  order.cancelledAt = new Date().toISOString();
  await setJsonSetting(instance.settings, ORDERS_KEY, orders);
  return { text: `✅ تم إلغاء الأمر التجريبي ${order.type.toUpperCase()} لـ $${order.symbol}.`, keyboard: [[{ text: '📋 الأوامر', callback_data: 'p3:o' }]] };
}

async function sniperMenu(instance, network, address) {
  const key = normalizeTerminalNetwork(network);
  if (!isTerminalAddress(key, address)) return { text: '❌ عقد غير صالح.', keyboard: [] };
  const active = await sniperCode(instance);
  return {
    text: [
      '🎯 فحص القنص في SUMMECA — تأكيد يدوي', '',
      `العقد: ${short(address)} • ${NETWORKS[key].label}`,
      `الإعداد الحالي: ${SNIPER_PRESETS[active].label}`,
      '',
      'ميزة القنص هنا لا تشتري تلقائيًا. يفحص العقد فورًا ثم يعرض نتيجة نجاح/فشل وزر شراء تجريبي للتأكيد.'
    ].join('\n'),
    keyboard: [
      [{ text: '⚡ مبكر', callback_data: `p3:ss:u:${key}:${address}` }, { text: '🛡️ متوازن', callback_data: `p3:ss:b:${key}:${address}` }],
      [{ text: '💎 صارم', callback_data: `p3:ss:s:${key}:${address}` }],
      [{ text: '🔍 تشغيل الفحص', callback_data: `p3:sr:${key}:${address}` }]
    ]
  };
}

async function setSniper(instance, code, network, address) {
  const safe = await setSniperCode(instance, code);
  return sniperMenu(instance, network, address).then((result) => ({ ...result, text: `✅ إعداد القنص: ${SNIPER_PRESETS[safe].label}\n\n${result.text}` }));
}

async function runSniper(instance, network, address) {
  const key = normalizeTerminalNetwork(network);
  const market = await marketFor(key, address).catch(() => null);
  const code = await sniperCode(instance);
  const p = SNIPER_PRESETS[code];
  if (!market) return { text: '⏳ السوق لم يظهر بعد؛ العقد يبقى تحت الرصد ولا يتم شراء شيء.', keyboard: [[{ text: '🔄 إعادة الفحص', callback_data: `p3:sr:${key}:${address}` }]] };
  const ratio = market.buys5m / Math.max(1, market.sells5m);
  const checks = {
    mc: market.marketCapUsd > 0 && market.marketCapUsd <= p.maxMc,
    liq: market.liquidityUsd >= p.minLiquidity,
    buys: market.buys5m >= p.minBuys,
    move: market.priceChange5mPct <= p.maxMove,
    ratio: ratio >= 1.2
  };
  const pass = Object.values(checks).every(Boolean);
  const lines = [
    `${pass ? '✅' : '⚠️'} SNIPER CHECK — ${p.label}`, '',
    `$${market.symbol} • ${NETWORKS[key].label}`,
    `${checks.mc ? '✅' : '❌'} MC ${money(market.marketCapUsd)} ≤ ${money(p.maxMc)}`,
    `${checks.liq ? '✅' : '❌'} Liquidity ${money(market.liquidityUsd)} ≥ ${money(p.minLiquidity)}`,
    `${checks.buys ? '✅' : '❌'} Buys 5m ${market.buys5m} ≥ ${p.minBuys}`,
    `${checks.move ? '✅' : '❌'} Move 5m ${market.priceChange5mPct.toFixed(1)}% ≤ ${p.maxMove}%`,
    `${checks.ratio ? '✅' : '❌'} Buy/Sell ${ratio.toFixed(2)}x ≥ 1.20x`,
    '', pass ? '🟢 PASSED — يمكنك فتح Buy Preview ثم التأكيد يدويًا.' : '🟡 لم يجتز كل الشروط. لا يوجد تنفيذ تلقائي.'
  ];
  return {
    text: lines.join('\n'),
    keyboard: pass
      ? [[{ text: '🟢 معاينة الشراء', callback_data: `term:b:${key}:${address}` }, { text: '🔎 تحليل', callback_data: `term:a:${key}:${address}` }]]
      : [[{ text: '🔄 إعادة الفحص', callback_data: `p3:sr:${key}:${address}` }, { text: '🔎 تحليل', callback_data: `term:a:${key}:${address}` }]]
  };
}

function parseWallets() {
  return String(process.env.TRENCHES_WALLETS || '')
    .split(',').map((v) => v.trim()).filter(Boolean).map((entry, index) => {
      const [a, b] = entry.includes('|') ? entry.split('|', 2) : entry.includes('=') ? entry.split('=', 2) : [entry, ''];
      const hex = /^0x[0-9a-fA-F]{40}$/;
      const address = hex.test(a) ? a : hex.test(b) ? b : '';
      const label = address === a ? (b || `wallet-${index + 1}`) : (a || `wallet-${index + 1}`);
      return address ? { label: String(label).trim(), address } : null;
    }).filter(Boolean);
}

async function copyDashboard(instance) {
  const wallets = parseWallets();
  const orders = await getJsonSetting(instance.settings, ORDERS_KEY, []);
  const openCopyLike = orders.filter((o) => o.status === 'open' && ['limit', 'dca'].includes(o.type)).length;
  const lines = [
    '🧠 لوحة نسخ المحافظ الذكية', '',
    `👛 محافظ EVM المتتبعة: ${wallets.length}`,
    ...wallets.slice(0, 8).map((w, i) => `${i + 1}. ${w.label} • ${short(w.address)}`),
    '',
    `📋 الأوامر التجريبية النشطة: ${openCopyLike}`,
    '✅ مسار النسخ: معاينة ← مبلغ ← تأكيد نهائي',
    '🔒 النسخ الحقيقي الأعمى/التلقائي: متوقف',
    '',
    'ملاحظة: هذه محافظ EVM المتتبعة العامة/المهيأة؛ لا يتم وصفها كـElite إلا بعد سجل أداء مثبت.'
  ];
  return {
    text: lines.join('\n'),
    keyboard: [[{ text: '📋 الأوامر', callback_data: 'p3:o' }, { text: '📊 المراكز', callback_data: 'term:p' }], [{ text: '👛 المحفظة', callback_data: 'adv:w' }]]
  };
}

let installed = false;
let monitorStarted = false;
let monitorRunning = false;
const settings = new AppSettings(env.supabaseUrl, env.supabaseSecretKey);
let terminalForMonitor = null;

async function notify(text, keyboard = []) {
  if (!env.telegramBotToken) return;
  let chatId = String(env.telegramChatId || '');
  if (!chatId && settings.enabled) chatId = String(await settings.get('telegram_chat_id').catch(() => '') || '');
  if (!chatId) return;
  await telegramApi(env.telegramBotToken, 'sendMessage', { chat_id: chatId, text, ...(keyboard.length ? { reply_markup: { inline_keyboard: keyboard } } : {}) }).catch(() => {});
}

async function orderCycle() {
  if (monitorRunning || !settings.enabled || !terminalForMonitor) return;
  monitorRunning = true;
  try {
    const orders = await getJsonSetting(settings, ORDERS_KEY, []);
    let changed = false;
    for (const order of orders.filter((o) => o.status === 'open').slice(0, 20)) {
      const market = await marketFor(order.network, order.address).catch(() => null);
      if (!market?.priceUsd) continue;
      if (order.type === 'limit' && market.priceUsd <= finite(order.targetPrice)) {
        const result = await terminalForMonitor.paperBuy(finite(order.amountUsd), order.network, order.address);
        if (/PAPER BUY تم/.test(String(result?.text || ''))) {
          order.status = 'filled'; order.filledAt = new Date().toISOString(); order.fillPrice = market.priceUsd; changed = true;
          await notify(`🎯✅ PAPER LIMIT FILLED\n\n$${market.symbol} • ${NETWORKS[order.network]?.label || order.network}\nAmount: $${finite(order.amountUsd).toFixed(2)}\nFill: ${priceText(market.priceUsd)}\nالسعر المستهدف: ${priceText(order.targetPrice)}\n\n🧪 Paper only.`, [[{ text: '📊 المراكز', callback_data: 'term:p' }]]);
        }
      }
      if (order.type === 'dca' && Date.now() >= finite(order.nextAt) && finite(order.filled) < finite(order.installments)) {
        const result = await terminalForMonitor.paperBuy(finite(order.amountPerFill), order.network, order.address);
        if (/PAPER BUY تم/.test(String(result?.text || ''))) {
          order.filled = finite(order.filled) + 1;
          order.nextAt = Date.now() + finite(order.intervalMs);
          order.lastFillPrice = market.priceUsd;
          if (order.filled >= order.installments) { order.status = 'filled'; order.filledAt = new Date().toISOString(); }
          changed = true;
          await notify(`📆✅ PAPER DCA FILL ${order.filled}/${order.installments}\n\n$${market.symbol} • ${NETWORKS[order.network]?.label || order.network}\nAmount: $${finite(order.amountPerFill).toFixed(2)}\nFill: ${priceText(market.priceUsd)}\n\n🧪 Paper only.`, [[{ text: '📋 الأوامر', callback_data: 'p3:o' }, { text: '📊 المراكز', callback_data: 'term:p' }]]);
        }
      }
      await sleep(120);
    }
    if (changed) await setJsonSetting(settings, ORDERS_KEY, orders);
  } finally { monitorRunning = false; }
}

function startOrderMonitor() {
  if (monitorStarted) return;
  monitorStarted = true;
  setInterval(() => void orderCycle(), 5_000).unref?.();
  console.log('SUMMECA PAPER ORDER MONITOR: Limit + DCA active interval=5000ms liveBroadcast=off');
}

export function installPhase3Terminal() {
  if (installed) return;
  installed = true;

  const originalAnalyze = TradingTerminal.prototype.analyze;
  TradingTerminal.prototype.analyze = async function(network, address) {
    const result = await originalAnalyze.call(this, network, address);
    const key = normalizeTerminalNetwork(network);
    if (result?.keyboard && isTerminalAddress(key, address)) {
      result.keyboard = [...result.keyboard,
        [{ text: '🎯 أمر محدد', callback_data: `p3:l:${key}:${address}` }, { text: '📆 شراء دوري', callback_data: `p3:d:${key}:${address}` }, { text: '⚡ قنص', callback_data: `p3:s:${key}:${address}` }],
        [{ text: '🧠 نسخ التداول', callback_data: 'p3:c' }, { text: '📋 الأوامر', callback_data: 'p3:o' }]
      ];
    }
    terminalForMonitor = this;
    return result;
  };

  const originalHandle = TradingTerminal.prototype.handle;
  TradingTerminal.prototype.handle = async function(data) {
    const value = String(data ?? '');
    terminalForMonitor = this;
    if (!value.startsWith('p3:')) return originalHandle.call(this, data);
    const parts = value.split(':');
    const action = parts[1] || '';
    try {
      if (action === 'l' && parts.length >= 4) return { handled: true, ...(await limitMenu(this, parts[2], parts.slice(3).join(':'))) };
      if (action === 'ld' && parts.length >= 5) return { handled: true, ...(await limitAmount(this, parts[2], parts[3], parts.slice(4).join(':'))) };
      if (action === 'lc' && parts.length >= 6) return { handled: true, ...(await createLimit(this, parts[2], parts[3], parts[4], parts.slice(5).join(':'))) };
      if (action === 'd' && parts.length >= 4) return { handled: true, ...(await dcaMenu(this, parts[2], parts.slice(3).join(':'))) };
      if (action === 'dc' && parts.length >= 8) return { handled: true, ...(await createDca(this, parts[2], parts[3], parts[4], parts[5], parts.slice(6).join(':'))) };
      if (action === 'o' && parts.length === 2) return { handled: true, ...(await ordersDashboard(this)) };
      if (action === 'oc' && parts.length >= 3) return { handled: true, ...(await cancelOrder(this, parts.slice(2).join(':'))) };
      if (action === 's' && parts.length >= 4) return { handled: true, ...(await sniperMenu(this, parts[2], parts.slice(3).join(':'))) };
      if (action === 'ss' && parts.length >= 5) return { handled: true, ...(await setSniper(this, parts[2], parts[3], parts.slice(4).join(':'))) };
      if (action === 'sr' && parts.length >= 4) return { handled: true, ...(await runSniper(this, parts[2], parts.slice(3).join(':'))) };
      if (action === 'c') return { handled: true, ...(await copyDashboard(this)) };
    } catch (error) {
      return { handled: true, text: `❌ خطأ في منصة الأوامر: ${String(error?.message ?? error).slice(0, 180)}`, keyboard: [[{ text: '📋 الأوامر', callback_data: 'p3:o' }]] };
    }
    return { handled: true, text: 'ℹ️ أمر غير معروف في منصة الأوامر.', keyboard: [[{ text: '📋 الأوامر', callback_data: 'p3:o' }]] };
  };

  startOrderMonitor();
  console.log('SUMMECA TERMINAL PHASE 3: Paper Limit + DCA + Sniper Check + Smart-Wallet Copy Dashboard');
}
