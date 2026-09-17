import { env } from '../config/env.mjs';
import { AppSettings } from '../storage/appSettings.mjs';
import { telegramApi } from '../notifiers/telegram.mjs';
import { TradingTerminal, normalizeTerminalNetwork, isTerminalAddress } from './tradingTerminal.mjs';

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
  c: { label: '🛡️ Cautious', amounts: [10, 25, 50, 100] },
  s: { label: '⚡ Standard', amounts: [25, 50, 100, 250] },
  h: { label: '🔥 High', amounts: [50, 100, 250, 500] }
};

const RISK_PRESETS = {
  f: { label: '⚡ Fast', takeProfitPct: 50, stopLossPct: 10, trailingPct: 15 },
  b: { label: '🛡️ Balanced', takeProfitPct: 100, stopLossPct: 15, trailingPct: 20 },
  m: { label: '🚀 Moon', takeProfitPct: 200, stopLossPct: 20, trailingPct: 25 },
  o: { label: '⏸ Off', takeProfitPct: 0, stopLossPct: 0, trailingPct: 0 }
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

async function riskMenu(instance, network, address) {
  const key = normalizeTerminalNetwork(network);
  if (!isTerminalAddress(key, address)) return { text: '❌ عنوان العقد أو الشبكة غير صالحين.', keyboard: [] };
  const rows = await loadRows(instance);
  const id = `${key}:${String(address).toLowerCase()}`;
  const position = rows.find((row) => row.id === id && row.status === 'open');
  if (!position) {
    return {
      text: `🎯 TP / SL / TRAILING\n\nلا يوجد Paper Position مفتوح للعقد ${short(address)}.\nافتح Buy أولًا ثم اختر خطة إدارة المخاطر.`,
      keyboard: [[{ text: '🟢 Buy', callback_data: `term:b:${key}:${address}` }, { text: '🔎 تحليل', callback_data: `term:a:${key}:${address}` }]]
    };
  }
  return {
    text: [
      `🎯 RISK MANAGER — ${NETWORKS[key]?.label || key}`,
      '',
      `$${position.symbol || 'TOKEN'} • ${short(address)}`,
      `Entry: ${priceText(position.entryPrice)}`,
      `TP: ${finite(position.takeProfitPct)}% | SL: ${finite(position.stopLossPct)}% | Trailing: ${finite(position.trailingPct)}%`,
      '',
      'اختر خطة. المراقب الآلي يعمل على Paper Position فقط.'
    ].join('\n'),
    keyboard: [
      [
        { text: '⚡ Fast 50/10/15', callback_data: `adv:rp:f:${key}:${address}` },
        { text: '🛡️ Balanced 100/15/20', callback_data: `adv:rp:b:${key}:${address}` }
      ],
      [
        { text: '🚀 Moon 200/20/25', callback_data: `adv:rp:m:${key}:${address}` },
        { text: '⏸ إيقاف', callback_data: `adv:rp:o:${key}:${address}` }
      ],
      [{ text: '📊 Positions', callback_data: 'term:p' }]
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
  if (!position) return { text: '❌ لا يوجد Paper Position مفتوح.', keyboard: [] };
  position.takeProfitPct = preset.takeProfitPct;
  position.stopLossPct = preset.stopLossPct;
  position.trailingPct = preset.trailingPct;
  position.peakPrice = Math.max(finite(position.peakPrice), finite(position.entryPrice));
  position.riskUpdatedAt = new Date().toISOString();
  await saveRows(instance, rows);
  return {
    text: [
      `✅ تم تطبيق ${preset.label}`,
      '',
      `$${position.symbol || 'TOKEN'} • ${NETWORKS[key]?.label || key}`,
      `TP +${preset.takeProfitPct}% | SL -${preset.stopLossPct}% | Trailing ${preset.trailingPct}%`,
      '',
      preset.takeProfitPct ? '🧪 المراقب سيغلق Paper Position تلقائيًا عند تحقق أول شرط.' : '⏸ تم إيقاف إدارة المخاطر الآلية لهذا المركز.'
    ].join('\n'),
    keyboard: [[{ text: '🎯 إدارة المخاطر', callback_data: `adv:r:${key}:${address}` }, { text: '📊 Positions', callback_data: 'term:p' }]]
  };
}

async function presetMenu(instance) {
  const active = await presetCode(instance);
  return {
    text: [
      '⚙️ BUY PRESETS — PAPER', '',
      `الحالي: ${BUY_PRESETS[active].label} → ${BUY_PRESETS[active].amounts.map((v) => `$${v}`).join(' / ')}`,
      '',
      'هذه القيم تُستخدم في Buy وCopy Preview. لا توجد صفقة حقيقية.'
    ].join('\n'),
    keyboard: [
      [{ text: '🛡️ $10/$25/$50/$100', callback_data: 'adv:pre:c' }],
      [{ text: '⚡ $25/$50/$100/$250', callback_data: 'adv:pre:s' }],
      [{ text: '🔥 $50/$100/$250/$500', callback_data: 'adv:pre:h' }],
      [{ text: '📊 Positions', callback_data: 'term:p' }]
    ]
  };
}

async function setPreset(instance, code) {
  const safe = await setPresetCode(instance, code);
  return {
    text: `✅ Buy Preset: ${BUY_PRESETS[safe].label}\n${BUY_PRESETS[safe].amounts.map((v) => `$${v}`).join(' / ')}\n\n🧪 Paper/Safe Mode فقط.`,
    keyboard: [[{ text: '⚙️ Presets', callback_data: 'adv:pre' }, { text: '📊 Positions', callback_data: 'term:p' }]]
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
      `🧠 COPY PREVIEW — ${NETWORKS[key]?.label || key}`,
      '',
      `${market ? `$${market.symbol}` : 'TOKEN'} • ${short(address)}`,
      market ? `السعر: ${priceText(market.priceUsd)} | السيولة: ${money(market.liquidityUsd)}` : 'السوق لم يظهر بشكل موثوق بعد.',
      `Preset: ${pack.label}`,
      '',
      'اختر مبلغًا. بعد ذلك ستظهر شاشة تأكيد أخيرة.',
      '🔒 لا يوجد Copy Trading أعمى أو تنفيذ تلقائي بأموال حقيقية.'
    ].join('\n'),
    keyboard: [
      ...amountKeyboard(code, key, address, 'adv:cb'),
      [{ text: '🔎 تحليل', callback_data: `term:a:${key}:${address}` }, { text: '⚙️ Presets', callback_data: 'adv:pre' }]
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
      if (lamports >= 0) balanceLine = `💰 SOL balance: ${(lamports / 1e9).toFixed(4)} SOL`;
    } catch {}
  }
  return {
    text: [
      '👛 SUMMECA WALLET DASHBOARD', '',
      `🔐 Wallet: ${address ? short(address) : 'غير مهيأة'}`,
      balanceLine,
      `📊 Paper Positions: ${open.length}`,
      `🧪 Paper capital open: ${money(cost)}`,
      `✅ Realized Paper PnL: ${realized >= 0 ? '+' : ''}${money(realized)}`,
      '',
      `🔒 LIVE_TRADING_ENABLED: ${env.liveTradingEnabled ? 'ON في البيئة، لكن Terminal لا يبث معاملات' : 'OFF'}`,
      'لا يتم عرض أي مفتاح خاص أو Secret داخل تيليجرام.'
    ].join('\n'),
    keyboard: [[{ text: '📊 Positions', callback_data: 'term:p' }, { text: '⚙️ Presets', callback_data: 'adv:pre' }]]
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
      '🤖🎯 SUMMECA PAPER AUTO-EXIT', '',
      `$${position.symbol || 'TOKEN'} • ${NETWORKS[position.network]?.label || position.network}`,
      `السبب: ${reason}`,
      `Exit: ${priceText(price)}`,
      `Paper PnL: ${pnl >= 0 ? '+' : ''}${money(pnl)}`,
      '',
      '🧪 هذه محاكاة فقط ولم تُرسل أي معاملة حقيقية.',
      `CA: ${position.address}`
    ].join('\n'),
    reply_markup: { inline_keyboard: [[{ text: '📊 Positions', callback_data: 'term:p' }, { text: '🔎 تحليل', callback_data: `term:a:${position.network}:${position.address}` }]] }
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
      if (!(tp > 0 || sl > 0 || trail > 0)) continue;
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
      let reason = '';
      if (sl > 0 && pnlPct <= -sl) reason = `STOP LOSS -${sl}%`;
      else if (tp > 0 && pnlPct >= tp) reason = `TAKE PROFIT +${tp}%`;
      else if (trail > 0 && peak >= entry * 1.10 && price <= peak * (1 - trail / 100)) reason = `TRAILING STOP ${trail}%`;
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
        { text: '🎯 TP/SL', callback_data: `adv:r:${key}:${address}` },
        { text: '⚙️ Presets', callback_data: 'adv:pre' },
        { text: '👛 Wallet', callback_data: 'adv:w' }
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
    result.text += `\n\n⚙️ Preset: ${BUY_PRESETS[code].label}`;
    result.keyboard = [
      ...amountKeyboard(code, key, address),
      [{ text: '🔎 تحليل', callback_data: `term:a:${key}:${address}` }, { text: '⚙️ Presets', callback_data: 'adv:pre' }],
      [{ text: '📊 Positions', callback_data: 'term:p' }]
    ];
    return result;
  };

  const originalPositions = TradingTerminal.prototype.positions;
  TradingTerminal.prototype.positions = async function() {
    const result = await originalPositions.call(this);
    if (result?.keyboard) {
      result.keyboard = [...result.keyboard, [{ text: '👛 Wallet', callback_data: 'adv:w' }, { text: '⚙️ Presets', callback_data: 'adv:pre' }]];
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
      if (action === 'cp' && parts.length >= 4) return { handled: true, ...(await copyPreview(this, parts[2], parts.slice(3).join(':'))) };
      if (action === 'cb' && parts.length >= 5) return { handled: true, ...(await this.paperBuyConfirm(parts[2], parts[3], parts.slice(4).join(':'))) };
    } catch (error) {
      return { handled: true, text: `❌ Advanced Terminal error: ${String(error?.message ?? error).slice(0, 180)}`, keyboard: [[{ text: '📊 Positions', callback_data: 'term:p' }]] };
    }
    return { handled: true, text: 'ℹ️ أمر Advanced Terminal غير معروف.', keyboard: [[{ text: '📊 Positions', callback_data: 'term:p' }]] };
  };

  startMonitor();
  console.log('SUMMECA ADVANCED TERMINAL: presets + Copy Preview + Paper TP/SL/Trailing + Wallet Dashboard');
}
