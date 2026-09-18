import { env } from '../config/env.mjs';
import { AppSettings } from '../storage/appSettings.mjs';
import { telegramApi } from '../notifiers/telegram.mjs';
import { TradingTerminal, normalizeTerminalNetwork, isTerminalAddress } from './tradingTerminal.mjs';
import { DEFAULT_STOP_LADDER_CONFIG, STOP_LADDER_KEY, formatStopLadder, normalizeStopLadderConfig, stopFloorForHighWater } from '../trading/stopLadder.mjs';

const POSITIONS_KEY = 'terminal_paper_positions_v1';
const PRESET_KEY = 'terminal_buy_preset_v1';
const SOLANA = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
const finite = (value, fallback = 0) => Number.isFinite(Number(value)) ? Number(value) : fallback;
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, Math.max(0, ms)));
const short = (value) => {
  const text = String(value ?? '');
  return text.length > 15 ? `${text.slice(0, 7)}…${text.slice(-5)}` : text;
};
const money = (value) => {
  const n = finite(value);
  if (Math.abs(n) >= 1_000_000) return `$${(n / 1_000_000).toFixed(2)}M`;
  if (Math.abs(n) >= 1_000) return `$${(n / 1_000).toFixed(1)}K`;
  return `$${n.toFixed(2)}`;
};
const priceText = (value) => {
  const n = finite(value);
  if (!(n > 0)) return '—';
  return n >= 0.01 ? `$${n.toLocaleString('en-US', { maximumFractionDigits: 8 })}` : `$${n.toExponential(6)}`;
};

const NETWORKS = {
  sol: { label: 'SOLANA', dex: 'solana' },
  bsc: { label: 'BNB CHAIN', dex: 'bsc' },
  arc: { label: 'ARC', dex: 'arc' },
  rh: { label: 'ROBINHOOD CHAIN', dex: 'robinhood' }
};

const BUY_PRESETS = {
  c: { label: '🛡️ حذر', amounts: [10, 25, 50, 100] },
  s: { label: '⚡ متوازن', amounts: [25, 50, 100, 250] },
  h: { label: '🔥 مرتفع', amounts: [50, 100, 250, 500] }
};

const RISK_PRESETS = {
  f: { label: '⚡ سريع', takeProfitPct: 50, stopLossPct: 10, trailingPct: 15 },
  b: { label: '🛡️ متوازن', takeProfitPct: 100, stopLossPct: 15, trailingPct: 20 },
  m: { label: '🚀 هجومي', takeProfitPct: 200, stopLossPct: 20, trailingPct: 25 },
  o: { label: '⏸ متوقف', takeProfitPct: 0, stopLossPct: 0, trailingPct: 0 }
};

async function fetchJson(url, options = {}, timeoutMs = 5_000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, { ...options, signal: controller.signal });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return await response.json();
  } finally {
    clearTimeout(timer);
  }
}

async function marketFor(network, address) {
  const key = normalizeTerminalNetwork(network);
  const cfg = NETWORKS[key];
  if (!cfg || !isTerminalAddress(key, address)) return null;
  const body = await fetchJson(`https://api.dexscreener.com/tokens/v1/${encodeURIComponent(cfg.dex)}/${encodeURIComponent(address)}`, {
    headers: { accept: 'application/json' }
  }).catch(() => []);
  const rows = Array.isArray(body) ? body : [];
  const pair = rows
    .filter((row) => String(row?.chainId ?? '').toLowerCase() === cfg.dex)
    .sort((a, b) => finite(b?.liquidity?.usd) - finite(a?.liquidity?.usd))[0] || rows[0];
  if (!pair) return null;
  const base = String(pair?.baseToken?.address ?? '');
  const token = base.toLowerCase() === String(address).toLowerCase() ? pair.baseToken : pair.quoteToken;
  return {
    symbol: token?.symbol || 'TOKEN',
    priceUsd: finite(pair?.priceUsd),
    liquidityUsd: finite(pair?.liquidity?.usd),
    url: pair?.url || ''
  };
}

