import { env } from '../config/env.mjs';
import { TradingTerminal, normalizeTerminalNetwork, isTerminalAddress } from './tradingTerminal.mjs';

const finite = (value, fallback = 0) => Number.isFinite(Number(value)) ? Number(value) : fallback;
const short = (value) => { const s = String(value ?? ''); return s.length > 16 ? `${s.slice(0, 7)}…${s.slice(-5)}` : s; };
const money = (value) => { const n = finite(value); if (Math.abs(n) >= 1e6) return `$${(n / 1e6).toFixed(2)}M`; if (Math.abs(n) >= 1e3) return `$${(n / 1e3).toFixed(1)}K`; return `$${n.toFixed(2)}`; };
const pct = (value) => `${finite(value).toFixed(2)}%`;
const WSOL = 'So11111111111111111111111111111111111111112';
const NETWORKS = {
  sol: { label: 'SOLANA', dex: 'solana' },
  bsc: { label: 'BNB CHAIN', dex: 'bsc', goPlus: '56' },
  arc: { label: 'ARC', dex: 'arc', goPlus: '5042' },
  rh: { label: 'ROBINHOOD CHAIN', dex: 'robinhood', goPlus: '4663' }
};

async function fetchJson(url, options = {}, timeoutMs = 7_000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, { ...options, signal: controller.signal });
    const body = await response.json().catch(() => null);
    if (!response.ok) throw new Error(body?.error || body?.message || `HTTP ${response.status}`);
    return body;
  } finally { clearTimeout(timer); }
}

async function marketFor(network, address) {
  const cfg = NETWORKS[network];
  if (!cfg) return null;
  const body = await fetchJson(`https://api.dexscreener.com/tokens/v1/${encodeURIComponent(cfg.dex)}/${encodeURIComponent(address)}`, { headers: { accept: 'application/json' } }).catch(() => []);
  const rows = Array.isArray(body) ? body : [];
  const pair = rows.filter((r) => String(r?.chainId ?? '').toLowerCase() === cfg.dex).sort((a, b) => finite(b?.liquidity?.usd) - finite(a?.liquidity?.usd))[0] || rows[0];
  if (!pair) return null;
  const base = String(pair?.baseToken?.address ?? '').toLowerCase();
  const token = base === String(address).toLowerCase() ? pair.baseToken : pair.quoteToken;
  return {
    symbol: token?.symbol || 'TOKEN', priceUsd: finite(pair?.priceUsd), liquidityUsd: finite(pair?.liquidity?.usd),
    marketCapUsd: finite(pair?.marketCap, finite(pair?.fdv)), buys5m: finite(pair?.txns?.m5?.buys), sells5m: finite(pair?.txns?.m5?.sells),
    priceChange5mPct: finite(pair?.priceChange?.m5), pairAddress: String(pair?.pairAddress ?? ''), dexId: String(pair?.dexId ?? ''), url: String(pair?.url ?? '')
  };
}

