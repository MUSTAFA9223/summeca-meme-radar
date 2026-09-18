import { env } from '../config/env.mjs';

const SOLANA = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
const EVM = /^0x[0-9a-fA-F]{40}$/;
const POSITIONS_KEY = 'terminal_paper_positions_v1';
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const finite = (value, fallback = 0) => Number.isFinite(Number(value)) ? Number(value) : fallback;
const pct = (value) => `${finite(value).toFixed(1)}%`;
const money = (value) => {
  const n = finite(value);
  if (n >= 1_000_000_000) return `$${(n / 1_000_000_000).toFixed(2)}B`;
  if (n >= 1_000_000) return `$${(n / 1_000_000).toFixed(2)}M`;
  if (n >= 1_000) return `$${(n / 1_000).toFixed(1)}K`;
  return `$${n.toFixed(n >= 100 ? 0 : 2)}`;
};
const priceText = (value) => {
  const n = finite(value);
  if (n <= 0) return '—';
  return n >= 0.01 ? `$${n.toLocaleString('en-US', { maximumFractionDigits: 8 })}` : `$${n.toExponential(6)}`;
};
const short = (value) => {
  const text = String(value ?? '');
  return text.length > 15 ? `${text.slice(0, 7)}…${text.slice(-5)}` : text;
};

const NETWORKS = {
  sol: { label: 'SOLANA', dex: 'solana', kind: 'solana', explorer: 'https://solscan.io/token/' },
  bsc: { label: 'BNB CHAIN', dex: 'bsc', kind: 'evm', explorer: 'https://bscscan.com/token/' },
  arc: { label: 'ARC', dex: 'arc', kind: 'evm', explorer: 'https://explorer.arc.network/address/' },
  rh: { label: 'ROBINHOOD CHAIN', dex: 'robinhood', kind: 'evm', explorer: 'https://explorer.mainnet.chain.robinhood.com/address/' },
  robinhood: { label: 'ROBINHOOD CHAIN', dex: 'robinhood', kind: 'evm', explorer: 'https://explorer.mainnet.chain.robinhood.com/address/' }
};

export function normalizeTerminalNetwork(network) {
  const key = String(network ?? '').trim().toLowerCase();
  if (key === 'solana') return 'sol';
  if (key === 'bnb' || key === 'bnbchain') return 'bsc';
  if (key === 'robinhood') return 'rh';
  return NETWORKS[key] ? key : '';
}

export function isTerminalAddress(network, address) {
  const key = normalizeTerminalNetwork(network);
  if (!key) return false;
  return NETWORKS[key].kind === 'solana' ? SOLANA.test(String(address ?? '')) : EVM.test(String(address ?? ''));
}

export function terminalActionKeyboard(network, address, marketUrl = '') {
  const key = normalizeTerminalNetwork(network);
  const token = String(address ?? '');
  if (!isTerminalAddress(key, token)) return [];
  const rows = [
    [
      { text: '🔎 تحليل', callback_data: `term:a:${key}:${token}` },
      { text: '🟢 شراء', callback_data: `term:b:${key}:${token}` },
      { text: '🔴 بيع', callback_data: `term:s:${key}:${token}` }
    ],
    [
      { text: '📊 المراكز', callback_data: 'term:p' },
      { text: '📋 نسخ العقد', copy_text: { text: token } }
    ]
  ];
  if (marketUrl) rows.push([{ text: '📈 السوق', url: marketUrl }]);
  return rows;
}

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