async function loadRows(instance) {
  if (!instance?.settings?.enabled) return Array.isArray(instance?.memoryPositions) ? instance.memoryPositions : [];
  try {
    const raw = await instance.settings.get(POSITIONS_KEY);
    const rows = raw ? JSON.parse(String(raw)) : [];
    return Array.isArray(rows) ? rows.slice(0, 50) : [];
  } catch {
    return Array.isArray(instance?.memoryPositions) ? instance.memoryPositions : [];
  }
}

async function saveRows(instance, rows) {
  const safe = Array.isArray(rows) ? rows.slice(0, 50) : [];
  instance.memoryPositions = safe;
  if (instance?.settings?.enabled) await instance.settings.set(POSITIONS_KEY, JSON.stringify(safe)).catch(() => {});
}

async function presetCode(instance) {
  if (!instance?.settings?.enabled) return 's';
  const raw = String(await instance.settings.get(PRESET_KEY).catch(() => '') || '').toLowerCase();
  return BUY_PRESETS[raw] ? raw : 's';
}

async function setPresetCode(instance, code) {
  const safe = BUY_PRESETS[code] ? code : 's';
  if (instance?.settings?.enabled) await instance.settings.set(PRESET_KEY, safe).catch(() => {});
  return safe;
}

function amountKeyboard(code, key, address, action = 'term:bp') {
  const pack = BUY_PRESETS[code] || BUY_PRESETS.s;
  const buttons = pack.amounts.map((amount) => ({ text: `$${amount}`, callback_data: `${action}:${amount}:${key}:${address}` }));
  return [buttons.slice(0, 2), buttons.slice(2)];
}

async function ladderConfig(instance) {
  if (!instance?.settings?.enabled) return normalizeStopLadderConfig(DEFAULT_STOP_LADDER_CONFIG);
  const raw = await instance.settings.get(STOP_LADDER_KEY).catch(() => '');
  return normalizeStopLadderConfig(raw || DEFAULT_STOP_LADDER_CONFIG);
}

async function toggleRiskLadder(instance, network, address) {
  const key = normalizeTerminalNetwork(network);
  if (!isTerminalAddress(key, address)) return { text: '❌ عنوان العقد أو الشبكة غير صالحين.', keyboard: [] };
  const rows = await loadRows(instance);
  const id = `${key}:${String(address).toLowerCase()}`;
  const position = rows.find((row) => row.id === id && row.status === 'open');
  if (!position) return { text: '❌ لا يوجد مركز مفتوح لهذا العقد.', keyboard: [] };
  const config = await ladderConfig(instance);
  position.dynamicStopLadder = !position.dynamicStopLadder;
  position.ladderStopPct = position.dynamicStopLadder ? null : position.ladderStopPct;
  position.ladderHighWaterPct = position.dynamicStopLadder ? 0 : position.ladderHighWaterPct;
  if (position.dynamicStopLadder) {
    position.takeProfitPct = 0;
    position.trailingPct = 0;
    position.stopLossPct = config.initialStopLossPct;
  }
  position.riskUpdatedAt = new Date().toISOString();
  await saveRows(instance, rows);
  return riskMenu(instance, key, address);
}