async function evmInsiderRisk(network, address) {
  const cfg = NETWORKS[network];
  const out = { verified: false, creator: '', creatorPct: null, owner: '', ownerPct: null, top10Pct: null, lpTopPct: null, flags: [], notes: [] };
  if (!cfg?.goPlus) return out;
  try {
    const qs = new URLSearchParams({ contract_addresses: address });
    const body = await fetchJson(`https://api.gopluslabs.io/api/v1/token_security/${cfg.goPlus}?${qs}`, { headers: { accept: 'application/json' } });
    const row = body?.result?.[String(address).toLowerCase()] ?? body?.result?.[address];
    if (!row) return out;
    out.verified = true;
    out.creator = String(row.creator_address || '');
    out.owner = String(row.owner_address || '');
    out.creatorPct = row.creator_percent == null ? null : finite(row.creator_percent) * 100;
    out.ownerPct = row.owner_percent == null ? null : finite(row.owner_percent) * 100;
    const holders = Array.isArray(row.holders) ? row.holders : [];
    const shares = holders.map((h) => finite(h?.percent) * 100).filter(Number.isFinite).sort((a, b) => b - a);
    out.top10Pct = shares.length ? shares.slice(0, 10).reduce((a, b) => a + b, 0) : null;
    const lp = Array.isArray(row.lp_holders) ? row.lp_holders : [];
    const lpShares = lp.map((h) => finite(h?.percent) * 100).filter(Number.isFinite).sort((a, b) => b - a);
    out.lpTopPct = lpShares[0] ?? null;
    const risky = [
      ['is_mintable', 'mintable'], ['transfer_pausable', 'transfer-pausable'], ['slippage_modifiable', 'slippage-modifiable'],
      ['personal_slippage_modifiable', 'personal-slippage'], ['trading_cooldown', 'trading-cooldown'],
      ['honeypot_with_same_creator', 'same-creator-honeypot-history'], ['owner_change_balance', 'owner-change-balance'],
      ['hidden_owner', 'hidden-owner'], ['can_take_back_ownership', 'ownership-reclaimable']
    ];
    for (const [key, label] of risky) if (String(row?.[key] ?? '') === '1') out.flags.push(label);
    if (out.creatorPct != null && out.creatorPct > 10) out.flags.push('creator-high-balance');
    if (out.ownerPct != null && out.ownerPct > 10) out.flags.push('owner-high-balance');
    if (out.top10Pct != null && out.top10Pct > 60) out.flags.push('top10-concentrated');
    if (out.lpTopPct != null && out.lpTopPct > 95) out.notes.push('LP highly concentrated — verify lock/burn separately');
  } catch { out.notes.push('GoPlus creator/owner data unavailable'); }
  return out;
}

async function solanaRpc(method, params) {
  const body = await fetchJson('https://api.mainnet-beta.solana.com', {
    method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: `p5-${Date.now()}`, method, params })
  });
  if (body?.error) throw new Error(body.error.message || `RPC ${body.error.code}`);
  return body?.result;
}

async function solanaInsiderRisk(address) {
  const out = { verified: [], flags: [], notes: [], top1Pct: null, top5Pct: null, top10Pct: null, mintAuthority: null, freezeAuthority: null };
  const [supplyResult, largestResult, mintResult] = await Promise.allSettled([
    solanaRpc('getTokenSupply', [address, { commitment: 'processed' }]),
    solanaRpc('getTokenLargestAccounts', [address, { commitment: 'processed' }]),
    solanaRpc('getAccountInfo', [address, { encoding: 'jsonParsed', commitment: 'processed' }])
  ]);
  const supply = supplyResult.status === 'fulfilled' ? finite(supplyResult.value?.value?.uiAmountString) : 0;
  const largest = largestResult.status === 'fulfilled' ? (largestResult.value?.value || []) : [];
  if (supply > 0 && Array.isArray(largest) && largest.length) {
    const shares = largest.map((r) => finite(r?.uiAmountString) / supply * 100).filter(Number.isFinite);
    out.top1Pct = shares[0] ?? null;
    out.top5Pct = shares.slice(0, 5).reduce((a, b) => a + b, 0);
    out.top10Pct = shares.slice(0, 10).reduce((a, b) => a + b, 0);
    out.verified.push('largest token accounts');
    if (out.top1Pct > 15) out.flags.push('top1-concentrated');
    if (out.top5Pct > 40) out.flags.push('top5-concentrated');
    if (out.top10Pct > 60) out.flags.push('top10-concentrated');
  }
  if (mintResult.status === 'fulfilled') {
    const info = mintResult.value?.value?.data?.parsed?.info;
    if (info) {
      out.mintAuthority = info.mintAuthority ?? null;
      out.freezeAuthority = info.freezeAuthority ?? null;
      out.verified.push('mint/freeze authority');
      if (out.mintAuthority) out.flags.push('mint-authority-active');
      if (out.freezeAuthority) out.flags.push('freeze-authority-active');
    }
  }
  out.notes.push('Creator/deployer identity and linked-wallet/bundle attribution are not claimed unless independently verifiable.');
  return out;
}