async function dexMarket(network, address) {
  const key = normalizeTerminalNetwork(network);
  const config = NETWORKS[key];
  if (!config) return null;
  const body = await fetchJson(`https://api.dexscreener.com/tokens/v1/${encodeURIComponent(config.dex)}/${encodeURIComponent(address)}`, {
    headers: { accept: 'application/json' }
  }).catch(() => []);
  const rows = Array.isArray(body) ? body : [];
  const pairs = rows.filter((row) => String(row?.chainId ?? '').toLowerCase() === config.dex.toLowerCase());
  const pair = pairs.sort((a, b) => finite(b?.liquidity?.usd) - finite(a?.liquidity?.usd))[0] || rows[0];
  if (!pair) return null;
  const base = String(pair?.baseToken?.address ?? '');
  const token = base.toLowerCase() === String(address).toLowerCase() ? pair.baseToken : pair.quoteToken;
  return {
    symbol: token?.symbol || 'TOKEN',
    name: token?.name || token?.symbol || 'Token',
    priceUsd: finite(pair?.priceUsd),
    liquidityUsd: finite(pair?.liquidity?.usd),
    marketCapUsd: finite(pair?.marketCap, finite(pair?.fdv)),
    volume5mUsd: finite(pair?.volume?.m5),
    volume1hUsd: finite(pair?.volume?.h1),
    buys5m: finite(pair?.txns?.m5?.buys),
    sells5m: finite(pair?.txns?.m5?.sells),
    priceChange5mPct: finite(pair?.priceChange?.m5),
    priceChange1hPct: finite(pair?.priceChange?.h1),
    url: pair?.url || '',
    pairCreatedAt: finite(pair?.pairCreatedAt)
  };
}

async function solanaRpc(method, params) {
  const body = await fetchJson('https://api.mainnet-beta.solana.com', {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 'summeca-terminal', method, params })
  }, 5_000);
  if (body?.error) throw new Error(body.error.message || 'Solana RPC error');
  return body?.result ?? null;
}

async function solanaHolderStats(mint) {
  if (!SOLANA.test(mint)) return null;
  try {
    const [supplyResult, largestResult] = await Promise.all([
      solanaRpc('getTokenSupply', [mint, { commitment: 'processed' }]),
      solanaRpc('getTokenLargestAccounts', [mint, { commitment: 'processed' }])
    ]);
    const supply = finite(supplyResult?.value?.uiAmountString ?? supplyResult?.value?.uiAmount);
    const rows = Array.isArray(largestResult?.value) ? largestResult.value : [];
    const amounts = rows.map((row) => finite(row?.uiAmountString ?? row?.uiAmount)).filter((n) => n > 0);
    if (!(supply > 0) || !amounts.length) return null;
    const shares = amounts.map((amount) => amount / supply * 100);
    return {
      tokenAccounts: amounts.length,
      largestPct: shares[0] || 0,
      top5Pct: shares.slice(0, 5).reduce((sum, value) => sum + value, 0),
      top10Pct: shares.slice(0, 10).reduce((sum, value) => sum + value, 0)
    };
  } catch (error) {
    return { error: String(error?.message ?? error) };
  }
}

function scoreMarket(market, holders) {
  if (!market) return { score: 0, reasons: ['لا توجد بيانات سوق مؤكدة بعد'] };
  let score = 0;
  const reasons = [];
  const ratio = market.buys5m / Math.max(1, market.sells5m);

  if (market.liquidityUsd >= 25_000) score += 18;
  else if (market.liquidityUsd >= 10_000) score += 12;
  else if (market.liquidityUsd >= 5_000) score += 7;
  else reasons.push('سيولة منخفضة');

  if (market.buys5m >= 20) score += 18;
  else if (market.buys5m >= 8) score += 13;
  else if (market.buys5m >= 4) score += 7;
  else reasons.push('شراء مبكر ضعيف');

  if (ratio >= 2.5) score += 14;
  else if (ratio >= 1.6) score += 10;
  else if (ratio >= 1.2) score += 5;
  else reasons.push('نسبة الشراء/البيع ضعيفة');

  if (market.volume5mUsd >= 5_000) score += 14;
  else if (market.volume5mUsd >= 1_500) score += 10;
  else if (market.volume5mUsd >= 500) score += 5;
  else reasons.push('حجم التداول المبكر ضعيف');

  if (market.marketCapUsd > 0 && market.marketCapUsd <= 750_000) score += 12;
  else if (market.marketCapUsd > 0 && market.marketCapUsd <= 1_500_000) score += 8;
  else if (market.marketCapUsd > 3_000_000) reasons.push('Market Cap مرتفع للدخول المبكر');

  if (market.priceChange5mPct <= 35) score += 8;
  else if (market.priceChange5mPct <= 60) score += 3;
  else reasons.push('السعر تحرك كثيرًا قبل التنبيه');

  if (holders && !holders.error) {
    if (holders.largestPct <= 12) score += 6; else reasons.push('أكبر حساب توكن مركز جدًا');
    if (holders.top5Pct <= 30) score += 5; else reasons.push('Top 5 تركّز مرتفع');
    if (holders.top10Pct <= 45) score += 5; else reasons.push('Top 10 تركّز مرتفع');
  }

  return { score: Math.min(100, Math.round(score)), reasons };
}