async function riskMenu(instance, network, address) {
  const key = normalizeTerminalNetwork(network);
  if (!isTerminalAddress(key, address)) return { text: '❌ عنوان العقد أو الشبكة غير صالحين.', keyboard: [] };
  const rows = await loadRows(instance);
  const id = `${key}:${String(address).toLowerCase()}`;
  const position = rows.find((row) => row.id === id && row.status === 'open');
  if (!position) {
    return {
      text: `🎯 جني الربح / وقف الخسارة / الوقف المتحرك\n\nلا يوجد مركز تجريبي مفتوح للعقد ${short(address)}.\nافتح شراء أولًا ثم اختر خطة إدارة المخاطر.`,
      keyboard: [[{ text: '🟢 شراء', callback_data: `term:b:${key}:${address}` }, { text: '🔎 تحليل', callback_data: `term:a:${key}:${address}` }]]
    };
  }
  return {
    text: [
      `🎯 إدارة المخاطر — ${NETWORKS[key]?.label || key}`,
      '',
      `$${position.symbol || 'TOKEN'} • ${short(address)}`,
      `سعر الدخول: ${priceText(position.entryPrice)}`,
      `جني الربح: ${finite(position.takeProfitPct)}% | وقف الخسارة: ${finite(position.stopLossPct)}% | الوقف المتحرك: ${finite(position.trailingPct)}%`,
      `🪜 سُلّم الوقف: ${position.dynamicStopLadder ? 'مفعّل ✅' : 'متوقف'}${Number.isFinite(Number(position.ladderStopPct)) ? ` • الوقف الحالي +${finite(position.ladderStopPct)}%` : ''}`,
      '',
      position.dynamicStopLadder
        ? 'السُلّم الديناميكي هو المسؤول الآن؛ تم تعطيل جني الربح الثابت والوقف المتحرك التقليدي لهذا المركز.'
        : 'اختر خطة عادية أو فعّل سُلّم الوقف الديناميكي.'
    ].join('\n'),
    keyboard: [
      [
        { text: '⚡ سريع 50/10/15', callback_data: `adv:rp:f:${key}:${address}` },
        { text: '🛡️ متوازن 100/15/20', callback_data: `adv:rp:b:${key}:${address}` }
      ],
      [
        { text: '🚀 هجومي 200/20/25', callback_data: `adv:rp:m:${key}:${address}` },
        { text: '⏸ إيقاف', callback_data: `adv:rp:o:${key}:${address}` }
      ],
      [
        { text: position.dynamicStopLadder ? '⏸ إيقاف سُلّم الوقف' : '🪜 تفعيل سُلّم الوقف', callback_data: `adv:rl:${key}:${address}` },
        { text: '✏️ تعديل السُلّم', callback_data: 'p8:ladder' }
      ],
      [{ text: '📊 المراكز', callback_data: 'term:p' }]
    ]
  };
}

async function applyRiskPreset(instance, code, network, address) {
  const key = normalizeTerminalNetwork(network);
  const preset = RISK_PRESETS[code];
  if (!preset || !isTerminalAddress(key, address)) return { text: '❌ إعداد غير صالح.', keyboard: [] };
  const rows = await loadRows(instance);
  const id = `${key}:${String(address).toLowerCase()}`;
  const position = rows.find((row) => row.id === id && row.status === 'open');
  if (!position) return { text: '❌ لا يوجد مركز تجريبي مفتوح.', keyboard: [] };
  position.takeProfitPct = preset.takeProfitPct;
  position.stopLossPct = preset.stopLossPct;
  position.trailingPct = preset.trailingPct;
  position.dynamicStopLadder = false;
  position.peakPrice = Math.max(finite(position.peakPrice), finite(position.entryPrice));
  position.riskUpdatedAt = new Date().toISOString();
  await saveRows(instance, rows);
  return {
    text: [
      `✅ تم تطبيق ${preset.label}`,
      '',
      `$${position.symbol || 'TOKEN'} • ${NETWORKS[key]?.label || key}`,
      `جني الربح +${preset.takeProfitPct}% | وقف الخسارة -${preset.stopLossPct}% | الوقف المتحرك ${preset.trailingPct}%`,
      '',
      preset.takeProfitPct ? '🧪 المراقب سيغلق المركز التجريبي تلقائيًا عند تحقق أول شرط.' : '⏸ تم إيقاف إدارة المخاطر الآلية لهذا المركز.'
    ].join('\n'),
    keyboard: [[{ text: '🎯 إدارة المخاطر', callback_data: `adv:r:${key}:${address}` }, { text: '📊 المراكز', callback_data: 'term:p' }]]
  };
}

