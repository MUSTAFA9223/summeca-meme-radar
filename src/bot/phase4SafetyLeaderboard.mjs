import { env } from '../config/env.mjs';
import { TradingTerminal, normalizeTerminalNetwork, isTerminalAddress } from './tradingTerminal.mjs';

const finite = (value, fallback = 0) => Number.isFinite(Number(value)) ? Number(value) : fallback;
const clamp = (value, min, max) => Math.max(min, Math.min(max, value));
const short = (value) => { const s = String(value ?? ''); return s.length > 16 ? `${s.slice(0, 7)}…${s.slice(-5)}` : s; };
const money = (value) => { const n = finite(value); if (Math.abs(n) >= 1e6) return `$${(n / 1e6).toFixed(2)}M`; if (Math.abs(n) >= 1e3) return `$${(n / 1e3).toFixed(1)}K`; return `$${n.toFixed(2)}`; };
const pct = (value) => `${finite(value).toFixed(1)}%`;
const NETWORKS = {
  sol: { label: 'SOLANA', dex: 'solana' },
  bsc: { label: 'BNB CHAIN', dex: 'bsc', goPlus: '56' },
  arc: { label: 'ARC', dex: 'arc', goPlus: '5042' },
  rh: { label: 'ROBINHOOD CHAIN', dex: 'robinhood', goPlus: '4663' }
};

async function fetchJson(url, options = {}, timeoutMs = 6_000) {
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
    symbol: token?.symbol || 'TOKEN', priceUsd: finite(pair?.priceUsd),
    liquidityUsd: finite(pair?.liquidity?.usd), marketCapUsd: finite(pair?.marketCap, finite(pair?.fdv)),
    buys5m: finite(pair?.txns?.m5?.buys), sells5m: finite(pair?.txns?.m5?.sells),
    volume5mUsd: finite(pair?.volume?.m5), priceChange5mPct: finite(pair?.priceChange?.m5),
    pairAddress: String(pair?.pairAddress ?? ''), url: String(pair?.url ?? '')
  };
}

async function solanaRpc(method, params) {
  return fetchJson('https://api.mainnet-beta.solana.com', {
    method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: `p4-${Date.now()}`, method, params })
  }, 7_000).then((body) => {
    if (body?.error) throw new Error(body.error.message || `RPC ${body.error.code}`);
    return body?.result;
  });
}

async function solanaSafety(address) {
  const out = { verified: [], warnings: [], holderCountSample: 0, top1Pct: null, top5Pct: null, top10Pct: null, mintAuthority: null, freezeAuthority: null };
  const [supplyResult, largestResult, mintResult] = await Promise.allSettled([
    solanaRpc('getTokenSupply', [address, { commitment: 'processed' }]),
    solanaRpc('getTokenLargestAccounts', [address, { commitment: 'processed' }]),
    solanaRpc('getAccountInfo', [address, { encoding: 'jsonParsed', commitment: 'processed' }])
  ]);
  const supply = supplyResult.status === 'fulfilled' ? finite(supplyResult.value?.value?.uiAmountString) : 0;
  const largest = largestResult.status === 'fulfilled' && Array.isArray(largestResult.value?.value) ? largestResult.value.value : [];
  if (supply > 0 && largest.length) {
    const shares = largest.map((r) => finite(r?.uiAmountString) / supply * 100).filter(Number.isFinite);
    out.holderCountSample = shares.length;
    out.top1Pct = shares[0] ?? null;
    out.top5Pct = shares.slice(0, 5).reduce((a, b) => a + b, 0);
    out.top10Pct = shares.slice(0, 10).reduce((a, b) => a + b, 0);
    out.verified.push('largest-holder distribution');
    if (out.top1Pct > 15) out.warnings.push('top-holder-concentration');
    if (out.top5Pct > 40) out.warnings.push('top5-concentration');
    if (out.top10Pct > 60) out.warnings.push('top10-concentration');
  }
  if (mintResult.status === 'fulfilled') {
    const info = mintResult.value?.value?.data?.parsed?.info;
    if (info) {
      out.mintAuthority = info.mintAuthority ?? null;
      out.freezeAuthority = info.freezeAuthority ?? null;
      out.verified.push('mint/freeze authorities');
      if (out.mintAuthority) out.warnings.push('mint-authority-active');
      if (out.freezeAuthority) out.warnings.push('freeze-authority-active');
    }
  }
  return out;
}