function riskLabel(score) {
  if (score >= 86) return '💎 إشارة قوية جدًا';
  if (score >= 72) return '✅ مؤهلة';
  if (score >= 55) return '👀 مراقبة';
  return '⚠️ مخاطرة مرتفعة';
}

export class TradingTerminal {
  constructor(settings) {
    this.settings = settings;
    this.memoryPositions = [];
  }

  async #loadPositions() {
    if (!this.settings?.enabled) return this.memoryPositions;
    try {
      const raw = await this.settings.get(POSITIONS_KEY);
      const parsed = raw ? JSON.parse(String(raw)) : [];
      return Array.isArray(parsed) ? parsed.slice(0, 50) : [];
    } catch {
      return this.memoryPositions;
    }
  }

  async #savePositions(rows) {
    this.memoryPositions = rows.slice(0, 50);
    if (this.settings?.enabled) await this.settings.set(POSITIONS_KEY, JSON.stringify(this.memoryPositions)).catch(() => {});
  }

  async analyze(network, address) {
    const key = normalizeTerminalNetwork(network);
    if (!isTerminalAddress(key, address)) return { text: '❌ عنوان العقد أو الشبكة غير صالحين.', keyboard: [] };
    const config = NETWORKS[key];
    const market = await dexMarket(key, address).catch(() => null);
    const holders = key === 'sol' ? await solanaHolderStats(address) : null;
    const quality = scoreMarket(market, holders);
    const ratio = market ? market.buys5m / Math.max(1, market.sells5m) : 0;
    const holderLines = key === 'sol'
      ? holders && !holders.error
        ? [
            `🐋 أكبر حساب توكن: ${pct(holders.largestPct)}`,
            `👥 أكبر 5 حسابات: ${pct(holders.top5Pct)}`,
            `👥 أكبر 10 حسابات: ${pct(holders.top10Pct)}`,
            'ℹ️ هذه حسابات توكن وليست بالضرورة محافظ بشرية فريدة.'
          ]
        : ['👥 توزيع الحيازة: غير متاح مؤقتًا من RPC']
      : ['👥 فحص الحيازة المفصل لهذه الشبكة سيضاف عبر indexer مخصص؛ حاليًا نعتمد بيانات السوق والمحافظ المتتبعة.'];

    const lines = [
      `🔎 تحليل العملة في SUMMECA — ${config.label}`,
      '',
      `${market ? `$${market.symbol}` : 'TOKEN'} • ${short(address)}`,
      `🎯 درجة الجودة: ${quality.score}/100 • ${riskLabel(quality.score)}`,
      market ? `💵 السعر: ${priceText(market.priceUsd)}` : '💵 السعر: لم يظهر بعد',
      market ? `💧 السيولة: ${money(market.liquidityUsd)} | القيمة السوقية: ${money(market.marketCapUsd)}` : '',
      market ? `⚡ 5m شراء ${market.buys5m} / بيع ${market.sells5m} | النسبة ${ratio.toFixed(2)}x` : '',
      market ? `📊 حجم 5 دقائق: ${money(market.volume5mUsd)} | حركة 5 دقائق: ${pct(market.priceChange5mPct)}` : '',
      ...holderLines,
      quality.reasons.length ? `⚠️ ملاحظات: ${quality.reasons.slice(0, 4).join(' • ')}` : '🛡️ لا توجد ملاحظات رئيسية من الفلاتر المتاحة.',
      '',
      '⚠️ التحليل يقلل المخاطر ولا يتنبأ بالسعر أو يضمن الربح.',
      `العقد: ${address}`
    ].filter(Boolean).join('\n');

    return { text: lines, keyboard: terminalActionKeyboard(key, address, market?.url || '') };
  }

  async buyPreview(network, address) {
    const key = normalizeTerminalNetwork(network);
    if (!isTerminalAddress(key, address)) return { text: '❌ عنوان العقد أو الشبكة غير صالحين.', keyboard: [] };
    const market = await dexMarket(key, address).catch(() => null);
    const label = NETWORKS[key].label;
    const buttons = [25, 50, 100, 250].map((amount) => ({ text: `$${amount}`, callback_data: `term:bp:${amount}:${key}:${address}` }));
    return {
      text: [
        `🟢 معاينة الشراء — ${label}`,
        '',
        `${market ? `$${market.symbol}` : 'TOKEN'} • ${short(address)}`,
        `السعر الحالي: ${market ? priceText(market.priceUsd) : 'غير متاح'}`,
        `السيولة: ${market ? money(market.liquidityUsd) : 'غير متاحة'}`,
        '',
        'اختر مبلغًا لمعاينة الصفقة في الوضع التجريبي.',
        `🔒 التداول الحقيقي من هذه الواجهة: ${env.liveTradingEnabled ? 'مهيأ بالمحرك لكن غير منفّذ من Terminal الآمن' : 'مقفل'}`,
        'لن يتم توقيع أو إرسال أي معاملة حقيقية من هذه الشاشة.'
      ].join('\n'),
      keyboard: [buttons.slice(0, 2), buttons.slice(2), [{ text: '🔎 تحليل', callback_data: `term:a:${key}:${address}` }, { text: '⬅️ إلغاء', callback_data: 'term:p' }]]
    };
  }

  async paperBuyConfirm(amountUsd, network, address) {
    const key = normalizeTerminalNetwork(network);
    const amount = finite(amountUsd);
    if (!isTerminalAddress(key, address) || amount <= 0 || amount > 5_000) return { text: '❌ بيانات الصفقة غير صالحة.', keyboard: [] };
    const market = await dexMarket(key, address).catch(() => null);
    if (!market?.priceUsd) return { text: '❌ لا يوجد سعر سوق موثوق حاليًا لإجراء شراء تجريبي.', keyboard: terminalActionKeyboard(key, address, market?.url || '') };
    return {
      text: [
        '🧪 تأكيد الشراء التجريبي', '',
        `${NETWORKS[key].label} • $${market.symbol}`,
        `المبلغ: $${amount.toFixed(2)}`,
        `السعر المرجعي: ${priceText(market.priceUsd)}`,
        `الكمية التقريبية: ${(amount / market.priceUsd).toLocaleString('en-US', { maximumFractionDigits: 4 })}`,
        '',
        'هذه محاكاة فقط ولا تستخدم أموالًا حقيقية.'
      ].join('\n'),
      keyboard: [[
        { text: '✅ تأكيد الشراء التجريبي', callback_data: `term:bc:${amount}:${key}:${address}` },
        { text: '❌ إلغاء', callback_data: `term:a:${key}:${address}` }
      ]]
    };
  }

  async paperBuy(amountUsd, network, address) {
    const key = normalizeTerminalNetwork(network);
    const amount = finite(amountUsd);
    const market = await dexMarket(key, address).catch(() => null);
    if (!market?.priceUsd) return { text: '❌ تعذر تنفيذ الشراء التجريبي لعدم توفر سعر السوق.', keyboard: terminalActionKeyboard(key, address, market?.url || '') };
    const rows = await this.#loadPositions();
    const id = `${key}:${String(address).toLowerCase()}`;
    const existing = rows.find((row) => row.id === id && row.status === 'open');
    const qty = amount / market.priceUsd;
    if (existing) {
      const oldCost = finite(existing.costUsd);
      const oldQty = finite(existing.qty);
      existing.costUsd = oldCost + amount;
      existing.qty = oldQty + qty;
      existing.entryPrice = existing.costUsd / Math.max(existing.qty, 1e-18);
      existing.updatedAt = new Date().toISOString();
      existing.symbol = market.symbol;
    } else {
      rows.unshift({
        id, network: key, address, symbol: market.symbol, status: 'open',
        entryPrice: market.priceUsd, qty, costUsd: amount, realizedPnlUsd: 0,
        createdAt: new Date().toISOString(), updatedAt: new Date().toISOString()
      });
    }
    await this.#savePositions(rows);
    return {
      text: `✅ تم الشراء التجريبي\n\n$${market.symbol} • ${NETWORKS[key].label}\nالمبلغ: $${amount.toFixed(2)}\nالسعر: ${priceText(market.priceUsd)}\n\nلم تُستخدم أموال حقيقية.`,
      keyboard: [[{ text: '📊 المراكز', callback_data: 'term:p' }, { text: '🔎 تحليل', callback_data: `term:a:${key}:${address}` }]]
    };
  }

  async sellPreview(network, address) {
    const key = normalizeTerminalNetwork(network);
    if (!isTerminalAddress(key, address)) return { text: '❌ عنوان العقد أو الشبكة غير صالحين.', keyboard: [] };
    const rows = await this.#loadPositions();
    const id = `${key}:${String(address).toLowerCase()}`;
    const position = rows.find((row) => row.id === id && row.status === 'open');
    if (!position) {
      return {
        text: `🔴 بيع — ${NETWORKS[key].label}\n\nلا يوجد مركز تجريبي مفتوح لهذا العقد.\nالتداول الحقيقي ما زال مقفولًا من Terminal الآمن.`,
        keyboard: terminalActionKeyboard(key, address)
      };
    }
    return {
      text: `🔴 معاينة البيع — تجريبي\n\n$${position.symbol} • ${NETWORKS[key].label}\nاختر نسبة الإغلاق:`,
      keyboard: [[25, 50, 100].map((part) => ({ text: `${part}%`, callback_data: `term:sp:${part}:${key}:${address}` }))]
    };
  }

  async paperSellConfirm(partPct, network, address) {
    const key = normalizeTerminalNetwork(network);
    const part = Math.max(1, Math.min(100, finite(partPct)));
    const rows = await this.#loadPositions();
    const id = `${key}:${String(address).toLowerCase()}`;
    const position = rows.find((row) => row.id === id && row.status === 'open');
    if (!position) return { text: '❌ لا يوجد مركز مفتوح.', keyboard: [] };
    const market = await dexMarket(key, address).catch(() => null);
    if (!market?.priceUsd) return { text: '❌ لا يتوفر سعر حالي لتأكيد البيع.', keyboard: [] };
    const sellQty = finite(position.qty) * (part / 100);
    const proceeds = sellQty * market.priceUsd;
    const costPart = finite(position.costUsd) * (part / 100);
    const pnl = proceeds - costPart;
    return {
      text: [
        '🧪 تأكيد البيع التجريبي', '',
        `$${position.symbol} • ${NETWORKS[key].label}`,
        `النسبة: ${part}%`,
        `السعر الحالي: ${priceText(market.priceUsd)}`,
        `PnL تقريبي لهذه الكمية: ${pnl >= 0 ? '+' : ''}${money(pnl)}`,
        '',
        'هذه محاكاة فقط.'
      ].join('\n'),
      keyboard: [[
        { text: '✅ تأكيد الشراء التجريبي Sell', callback_data: `term:sc:${part}:${key}:${address}` },
        { text: '❌ إلغاء', callback_data: 'term:p' }
      ]]
    };
  }

  async paperSell(partPct, network, address) {
    const key = normalizeTerminalNetwork(network);
    const part = Math.max(1, Math.min(100, finite(partPct)));
    const rows = await this.#loadPositions();
    const id = `${key}:${String(address).toLowerCase()}`;
    const position = rows.find((row) => row.id === id && row.status === 'open');
    if (!position) return { text: '❌ لا يوجد مركز مفتوح.', keyboard: [] };
    const market = await dexMarket(key, address).catch(() => null);
    if (!market?.priceUsd) return { text: '❌ تعذر قراءة السعر الحالي.', keyboard: [] };
    const soldQty = finite(position.qty) * (part / 100);
    const costPart = finite(position.costUsd) * (part / 100);
    const proceeds = soldQty * market.priceUsd;
    const pnl = proceeds - costPart;
    position.qty = Math.max(0, finite(position.qty) - soldQty);
    position.costUsd = Math.max(0, finite(position.costUsd) - costPart);
    position.realizedPnlUsd = finite(position.realizedPnlUsd) + pnl;
    position.updatedAt = new Date().toISOString();
    if (part >= 100 || position.qty <= 1e-18) position.status = 'closed';
    await this.#savePositions(rows);
    return {
      text: `✅ PAPER SELL تم\n\n$${position.symbol} • ${part}%\nالسعر: ${priceText(market.priceUsd)}\nPnL: ${pnl >= 0 ? '+' : ''}${money(pnl)}\n\nمحاكاة فقط.`,
      keyboard: [[{ text: '📊 المراكز', callback_data: 'term:p' }]]
    };
  }

  async positions() {
    const rows = (await this.#loadPositions()).filter((row) => row.status === 'open').slice(0, 8);
    if (!rows.length) {
      return {
        text: [
          '📊 مراكز SUMMECA', '',
          'لا توجد مراكز تجريبية مفتوحة حاليًا.',
          `🔒 Live Trading: ${env.liveTradingEnabled ? 'المحرك مهيأ لكن Terminal الآمن لا ينفذ معاملات' : 'مقفل'}`,
          '',
          'افتح أي إشارة واضغط Buy لتجربة المسار كاملًا بدون أموال حقيقية.'
        ].join('\n'),
        keyboard: [[{ text: '🏠 القائمة', callback_data: 'menu:home' }]]
      };
    }

    const lines = ['📊 مراكز SUMMECA — PAPER', ''];
    const keyboard = [];
    for (const row of rows) {
      const market = await dexMarket(row.network, row.address).catch(() => null);
      const current = finite(market?.priceUsd);
      const value = current > 0 ? finite(row.qty) * current : 0;
      const unrealized = current > 0 ? value - finite(row.costUsd) : 0;
      const pnlPct = finite(row.costUsd) > 0 ? unrealized / finite(row.costUsd) * 100 : 0;
      lines.push(`• $${row.symbol} • ${NETWORKS[row.network]?.label || row.network}`);
      lines.push(`  Entry ${priceText(row.entryPrice)} → Now ${current > 0 ? priceText(current) : '—'}`);
      lines.push(`  PnL ${unrealized >= 0 ? '+' : ''}${money(unrealized)} (${pnlPct >= 0 ? '+' : ''}${pct(pnlPct)})`);
      keyboard.push([
        { text: `🔎 ${row.symbol}`, callback_data: `term:a:${row.network}:${row.address}` },
        { text: `🔴 بيع ${row.symbol}`, callback_data: `term:s:${row.network}:${row.address}` }
      ]);
      await wait(80);
    }
    lines.push('', '🧪 جميع المراكز أعلاه تجريبية فقط.');
    keyboard.push([{ text: '🏠 القائمة', callback_data: 'menu:home' }]);
    return { text: lines.join('\n'), keyboard };
  }

  async handle(data) {
    const value = String(data ?? '');
    if (value === 'term:p') return { handled: true, ...(await this.positions()) };
    const parts = value.split(':');
    if (parts[0] !== 'term') return { handled: false };
    const action = parts[1];
    try {
      if (action === 'a' && parts.length >= 4) return { handled: true, ...(await this.analyze(parts[2], parts.slice(3).join(':'))) };
      if (action === 'b' && parts.length >= 4) return { handled: true, ...(await this.buyPreview(parts[2], parts.slice(3).join(':'))) };
      if (action === 's' && parts.length >= 4) return { handled: true, ...(await this.sellPreview(parts[2], parts.slice(3).join(':'))) };
      if (action === 'bp' && parts.length >= 5) return { handled: true, ...(await this.paperBuyConfirm(parts[2], parts[3], parts.slice(4).join(':'))) };
      if (action === 'bc' && parts.length >= 5) return { handled: true, ...(await this.paperBuy(parts[2], parts[3], parts.slice(4).join(':'))) };
      if (action === 'sp' && parts.length >= 5) return { handled: true, ...(await this.paperSellConfirm(parts[2], parts[3], parts.slice(4).join(':'))) };
      if (action === 'sc' && parts.length >= 5) return { handled: true, ...(await this.paperSell(parts[2], parts[3], parts.slice(4).join(':'))) };
    } catch (error) {
      return { handled: true, text: `❌ خطأ في منصة التداول: ${String(error?.message ?? error).slice(0, 180)}`, keyboard: [[{ text: '🏠 القائمة', callback_data: 'menu:home' }]] };
    }
    return { handled: true, text: 'ℹ️ أمر منصة التداول غير معروف.', keyboard: [[{ text: '🏠 القائمة', callback_data: 'menu:home' }]] };
  }
}