async function presetMenu(instance) {
  const active = await presetCode(instance);
  return {
    text: [
      '⚙️ مبالغ الشراء — تجريبي', '',
      `الحالي: ${BUY_PRESETS[active].label} → ${BUY_PRESETS[active].amounts.map((v) => `$${v}`).join(' / ')}`,
      '',
      'تُستخدم هذه القيم في معاينة الشراء ونسخ التداول. لا توجد صفقة حقيقية.'
    ].join('\n'),
    keyboard: [
      [{ text: '🛡️ $10/$25/$50/$100', callback_data: 'adv:pre:c' }],
      [{ text: '⚡ $25/$50/$100/$250', callback_data: 'adv:pre:s' }],
      [{ text: '🔥 $50/$100/$250/$500', callback_data: 'adv:pre:h' }],
      [{ text: '📊 المراكز', callback_data: 'term:p' }]
    ]
  };
}

async function setPreset(instance, code) {
  const safe = await setPresetCode(instance, code);
  return {
    text: `✅ إعداد مبلغ الشراء: ${BUY_PRESETS[safe].label}\n${BUY_PRESETS[safe].amounts.map((v) => `$${v}`).join(' / ')}\n\n🧪 Paper/Safe Mode فقط.`,
    keyboard: [[{ text: '⚙️ مبالغ الشراء', callback_data: 'adv:pre' }, { text: '📊 المراكز', callback_data: 'term:p' }]]
  };
}

async function copyPreview(instance, network, address) {
  const key = normalizeTerminalNetwork(network);
  if (!isTerminalAddress(key, address)) return { text: '❌ عقد غير صالح.', keyboard: [] };
  const market = await marketFor(key, address).catch(() => null);
  const code = await presetCode(instance);
  const pack = BUY_PRESETS[code];
  return {
    text: [
      `🧠 معاينة نسخ التداول — ${NETWORKS[key]?.label || key}`,
      '',
      `${market ? `$${market.symbol}` : 'TOKEN'} • ${short(address)}`,
      market ? `السعر: ${priceText(market.priceUsd)} | السيولة: ${money(market.liquidityUsd)}` : 'السوق لم يظهر بشكل موثوق بعد.',
      `الإعداد: ${pack.label}`,
      '',
      'اختر مبلغًا. بعد ذلك ستظهر شاشة تأكيد أخيرة.',
      '🔒 لا يوجد نسخ تداول أعمى أو تنفيذ تلقائي بأموال حقيقية.'
    ].join('\n'),
    keyboard: [
      ...amountKeyboard(code, key, address, 'adv:cb'),
      [{ text: '🔎 تحليل', callback_data: `term:a:${key}:${address}` }, { text: '⚙️ مبالغ الشراء', callback_data: 'adv:pre' }]
    ]
  };
}

async function walletDashboard(instance) {
  const rows = await loadRows(instance);
  const open = rows.filter((row) => row.status === 'open');
  const closed = rows.filter((row) => row.status === 'closed');
  const cost = open.reduce((sum, row) => sum + finite(row.costUsd), 0);
  const realized = closed.reduce((sum, row) => sum + finite(row.realizedPnlUsd), 0);
  const address = String(env.privyWalletAddress || '');
  let balanceLine = '💰 الرصيد الحقيقي: غير معروض';
  if (SOLANA.test(address)) {
    try {
      const body = await fetchJson('https://api.mainnet-beta.solana.com', {
        method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 'summeca-wallet', method: 'getBalance', params: [address, { commitment: 'processed' }] })
      }, 4_000);
      const lamports = finite(body?.result?.value);
      if (lamports >= 0) balanceLine = `💰 رصيد SOL: ${(lamports / 1e9).toFixed(4)} SOL`;
    } catch {}
  }
  return {
    text: [
      '👛 لوحة محفظة SUMMECA', '',
      `🔐 المحفظة: ${address ? short(address) : 'غير مهيأة'}`,
      balanceLine,
      `📊 المراكز التجريبية: ${open.length}`,
      `🧪 رأس المال التجريبي المفتوح: ${money(cost)}`,
      `✅ الربح/الخسارة التجريبية المحققة: ${realized >= 0 ? '+' : ''}${money(realized)}`,
      '',
      `🔒 LIVE_TRADING_ENABLED: ${env.liveTradingEnabled ? 'ON في البيئة، لكن Terminal لا يبث معاملات' : 'OFF'}`,
      'لا يتم عرض أي مفتاح خاص أو سر داخل تيليجرام.'
    ].join('\n'),
    keyboard: [[{ text: '📊 المراكز', callback_data: 'term:p' }, { text: '⚙️ مبالغ الشراء', callback_data: 'adv:pre' }]]
  };
}