async function evmSafety(network, address) {
  const cfg = NETWORKS[network];
  const out = { verified: [], warnings: [], holderCount: null, top1Pct: null, top5Pct: null, top10Pct: null, buyTax: null, sellTax: null, provider: false };
  if (!cfg?.goPlus) return out;
  try {
    const qs = new URLSearchParams({ contract_addresses: address });
    const body = await fetchJson(`https://api.gopluslabs.io/api/v1/token_security/${cfg.goPlus}?${qs}`, { headers: { accept: 'application/json' } });
    const row = body?.result?.[String(address).toLowerCase()] ?? body?.result?.[address];
    if (!row) return out;
    out.provider = true;
    out.verified.push('GoPlus token-security response');
    const flag = (key) => String(row?.[key] ?? '') === '1';
    const risks = [
      ['is_honeypot', 'honeypot'], ['cannot_sell_all', 'cannot-sell-all'], ['is_blacklisted', 'blacklist-risk'],
      ['hidden_owner', 'hidden-owner'], ['can_take_back_ownership', 'ownership-reclaimable'],
      ['owner_change_balance', 'owner-can-change-balance'], ['selfdestruct', 'selfdestruct-enabled'],
      ['external_call', 'external-call-risk'], ['is_proxy', 'proxy-contract']
    ];
    for (const [key, label] of risks) if (flag(key)) out.warnings.push(label);
    out.holderCount = finite(row?.holder_count, null);
    out.buyTax = row?.buy_tax == null ? null : finite(row.buy_tax) * 100;
    out.sellTax = row?.sell_tax == null ? null : finite(row.sell_tax) * 100;
    if (out.buyTax != null && out.buyTax > 10) out.warnings.push('high-buy-tax');
    if (out.sellTax != null && out.sellTax > 10) out.warnings.push('high-sell-tax');
    const holders = Array.isArray(row?.holders) ? row.holders : [];
    if (holders.length) {
      const shares = holders.map((h) => finite(h?.percent) * 100).filter(Number.isFinite).sort((a, b) => b - a);
      out.top1Pct = shares[0] ?? null;
      out.top5Pct = shares.slice(0, 5).reduce((a, b) => a + b, 0);
      out.top10Pct = shares.slice(0, 10).reduce((a, b) => a + b, 0);
      out.verified.push('holder distribution');
      if (out.top1Pct > 20) out.warnings.push('top-holder-concentration');
      if (out.top5Pct > 50) out.warnings.push('top5-concentration');
    }
  } catch {}
  return out;
}

function scoreSafety(market, chain) {
  let score = 100;
  const reasons = [];
  if (!market) { score -= 35; reasons.push('market-not-visible'); }
  else {
    if (market.liquidityUsd < 5_000) { score -= 20; reasons.push('low-liquidity'); }
    else if (market.liquidityUsd < 15_000) { score -= 8; reasons.push('thin-liquidity'); }
    if (market.sells5m < 1) { score -= 12; reasons.push('no-real-sells'); }
    if (market.buys5m >= 12 && market.sells5m === 0) { score -= 18; reasons.push('honeypot-pattern'); }
    if (market.priceChange5mPct > 45) { score -= 14; reasons.push('late-entry-move'); }
    if (market.marketCapUsd > 3_000_000) { score -= 8; reasons.push('market-cap-high-for-early-entry'); }
  }
  for (const warning of chain?.warnings ?? []) {
    reasons.push(warning);
    if (/honeypot|cannot-sell|blacklist|change-balance|selfdestruct/.test(warning)) score -= 30;
    else if (/authority-active|hidden-owner|ownership|concentration|tax/.test(warning)) score -= 12;
    else score -= 6;
  }
  return { score: clamp(Math.round(score), 0, 100), reasons: [...new Set(reasons)] };
}