async function insiderRisk(network, address) {
  const key = normalizeTerminalNetwork(network);
  if (!isTerminalAddress(key, address)) return { text: '❌ عقد أو شبكة غير صالحين.', keyboard: [] };
  const market = await marketFor(key, address).catch(() => null);
  const risk = key === 'sol' ? await solanaInsiderRisk(address) : await evmInsiderRisk(key, address);
  const flags = risk.flags || [];
  const severe = flags.filter((f) => /honeypot|owner-change|mintable|freeze|mint-authority/.test(f)).length;
  const level = severe ? '🔴 مرتفع' : flags.length >= 2 ? '🟠 فوق المتوسط' : flags.length === 1 ? '🟡 مراقبة' : '🟢 لا توجد علامة خطر';
  const lines = [
    `🕵️ مخاطر المطور والمحافظ الداخلية — ${NETWORKS[key]?.label || key}`, '',
    `${market ? `$${market.symbol}` : 'TOKEN'} • ${short(address)}`,
    `تقييم المخاطر: ${level}`,
    market ? `السيولة ${money(market.liquidityUsd)} | القيمة السوقية ${money(market.marketCapUsd)}` : 'لقطة السوق غير متاحة', ''
  ];
  if (key === 'sol') {
    if (risk.top1Pct != null) lines.push(`👥 أكبر محفظة ${pct(risk.top1Pct)} | أكبر 5 ${pct(risk.top5Pct)} | أكبر 10 ${pct(risk.top10Pct)}`);
    lines.push(`🪙 Mint authority: ${risk.mintAuthority ? 'نشط ⚠️' : 'غير موجود/معطل ✅'}`, `🧊 Freeze authority: ${risk.freezeAuthority ? 'نشط ⚠️' : 'غير موجود/معطل ✅'}`);
  } else {
    lines.push(`🧑‍💻 Creator: ${risk.creator ? short(risk.creator) : 'غير معروف'}${risk.creatorPct == null ? '' : ` • ${pct(risk.creatorPct)}`}`,
      `👑 Owner: ${risk.owner ? short(risk.owner) : 'غير معروف'}${risk.ownerPct == null ? '' : ` • ${pct(risk.ownerPct)}`}`);
    if (risk.top10Pct != null) lines.push(`👥 أكبر 10 حائزين: ${pct(risk.top10Pct)}`);
    if (risk.lpTopPct != null) lines.push(`💧 أكبر حائز للسيولة: ${pct(risk.lpTopPct)}`);
  }
  lines.push('', flags.length ? `⚠️ Flags: ${[...new Set(flags)].join(', ')}` : '✅ لم تظهر علامة خطر للمطور أو المحافظ الداخلية ضمن الأدلة المتاحة.');
  for (const note of risk.notes || []) lines.push(`ℹ️ ${note}`);
  lines.push('', 'هذا فحص أدلة، وليس إثباتًا أن المطور حسن/سيئ النية.');
  return { text: lines.join('\n'), keyboard: [[{ text: '🛡️ الأمان المتقدم', callback_data: `p4:s:${key}:${address}` }, { text: '🧾 محاكاة مسار الصفقة', callback_data: `p5:q:${key}:${address}` }], [{ text: '🔎 تحليل', callback_data: `term:a:${key}:${address}` }]] };
}

async function jupiterQuote(outputMint) {
  const params = new URLSearchParams({ inputMint: WSOL, outputMint, amount: '100000000', slippageBps: '500', restrictIntermediateTokens: 'true' });
  const headers = { accept: 'application/json' };
  if (process.env.JUPITER_API_KEY) headers['x-api-key'] = process.env.JUPITER_API_KEY;
  return fetchJson(`https://api.jup.ag/swap/v1/quote?${params}`, { headers }, 8_000);
}

function estimateEvmImpact(amountUsd, liquidityUsd) {
  if (!(amountUsd > 0 && liquidityUsd > 0)) return null;
  return Math.min(100, amountUsd / Math.max(1, liquidityUsd * 2) * 100);
}