let patched = false;
let monitorStarted = false;
let monitorRunning = false;
const monitorSettings = new AppSettings(env.supabaseUrl, env.supabaseSecretKey);

async function monitorLoad() {
  if (!monitorSettings.enabled) return [];
  try {
    const raw = await monitorSettings.get(POSITIONS_KEY);
    const rows = raw ? JSON.parse(String(raw)) : [];
    return Array.isArray(rows) ? rows.slice(0, 50) : [];
  } catch { return []; }
}

async function monitorSave(rows) {
  if (monitorSettings.enabled) await monitorSettings.set(POSITIONS_KEY, JSON.stringify(rows.slice(0, 50))).catch(() => {});
}

async function notifyAutoExit(position, price, reason, pnl) {
  if (!env.telegramBotToken) return;
  let chatId = String(env.telegramChatId || '');
  if (!chatId && monitorSettings.enabled) chatId = String(await monitorSettings.get('telegram_chat_id').catch(() => '') || '');
  if (!chatId) return;
  await telegramApi(env.telegramBotToken, 'sendMessage', {
    chat_id: chatId,
    text: [
      '🤖🎯 خروج تجريبي تلقائي من SUMMECA', '',
      `$${position.symbol || 'TOKEN'} • ${NETWORKS[position.network]?.label || position.network}`,
      `السبب: ${reason}`,
      `سعر الخروج: ${priceText(price)}`,
      `الربح/الخسارة التجريبية: ${pnl >= 0 ? '+' : ''}${money(pnl)}`,
      '',
      '🧪 هذه محاكاة فقط ولم تُرسل أي معاملة حقيقية.',
      `CA: ${position.address}`
    ].join('\n'),
    reply_markup: { inline_keyboard: [[{ text: '📊 المراكز', callback_data: 'term:p' }, { text: '🔎 تحليل', callback_data: `term:a:${position.network}:${position.address}` }]] }
  }).catch(() => {});
}

async function notifyStopRaised(position, triggerPct, stopPct, pnlPct) {
  if (!env.telegramBotToken) return;
  let chatId = String(env.telegramChatId || '');
  if (!chatId && monitorSettings.enabled) chatId = String(await monitorSettings.get('telegram_chat_id').catch(() => '') || '');
  if (!chatId) return;
  await telegramApi(env.telegramBotToken, 'sendMessage', {
    chat_id: chatId,
    text: [
      '🪜⬆️ تم رفع وقف الربح',
      '',
      `${position.symbol || 'TOKEN'} • ${NETWORKS[position.network]?.label || position.network}`,
      `وصلت القمة إلى +${finite(triggerPct).toFixed(0)}% أو أكثر`,
      `الوقف الجديد: +${finite(stopPct).toFixed(0)}%`,
      `الربح الحالي: +${Math.max(0, finite(pnlPct)).toFixed(1)}%`,
      '',
      '✅ لن يعود الوقف إلى مستوى أقل بعد الآن.',
      `العقد: ${position.address}`
    ].join('\n'),
    reply_markup: { inline_keyboard: [[
      { text: '🎯 إدارة المخاطر', callback_data: `adv:r:${position.network}:${position.address}` },
      { text: '📊 المراكز', callback_data: 'term:p' }
    ]] }
  }).catch(() => {});
}