async function deepSafety(network, address) {
  const key = normalizeTerminalNetwork(network);
  if (!isTerminalAddress(key, address)) return { text: '❌ عقد أو شبكة غير صالحين.', keyboard: [] };
  const market = await marketFor(key, address).catch(() => null);
  const chain = key === 'sol' ? await solanaSafety(address).catch(() => ({ verified: [], warnings: ['solana-rpc-unavailable'] })) : await evmSafety(key, address);
  const result = scoreSafety(market, chain);
  const level = result.score >= 80 ? '🟢 LOW SIGNALLED RISK' : result.score >= 60 ? '🟡 MEDIUM RISK' : '🔴 HIGH RISK';
  const lines = [
    `🛡️ DEEP SAFETY — ${NETWORKS[key]?.label || key}`, '',
    `${market ? `$${market.symbol}` : 'TOKEN'} • ${short(address)}`,
    `Safety Score: ${result.score}/100 • ${level}`,
    market ? `Liquidity: ${money(market.liquidityUsd)} | MC: ${money(market.marketCapUsd)}` : 'Market: غير متاح حاليًا',
    market ? `Buys/Sells 5m: ${market.buys5m}/${market.sells5m} | Move: ${pct(market.priceChange5mPct)}` : '',
    '',
    `✅ Verified checks: ${(chain.verified ?? []).length ? chain.verified.join(', ') : 'basic market checks only'}`
  ].filter(Boolean);
  if (chain.top1Pct != null) lines.push(`👤 Top1: ${pct(chain.top1Pct)} | Top5: ${pct(chain.top5Pct)} | Top10: ${pct(chain.top10Pct)}`);
  if (key === 'sol') lines.push(`🪙 Mint authority: ${chain.mintAuthority ? 'ACTIVE ⚠️' : 'none/disabled ✅'} | Freeze: ${chain.freezeAuthority ? 'ACTIVE ⚠️' : 'none/disabled ✅'}`);
  if (key !== 'sol' && (chain.buyTax != null || chain.sellTax != null)) lines.push(`💸 Tax: buy ${chain.buyTax == null ? '—' : pct(chain.buyTax)} / sell ${chain.sellTax == null ? '—' : pct(chain.sellTax)}`);
  lines.push('', result.reasons.length ? `⚠️ Flags: ${result.reasons.join(', ')}` : '✅ No high-risk flag detected by available checks.', '', 'مهم: عدم ظهور تحذير لا يضمن أن العقد آمن أو أن السعر سيرتفع.');
  return {
    text: lines.join('\n'),
    keyboard: [[{ text: '🧾 Preflight', callback_data: `p4:p:${key}:${address}` }, { text: '🔎 تحليل', callback_data: `term:a:${key}:${address}` }], [{ text: '🧠 Wallet Leaderboard', callback_data: 'p4:lb' }]]
  };
}

async function supabaseRows(path) {
  if (!env.supabaseUrl || !env.supabaseSecretKey) return [];
  const url = `${String(env.supabaseUrl).replace(/\/$/, '')}/rest/v1/${path}`;
  try {
    const response = await fetch(url, { headers: { apikey: env.supabaseSecretKey, Authorization: `Bearer ${env.supabaseSecretKey}`, accept: 'application/json' } });
    if (!response.ok) return [];
    const body = await response.json();
    return Array.isArray(body) ? body : [];
  } catch { return []; }
}

function configuredWallets() {
  const re = /^0x[0-9a-fA-F]{40}$/;
  const sources = [
    ['bsc', process.env.BNB_WALLETS || process.env.TRENCHES_WALLETS],
    ['robinhood', process.env.ROBINHOOD_WALLETS || process.env.TRENCHES_WALLETS],
    ['arc', process.env.ARC_WALLETS || process.env.TRENCHES_WALLETS]
  ];
  const rows = [];
  for (const [network, raw] of sources) {
    for (const [index, entry] of String(raw || '').split(',').map((x) => x.trim()).filter(Boolean).entries()) {
      const [a, b] = entry.includes('|') ? entry.split('|', 2) : entry.includes('=') ? entry.split('=', 2) : [entry, ''];
      const address = re.test(a) ? a.toLowerCase() : re.test(b) ? b.toLowerCase() : '';
      const label = address === String(a).toLowerCase() ? (b || `wallet-${index + 1}`) : (a || `wallet-${index + 1}`);
      if (address) rows.push({ network, address, label: String(label).trim() });
    }
  }
  return rows;
}

function walletKey(network, address) {
  const net = String(network || '').toLowerCase();
  const raw = String(address || '').trim();
  const normalized = net === 'solana' || net === 'sol' ? raw : raw.toLowerCase();
  return { network: net || 'unknown', address: normalized, key: `${net || 'unknown'}:${normalized}` };
}