async function routeSimulation(network, address) {
  const key = normalizeTerminalNetwork(network);
  if (!isTerminalAddress(key, address)) return { text: '❌ عقد غير صالح.', keyboard: [] };
  const market = await marketFor(key, address).catch(() => null);
  const lines = [`🧾 محاكاة المسار والسعر — ${NETWORKS[key]?.label || key}`, '', `${market ? `$${market.symbol}` : 'TOKEN'} • ${short(address)}`, '🔒 عرض سعر فقط — بلا توقيع أو إنشاء أو إرسال معاملة.', ''];
  if (key === 'sol') {
    try {
      const quote = await jupiterQuote(address);
      const outAmount = String(quote?.outAmount || '0');
      const priceImpact = finite(quote?.priceImpactPct) * 100;
      const routeLabels = Array.isArray(quote?.routePlan) ? quote.routePlan.map((r) => r?.swapInfo?.label).filter(Boolean) : [];
      lines.push('المبلغ المدخل: 0.1000 SOL', `المخرجات الخام: ${outAmount}`, `تأثير السعر: ${priceImpact.toFixed(3)}%`, `حد الانزلاق: 5.00%`, `Route: ${routeLabels.length ? [...new Set(routeLabels)].join(' → ') : 'provider route returned'}`, '✅ تم استلام عرض سعر من Jupiter.');
    } catch (error) {
      lines.push(`🟡 عرض Jupiter غير متاح: ${String(error?.message ?? error).slice(0, 120)}`, 'لم يتم إنشاء أو توقيع أي معاملة.');
    }
  } else {
    const amountUsd = 100;
    const impact = estimateEvmImpact(amountUsd, finite(market?.liquidityUsd));
    lines.push(`حجم المحاكاة: ${money(amountUsd)}`, market ? `Pool/Dex: ${market.dexId || 'DEX'} • liquidity ${money(market.liquidityUsd)}` : 'DEX pool not visible', impact == null ? 'تأثير السعر المقدر: غير متاح' : `تأثير السيولة المقدر: ~${impact.toFixed(3)}%`, 'ℹ️ هذا تقدير سيولة فقط وليس عرضًا ملزمًا. التوقيع والتنفيذ على شبكات EVM غير متصلين حاليًا.');
  }
  lines.push('', '✅ جاهزية آمنة: هذه الشاشة لا تملك صلاحية إرسال الأموال.');
  return { text: lines.join('\n'), keyboard: [[{ text: '🕵️ مخاطر المحافظ الداخلية', callback_data: `p5:i:${key}:${address}` }, { text: '🧾 فحص ما قبل التنفيذ', callback_data: `p4:p:${key}:${address}` }], [{ text: '🟢 شراء تجريبي', callback_data: `term:b:${key}:${address}` }]] };
}

let installed = false;
export function installPhase5RiskQuote() {
  if (installed) return;
  installed = true;
  const previousAnalyze = TradingTerminal.prototype.analyze;
  TradingTerminal.prototype.analyze = async function(network, address) {
    const result = await previousAnalyze.call(this, network, address);
    const key = normalizeTerminalNetwork(network);
    if (result?.keyboard && isTerminalAddress(key, address)) {
      const has = result.keyboard.some((row) => row.some((b) => String(b?.callback_data || '').startsWith('p5:')));
      if (!has) result.keyboard.push([{ text: '🕵️ مخاطر المحافظ الداخلية', callback_data: `p5:i:${key}:${address}` }, { text: '🧾 محاكاة المسار', callback_data: `p5:q:${key}:${address}` }]);
    }
    return result;
  };
  const previousHandle = TradingTerminal.prototype.handle;
  TradingTerminal.prototype.handle = async function(data) {
    const value = String(data ?? '');
    if (!value.startsWith('p5:')) return previousHandle.call(this, data);
    const parts = value.split(':');
    try {
      if (parts[1] === 'i' && parts.length >= 4) return { handled: true, ...(await insiderRisk(parts[2], parts.slice(3).join(':'))) };
      if (parts[1] === 'q' && parts.length >= 4) return { handled: true, ...(await routeSimulation(parts[2], parts.slice(3).join(':'))) };
    } catch (error) {
      return { handled: true, text: `❌ خطأ في تحليل المخاطر: ${String(error?.message ?? error).slice(0, 180)}`, keyboard: [] };
    }
    return { handled: true, text: 'ℹ️ أمر غير معروف في تحليل المخاطر.', keyboard: [] };
  };
  console.log('SUMMECA PHASE 5: deployer/insider evidence + quote/route simulation active; signer/router broadcast OFF');
}