async function paperRiskCycle() {
  if (monitorRunning || !monitorSettings.enabled) return;
  monitorRunning = true;
  try {
    const rows = await monitorLoad();
    let changed = false;
    for (const position of rows.filter((row) => row.status === 'open')) {
      const tp = finite(position.takeProfitPct);
      const sl = finite(position.stopLossPct);
      const trail = finite(position.trailingPct);
      const ladderEnabled = position.dynamicStopLadder === true;
      if (!(tp > 0 || sl > 0 || trail > 0 || ladderEnabled)) continue;
      const market = await marketFor(position.network, position.address).catch(() => null);
      const price = finite(market?.priceUsd);
      const entry = finite(position.entryPrice);
      if (!(price > 0 && entry > 0)) continue;
      const peak = Math.max(finite(position.peakPrice, entry), price);
      if (peak !== finite(position.peakPrice)) {
        position.peakPrice = peak;
        changed = true;
      }
      const pnlPct = (price / entry - 1) * 100;
      const peakPnlPct = (peak / entry - 1) * 100;
      let reason = '';

      if (ladderEnabled) {
        const config = normalizeStopLadderConfig(await monitorSettings.get(STOP_LADDER_KEY).catch(() => '') || DEFAULT_STOP_LADDER_CONFIG);
        const priorFloor = Number.isFinite(Number(position.ladderStopPct)) ? Number(position.ladderStopPct) : null;
        const { floorPct, triggerPct } = stopFloorForHighWater(peakPnlPct, config);
        const nextFloor = floorPct == null ? priorFloor : priorFloor == null ? floorPct : Math.max(priorFloor, floorPct);
        position.ladderHighWaterPct = Math.max(finite(position.ladderHighWaterPct), peakPnlPct);
        if (nextFloor != null && nextFloor !== priorFloor) {
          position.ladderStopPct = nextFloor;
          changed = true;
          await notifyStopRaised(position, triggerPct, nextFloor, pnlPct);
        }
        const effectiveSl = finite(config.initialStopLossPct, sl || 15);
        if (pnlPct <= -effectiveSl) reason = `وقف خسارة -${effectiveSl}%`;
        else if (nextFloor != null && pnlPct <= nextFloor) reason = `سُلّم الوقف +${nextFloor}% بعد قمة +${finite(position.ladderHighWaterPct).toFixed(1)}%`;
      } else {
        if (sl > 0 && pnlPct <= -sl) reason = `وقف خسارة -${sl}%`;
        else if (tp > 0 && pnlPct >= tp) reason = `جني ربح +${tp}%`;
        else if (trail > 0 && peak >= entry * 1.10 && price <= peak * (1 - trail / 100)) reason = `وقف متحرك ${trail}%`;
      }
      if (!reason) continue;

      const qty = finite(position.qty);
      const proceeds = qty * price;
      const pnl = proceeds - finite(position.costUsd);
      position.status = 'closed';
      position.realizedPnlUsd = finite(position.realizedPnlUsd) + pnl;
      position.exitPrice = price;
      position.exitReason = reason;
      position.closedAt = new Date().toISOString();
      position.updatedAt = position.closedAt;
      changed = true;
      await notifyAutoExit(position, price, reason, pnl);
      await wait(120);
    }
    if (changed) await monitorSave(rows);
  } finally {
    monitorRunning = false;
  }
}

function startMonitor() {
  if (monitorStarted) return;
  monitorStarted = true;
  setInterval(() => void paperRiskCycle(), 5_000).unref?.();
  console.log('SUMMECA PAPER RISK MONITOR: TP/SL/Trailing active interval=5000ms liveBroadcast=off');
}