async function autoDiscoveredWallets() {
  const rows = await supabaseRows('app_settings?select=value&key=eq.auto_smart_wallet_discovery_v1&limit=1');
  try {
    const state = JSON.parse(String(rows?.[0]?.value || '{}'));
    return (Array.isArray(state?.wallets) ? state.wallets : []).filter((row) => row?.promoted && row?.address && row?.network);
  } catch {
    return [];
  }
}

async function walletLeaderboard() {
  const base = new Map(configuredWallets().map((w) => {
    const id = walletKey(w.network, w.address);
    return [id.key, { ...w, network: id.network, address: id.address, signals: 0, clusters: 0, paidUsd: 0, scoreSum: 0, riskSum: 0 }];
  }));
  const autoWallets = await autoDiscoveredWallets();
  for (const w of autoWallets) {
    const id = walletKey(w.network, w.address);
    const prior = base.get(id.key) ?? {
      network: id.network,
      address: id.address,
      label: w.label || short(id.address),
      signals: 0,
      clusters: 0,
      paidUsd: 0,
      scoreSum: 0,
      riskSum: 0
    };
    prior.autoDiscovered = true;
    prior.autoScore = finite(w.score);
    prior.autoSamples = finite(w.samples);
    prior.autoAvgPeakRoi = finite(w.avgPeakRoi);
    base.set(id.key, prior);
  }
  const rows = await supabaseRows('signals?select=created_at,entry_score,risk_score,reason,tokens(chain)&order=created_at.desc&limit=250');
  for (const signal of rows) {
    const wallets = Array.isArray(signal?.reason?.wallets) ? signal.reason.wallets : [];
    const clusterSize = finite(signal?.reason?.confirming_wallets, wallets.length);
    const tokenChain = String(signal?.tokens?.chain || signal?.reason?.network || '').toLowerCase();
    for (const w of wallets) {
      const id = walletKey(w?.network || tokenChain, w?.address);
      if (!id.address) continue;
      const item = base.get(id.key) ?? { network: id.network, address: id.address, label: w?.label || short(id.address), signals: 0, clusters: 0, paidUsd: 0, scoreSum: 0, riskSum: 0 };
      item.signals += 1;
      if (clusterSize >= 2) item.clusters += 1;
      item.paidUsd += finite(w?.paid_usd);
      item.scoreSum += finite(signal?.entry_score);
      item.riskSum += finite(signal?.risk_score);
      base.set(id.key, item);
    }
  }
  const ranked = [...base.values()].map((w) => {
    const avgEntry = w.signals ? w.scoreSum / w.signals : 0;
    const avgRisk = w.signals ? w.riskSum / w.signals : 50;
    const signalEvidence = clamp(Math.round(Math.min(35, w.signals * 5) + Math.min(20, w.clusters * 4) + Math.min(20, Math.log10(1 + w.paidUsd) * 5) + avgEntry * 0.2 - avgRisk * 0.1), 0, 100);
    const evidence = Math.max(signalEvidence, finite(w.autoScore));
    return { ...w, avgEntry, avgRisk, signalEvidence, evidence };
  }).sort((a, b) => b.evidence - a.evidence || b.signals - a.signals);
  const lines = ['🧠 SMART-WALLET LEADERBOARD', '', 'Auto Discovery يحتاج ≥2 عملات ناجحة مختلفة قبل ترقية المحفظة. النتيجة دليل تاريخي وليست ضمان ربح.', ''];
  for (const [i, w] of ranked.slice(0, 10).entries()) {
    const auto = w.autoDiscovered
      ? ` | AUTO ${w.autoSamples} wins • avg peak +${finite(w.autoAvgPeakRoi).toFixed(0)}%`
      : '';
    lines.push(`${i + 1}. [${String(w.network || 'unknown').toUpperCase()}] ${w.label} • ${w.evidence}/100`, `   signals ${w.signals} | clusters ${w.clusters} | verified flow ${money(w.paidUsd)} | avg entry ${w.avgEntry.toFixed(0)}${auto}`);
  }
  if (!ranked.length) lines.push('لا توجد أدلة كافية حتى الآن.');
  lines.push('', '📈 Performance/ROI ranking سيُفعل تلقائيًا فقط عندما تتوفر عينات نتائج موثوقة كافية.');
  return { text: lines.join('\n'), keyboard: [[{ text: '📊 Positions', callback_data: 'term:p' }, { text: '📋 Orders', callback_data: 'p3:o' }]] };
}

async function preflight(network, address) {
  const key = normalizeTerminalNetwork(network);
  if (!isTerminalAddress(key, address)) return { text: '❌ عقد غير صالح.', keyboard: [] };
  const market = await marketFor(key, address).catch(() => null);
  const safety = await deepSafety(key, address);
  const safetyMatch = String(safety.text || '').match(/Safety Score:\s*(\d+)/i);
  const safetyScore = finite(safetyMatch?.[1]);
  const checks = [
    ['Market pair visible', Boolean(market)],
    ['Liquidity ≥ $10K', finite(market?.liquidityUsd) >= 10_000],
    ['Real sells observed', finite(market?.sells5m) >= 1],
    ['Safety score ≥ 70', safetyScore >= 70],
    ['Network supported by Terminal', Boolean(NETWORKS[key])],
    ['Live broadcaster disabled', true]
  ];
  const pass = checks.slice(0, 5).every(([, ok]) => ok);
  const lines = ['🧾 EXECUTION PREFLIGHT — SAFE MODE', '', `${market ? `$${market.symbol}` : 'TOKEN'} • ${NETWORKS[key]?.label || key}`, ...checks.map(([label, ok]) => `${ok ? '✅' : '❌'} ${label}`), '', pass ? '🟢 جاهز لمرحلة Preview/Paper من ناحية الفحوص الحالية.' : '🟡 غير جاهز بعد؛ لا أنصح حتى بمعاملة حقيقية مستقبلًا قبل حل البنود الفاشلة.', '', '🔒 لا يوجد Router/Signer/Broadcast حقيقي في هذه المرحلة، كما طلبت.'];
  return { text: lines.join('\n'), keyboard: [[{ text: '🛡️ Deep Safety', callback_data: `p4:s:${key}:${address}` }, { text: '🟢 Paper Buy', callback_data: `term:b:${key}:${address}` }]] };
}

let installed = false;
export function installPhase4SafetyLeaderboard() {
  if (installed) return;
  installed = true;

  const previousAnalyze = TradingTerminal.prototype.analyze;
  TradingTerminal.prototype.analyze = async function(network, address) {
    const result = await previousAnalyze.call(this, network, address);
    const key = normalizeTerminalNetwork(network);
    if (result?.keyboard && isTerminalAddress(key, address)) {
      const hasP4 = result.keyboard.some((row) => row.some((button) => String(button?.callback_data ?? '').startsWith('p4:')));
      if (!hasP4) result.keyboard.push([{ text: '🛡️ Deep Safety', callback_data: `p4:s:${key}:${address}` }, { text: '🧾 Preflight', callback_data: `p4:p:${key}:${address}` }], [{ text: '🧠 Wallet Leaderboard', callback_data: 'p4:lb' }]);
    }
    return result;
  };

  const previousHandle = TradingTerminal.prototype.handle;
  TradingTerminal.prototype.handle = async function(data) {
    const value = String(data ?? '');
    if (!value.startsWith('p4:')) return previousHandle.call(this, data);
    const parts = value.split(':');
    const action = parts[1] || '';
    try {
      if (action === 'lb') return { handled: true, ...(await walletLeaderboard()) };
      if (action === 's' && parts.length >= 4) return { handled: true, ...(await deepSafety(parts[2], parts.slice(3).join(':'))) };
      if (action === 'p' && parts.length >= 4) return { handled: true, ...(await preflight(parts[2], parts.slice(3).join(':'))) };
    } catch (error) {
      return { handled: true, text: `❌ Phase 4 error: ${String(error?.message ?? error).slice(0, 180)}`, keyboard: [[{ text: '🧠 Leaderboard', callback_data: 'p4:lb' }]] };
    }
    return { handled: true, text: 'ℹ️ أمر Phase 4 غير معروف.', keyboard: [[{ text: '🧠 Leaderboard', callback_data: 'p4:lb' }]] };
  };

  console.log('SUMMECA PHASE 4: Deep Safety + Evidence Wallet Leaderboard + Safe Execution Preflight; live broadcast remains OFF');
}