export function installAdvancedTerminal() {
  if (patched) return;
  patched = true;

  const originalAnalyze = TradingTerminal.prototype.analyze;
  TradingTerminal.prototype.analyze = async function(network, address) {
    const result = await originalAnalyze.call(this, network, address);
    const key = normalizeTerminalNetwork(network);
    if (result?.keyboard && isTerminalAddress(key, address)) {
      result.keyboard = [...result.keyboard, [
        { text: '🎯 إدارة المخاطر', callback_data: `adv:r:${key}:${address}` },
        { text: '⚙️ مبالغ الشراء', callback_data: 'adv:pre' },
        { text: '👛 المحفظة', callback_data: 'adv:w' }
      ]];
    }
    return result;
  };

  const originalBuyPreview = TradingTerminal.prototype.buyPreview;
  TradingTerminal.prototype.buyPreview = async function(network, address) {
    const result = await originalBuyPreview.call(this, network, address);
    const key = normalizeTerminalNetwork(network);
    if (!result?.text || !isTerminalAddress(key, address)) return result;
    const code = await presetCode(this);
    result.text += `\n\n⚙️ الإعداد: ${BUY_PRESETS[code].label}`;
    result.keyboard = [
      ...amountKeyboard(code, key, address),
      [{ text: '🔎 تحليل', callback_data: `term:a:${key}:${address}` }, { text: '⚙️ مبالغ الشراء', callback_data: 'adv:pre' }],
      [{ text: '📊 المراكز', callback_data: 'term:p' }]
    ];
    return result;
  };

  const originalPositions = TradingTerminal.prototype.positions;
  TradingTerminal.prototype.positions = async function() {
    const result = await originalPositions.call(this);
    if (result?.keyboard) {
      result.keyboard = [...result.keyboard, [{ text: '👛 المحفظة', callback_data: 'adv:w' }, { text: '⚙️ مبالغ الشراء', callback_data: 'adv:pre' }]];
    }
    return result;
  };

  const originalHandle = TradingTerminal.prototype.handle;
  TradingTerminal.prototype.handle = async function(data) {
    const value = String(data ?? '');
    if (!value.startsWith('adv:')) return originalHandle.call(this, data);
    const parts = value.split(':');
    const action = parts[1] || '';
    try {
      if (action === 'w') return { handled: true, ...(await walletDashboard(this)) };
      if (action === 'pre' && parts.length === 2) return { handled: true, ...(await presetMenu(this)) };
      if (action === 'pre' && parts.length === 3) return { handled: true, ...(await setPreset(this, parts[2])) };
      if (action === 'r' && parts.length >= 4) return { handled: true, ...(await riskMenu(this, parts[2], parts.slice(3).join(':'))) };
      if (action === 'rp' && parts.length >= 5) return { handled: true, ...(await applyRiskPreset(this, parts[2], parts[3], parts.slice(4).join(':'))) };
      if (action === 'rl' && parts.length >= 4) return { handled: true, ...(await toggleRiskLadder(this, parts[2], parts.slice(3).join(':'))) };
      if (action === 'cp' && parts.length >= 4) return { handled: true, ...(await copyPreview(this, parts[2], parts.slice(3).join(':'))) };
      if (action === 'cb' && parts.length >= 5) return { handled: true, ...(await this.paperBuyConfirm(parts[2], parts[3], parts.slice(4).join(':'))) };
    } catch (error) {
      return { handled: true, text: `❌ خطأ في منصة التداول المتقدمة: ${String(error?.message ?? error).slice(0, 180)}`, keyboard: [[{ text: '📊 المراكز', callback_data: 'term:p' }]] };
    }
    return { handled: true, text: 'ℹ️ أمر غير معروف في منصة التداول المتقدمة.', keyboard: [[{ text: '📊 المراكز', callback_data: 'term:p' }]] };
  };

  startMonitor();
  console.log('SUMMECA ADVANCED TERMINAL: presets + Copy Preview + Paper TP/SL/Trailing + Wallet Dashboard');
}
