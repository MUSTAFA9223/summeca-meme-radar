import crypto from 'node:crypto';
import { env } from '../config/env.mjs';
import { HardeningStore } from '../storage/hardeningStore.mjs';
import { TradingTerminal, normalizeTerminalNetwork, isTerminalAddress } from './tradingTerminal.mjs';
import { PrivySolanaWallet } from '../trading/privyWallet.mjs';
import { JupiterSwapClient, SOL_MINT } from '../trading/jupiterSwap.mjs';
import { runLiveConfigSmoke } from '../trading/liveConfigSmoke.mjs';
import { initialProtectionState, protectionSettings } from '../trading/liveProtectionPolicy.mjs';
import { getActiveTradingWallet, privyClientForTradingWallet, walletFromAuditPayload } from '../trading/walletRegistry.mjs';

const store = new HardeningStore();
const SOLANA_PUBLIC_RPC = 'https://api.mainnet-beta.solana.com';
const finite = (value, fallback = 0) => Number.isFinite(Number(value)) ? Number(value) : fallback;
const clamp = (value, min, max) => Math.max(min, Math.min(max, finite(value, min)));
const short = (value) => { const s = String(value ?? ''); return s.length > 16 ? `${s.slice(0, 7)}…${s.slice(-5)}` : s; };
const money = (value) => `$${finite(value).toLocaleString('en-US', { maximumFractionDigits: 2 })}`;
const isoNow = () => new Date().toISOString();

export function manualTradeCaps() {
  return {
    maxBuySol: Math.min(env.liveMaxEntrySol, clamp(process.env.MANUAL_MAX_BUY_SOL ?? env.liveMaxEntrySol, 0.001, 0.25)),
    maxSlippageBps: Math.round(clamp(process.env.MANUAL_MAX_SLIPPAGE_BPS ?? 500, 50, 1_000)),
    maxPriceImpactPct: clamp(process.env.MANUAL_MAX_PRICE_IMPACT_PCT ?? 5, 0.25, 10),
    maxFeeBps: Math.round(clamp(process.env.MANUAL_MAX_FEE_BPS ?? 200, 0, 500)),
    confirmTtlMs: Math.round(clamp(process.env.MANUAL_CONFIRM_TTL_MS ?? 45_000, 15_000, 120_000)),
    reserveSol: Math.max(env.liveMinSolReserve, clamp(process.env.MANUAL_MIN_SOL_RESERVE ?? env.liveMinSolReserve, 0.005, 2))
  };
}

export function manualLiveGate() {
  return {
    liveEnabled: env.liveTradingEnabled,
    manualArmed: String(process.env.MANUAL_TRADING_ARMED ?? 'false').toLowerCase() === 'true'
  };
}

async function fetchJson(url, options = {}, timeoutMs = 8_000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, { ...options, signal: controller.signal });
    const text = await response.text().catch(() => '');
    let body = null;
    try { body = text ? JSON.parse(text) : null; } catch { body = text; }
    if (!response.ok) throw new Error(body?.errorMessage ?? body?.error ?? `HTTP ${response.status}`);
    return body;
  } finally { clearTimeout(timer); }
}

async function solanaRpc(method, params = []) {
  const endpoints = [
    env.heliusApiKey ? `https://mainnet.helius-rpc.com/?api-key=${encodeURIComponent(env.heliusApiKey)}` : '',
    SOLANA_PUBLIC_RPC
  ].filter(Boolean);
  let last = null;
  for (const endpoint of endpoints) {
    try {
      const body = await fetchJson(endpoint, {
        method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: `manual-${Date.now()}`, method, params })
      }, 7_000);
      if (body?.error) throw new Error(body.error.message || `RPC ${body.error.code}`);
      return body?.result;
    } catch (error) { last = error; }
  }
  throw last || new Error(`Solana RPC ${method} failed`);
}

async function walletSolBalanceLamports(address) {
  const result = await solanaRpc('getBalance', [address, { commitment: 'processed' }]);
  return BigInt(String(result?.value ?? 0));
}

async function tokenBalanceAtomic(owner, mint) {
  const result = await solanaRpc('getTokenAccountsByOwner', [owner, { mint }, { encoding: 'jsonParsed', commitment: 'processed' }]);
  let total = 0n;
  for (const row of Array.isArray(result?.value) ? result.value : []) {
    const amount = row?.account?.data?.parsed?.info?.tokenAmount?.amount;
    if (/^\d+$/.test(String(amount ?? ''))) total += BigInt(amount);
  }
  return total;
}

async function jupiterQuote(inputMint, outputMint, amountAtomic, slippageBps) {
  const params = new URLSearchParams({
    inputMint: String(inputMint), outputMint: String(outputMint), amount: String(amountAtomic),
    slippageBps: String(slippageBps), restrictIntermediateTokens: 'true'
  });
  const headers = { accept: 'application/json' };
  if (env.jupiterApiKey) headers['x-api-key'] = env.jupiterApiKey;
  return fetchJson(`https://api.jup.ag/swap/v1/quote?${params}`, { headers }, 9_000);
}

async function marketFor(address) {
  const rows = await fetchJson(`https://api.dexscreener.com/tokens/v1/solana/${encodeURIComponent(address)}`, { headers: { accept: 'application/json' } }, 6_000).catch(() => []);
  const pair = (Array.isArray(rows) ? rows : []).sort((a, b) => finite(b?.liquidity?.usd) - finite(a?.liquidity?.usd))[0];
  if (!pair) return null;
  const token = String(pair?.baseToken?.address ?? '') === String(address) ? pair.baseToken : pair.quoteToken;
  return { symbol: token?.symbol || 'TOKEN', name: token?.name || token?.symbol || 'Token', priceUsd: finite(pair?.priceUsd), liquidityUsd: finite(pair?.liquidity?.usd) };
}

function quoteImpactPct(quote) {
  return Math.max(0, finite(quote?.priceImpactPct) * 100);
}

function routeNames(quote) {
  return [...new Set((Array.isArray(quote?.routePlan) ? quote.routePlan : []).map((row) => row?.swapInfo?.label).filter(Boolean))];
}

function gateText() {
  const gate = manualLiveGate();
  if (gate.liveEnabled && gate.manualArmed) return '🟢 LIVE MANUAL GATE: ARMED';
  if (!gate.liveEnabled && !gate.manualArmed) return '🔒 LIVE broadcast OFF + manual gate disarmed';
  if (!gate.liveEnabled) return '🔒 LIVE_TRADING_ENABLED=false';
  return '🔒 MANUAL_TRADING_ARMED=false';
}

async function activeDuplicate(address, side) {
  if (!store.enabled) return null;
  return store.findActiveIntent('sol', String(address), side, new Date(Date.now() - 2 * 60_000).toISOString()).catch(() => null);
}

function existingIntentResult(row) {
  const canConfirm = row?.status === 'awaiting_confirm' && (!row.confirmation_expires_at || Date.parse(row.confirmation_expires_at) > Date.now());
  return {
    text: [
      '🧷 MANUAL EXECUTION INTENT موجود بالفعل', '',
      `${String(row?.side || '').toUpperCase()} • ${short(row?.token_address)}`,
      `Status: ${row?.status}`,
      `Request: ${short(row?.request_id)}`,
      '',
      'تم منع إنشاء Intent مكرر لنفس العقد والاتجاه خلال النافذة القصيرة.'
    ].join('\n'),
    keyboard: canConfirm
      ? [[{ text: '✅ متابعة التأكيد', callback_data: `p6:c:${row.request_id}` }, { text: '❌ إلغاء', callback_data: `p6:x:${row.request_id}` }]]
      : [[{ text: '📜 Audit', callback_data: 'p6:a' }]]
  };
}

async function createBlockedAudit({ address, side, amountNative = null, payload = {}, error }) {
  if (!store.enabled) return null;
  return store.createAudit({
    request_id: crypto.randomUUID(), network: 'sol', token_address: address, side,
    amount_native: amountNative, status: 'blocked', error: String(error).slice(0, 300), payload
  }).catch(() => null);
}

async function prepareBuy(amountSol, address) {
  if (!store.enabled) return { text: '❌ Execution Audit store غير متاح؛ تم إيقاف المسار الحقيقي للحماية.', keyboard: [] };
  const amount = finite(amountSol);
  const caps = manualTradeCaps();
  const executionWallet = await getActiveTradingWallet();
  if (!executionWallet?.id || !isTerminalAddress('sol', executionWallet?.address)) {
    return { text: '❌ لا توجد محفظة تداول Solana نشطة. افتح /wallets واختر أو أنشئ محفظة.', keyboard: [] };
  }
  if (!isTerminalAddress('sol', address) || !(amount > 0) || amount > caps.maxBuySol) {
    await createBlockedAudit({ address, side: 'buy', amountNative: amount || null, error: 'amount/address outside manual caps' });
    return { text: `❌ الصفقة خارج حدود الحماية. Max Buy = ${caps.maxBuySol.toFixed(4)} SOL`, keyboard: [] };
  }
  const duplicate = await activeDuplicate(address, 'buy');
  if (duplicate) return existingIntentResult(duplicate);

  const amountAtomic = BigInt(Math.round(amount * 1e9)).toString();
  const quote = await jupiterQuote(SOL_MINT, address, amountAtomic, caps.maxSlippageBps);
  const impact = quoteImpactPct(quote);
  const outAmount = String(quote?.outAmount || '0');
  if (!/^\d+$/.test(outAmount) || BigInt(outAmount) <= 0n || impact > caps.maxPriceImpactPct) {
    await createBlockedAudit({ address, side: 'buy', amountNative: amount, payload: { priceImpactPct: impact }, error: 'quote failed safety caps' });
    return { text: `⛔ تم رفض Live Buy قبل التأكيد. Price impact ${impact.toFixed(3)}% / cap ${caps.maxPriceImpactPct.toFixed(2)}%`, keyboard: [] };
  }

  const requestId = crypto.randomUUID();
  const expiresAt = new Date(Date.now() + caps.confirmTtlMs).toISOString();
  const market = await marketFor(address).catch(() => null);
  await store.createAudit({
    request_id: requestId, network: 'sol', token_address: address, side: 'buy',
    amount_native: amount, amount_usd: null, slippage_bps: caps.maxSlippageBps,
    price_impact_pct: impact, fee_usd: null, status: 'awaiting_confirm', confirmation_expires_at: expiresAt,
    payload: {
      mode: 'manual-confirm', amountAtomic, inputMint: SOL_MINT, outputMint: address,
      quotedOutAtomic: outAmount, route: routeNames(quote), symbol: market?.symbol || null,
      priceUsd: market?.priceUsd || null,
      walletId: executionWallet.id, walletAddress: executionWallet.address, walletLabel: executionWallet.label,
      liveEnabled: manualLiveGate().liveEnabled, manualArmed: manualLiveGate().manualArmed
    }
  });
  const live = manualLiveGate().liveEnabled && manualLiveGate().manualArmed;
  return {
    text: [
      '🔐 MANUAL LIVE BUY — FINAL PREVIEW', '',
      `${market ? `$${market.symbol}` : 'TOKEN'} • SOLANA`,
      `Amount: ${amount.toFixed(4)} SOL`,
      `Wallet: ${executionWallet.label} • ${short(executionWallet.address)}`,
      `Liquidity: ${market?.liquidityUsd ? money(market.liquidityUsd) : '—'}`,
      `Price impact: ${impact.toFixed(3)}% / cap ${caps.maxPriceImpactPct.toFixed(2)}%`,
      `Slippage cap: ${(caps.maxSlippageBps / 100).toFixed(2)}%`,
      `Route: ${routeNames(quote).join(' → ') || 'Jupiter route'}`,
      `Expires: ${Math.round(caps.confirmTtlMs / 1000)}s`,
      '', gateText(),
      live ? '⚠️ الضغط على Confirm سيوقع ويرسل صفقة حقيقية مرة واحدة فقط.' : '🧪 الضغط على الزر سيختبر قفل التأكيد فقط؛ لن تُرسل أموال لأن البث مقفول.',
      `Request: ${short(requestId)}`
    ].join('\n'),
    keyboard: [[
      { text: live ? '⚠️ CONFIRM LIVE BUY' : '🔒 اختبار التأكيد', callback_data: `p6:c:${requestId}` },
      { text: '❌ إلغاء', callback_data: `p6:x:${requestId}` }
    ]]
  };
}

async function prepareSell(percent, address) {
  if (!store.enabled) return { text: '❌ Execution Audit store غير متاح؛ تم إيقاف المسار الحقيقي للحماية.', keyboard: [] };
  const pct = Math.max(1, Math.min(100, Math.round(finite(percent))));
  const executionWallet = await getActiveTradingWallet();
  if (!executionWallet?.id || !isTerminalAddress('sol', executionWallet?.address)) {
    return { text: '❌ لا توجد محفظة تداول Solana نشطة. افتح /wallets واختر محفظة.', keyboard: [] };
  }
  if (!isTerminalAddress('sol', address) || ![25, 50, 100].includes(pct)) return { text: '❌ نسبة البيع غير صالحة.', keyboard: [] };
  const duplicate = await activeDuplicate(address, 'sell');
  if (duplicate) return existingIntentResult(duplicate);

  const balance = await tokenBalanceAtomic(executionWallet.address, address);
  if (balance <= 0n) {
    await createBlockedAudit({ address, side: 'sell', error: 'wallet has zero token balance', payload: { sellPct: pct } });
    return { text: '❌ لا يوجد رصيد فعلي لهذا التوكن في محفظة التنفيذ.', keyboard: [] };
  }
  const amountAtomic = balance * BigInt(pct) / 100n;
  if (amountAtomic <= 0n) return { text: '❌ كمية البيع الناتجة صفر.', keyboard: [] };
  const caps = manualTradeCaps();
  const quote = await jupiterQuote(address, SOL_MINT, amountAtomic.toString(), caps.maxSlippageBps);
  const impact = quoteImpactPct(quote);
  if (impact > caps.maxPriceImpactPct) {
    await createBlockedAudit({ address, side: 'sell', payload: { sellPct: pct, priceImpactPct: impact }, error: 'sell quote exceeds impact cap' });
    return { text: `⛔ تم رفض Live Sell. Price impact ${impact.toFixed(3)}% أعلى من cap ${caps.maxPriceImpactPct.toFixed(2)}%`, keyboard: [] };
  }
  const outLamports = /^\d+$/.test(String(quote?.outAmount || '')) ? BigInt(String(quote.outAmount)) : 0n;
  const requestId = crypto.randomUUID();
  const expiresAt = new Date(Date.now() + caps.confirmTtlMs).toISOString();
  const market = await marketFor(address).catch(() => null);
  await store.createAudit({
    request_id: requestId, network: 'sol', token_address: address, side: 'sell',
    slippage_bps: caps.maxSlippageBps, price_impact_pct: impact, status: 'awaiting_confirm', confirmation_expires_at: expiresAt,
    payload: {
      mode: 'manual-confirm', sellPct: pct, amountAtomic: amountAtomic.toString(), inputMint: address, outputMint: SOL_MINT,
      quotedOutLamports: outLamports.toString(), route: routeNames(quote), symbol: market?.symbol || null,
      priceUsd: market?.priceUsd || null,
      walletId: executionWallet.id, walletAddress: executionWallet.address, walletLabel: executionWallet.label,
      liveEnabled: manualLiveGate().liveEnabled, manualArmed: manualLiveGate().manualArmed
    }
  });
  const live = manualLiveGate().liveEnabled && manualLiveGate().manualArmed;
  return {
    text: [
      '🔐 MANUAL LIVE SELL — FINAL PREVIEW', '',
      `${market ? `$${market.symbol}` : 'TOKEN'} • SOLANA`,
      `Sell: ${pct}% من الرصيد الفعلي`,
      `Wallet: ${executionWallet.label} • ${short(executionWallet.address)}`,
      `Estimated output: ${(Number(outLamports) / 1e9).toFixed(6)} SOL`,
      `Price impact: ${impact.toFixed(3)}% / cap ${caps.maxPriceImpactPct.toFixed(2)}%`,
      `Slippage cap: ${(caps.maxSlippageBps / 100).toFixed(2)}%`,
      `Expires: ${Math.round(caps.confirmTtlMs / 1000)}s`, '', gateText(),
      live ? '⚠️ Confirm سيوقع ويرسل البيع الحقيقي مرة واحدة فقط.' : '🧪 البث مقفول؛ زر التأكيد يختبر الحماية ولن يرسل صفقة.',
      `Request: ${short(requestId)}`
    ].join('\n'),
    keyboard: [[
      { text: live ? '⚠️ CONFIRM LIVE SELL' : '🔒 اختبار التأكيد', callback_data: `p6:c:${requestId}` },
      { text: '❌ إلغاء', callback_data: `p6:x:${requestId}` }
    ]]
  };
}

function defaultExecutionWallet() {
  return {
    id: String(env.privyWalletId || ''),
    address: String(env.privyWalletAddress || ''),
    label: 'SUMMECA Primary'
  };
}

function auditExecutionWallet(row) {
  return walletFromAuditPayload(row?.payload) || defaultExecutionWallet();
}

async function recordSuccessfulTrade(row, execution) {
  const executionWallet = auditExecutionWallet(row);
  const market = await marketFor(row.token_address).catch(() => null);
  const token = await store.upsertSolanaToken(row.token_address, {
    symbol: market?.symbol || row.payload?.symbol, name: market?.name, priceUsd: market?.priceUsd,
    source: 'manual-confirm-live'
  }).catch(() => null);
  if (!token?.id) {
    await store.appendAuditEvent(row.request_id, { type: 'live-trade-registration-failed', reason: 'token-upsert-failed' }).catch(() => {});
    return null;
  }

  if (row.side === 'buy') {
    const entryPrice = market?.priceUsd || row.payload?.priceUsd || null;
    const state = initialProtectionState(entryPrice, protectionSettings());
    const liveRow = {
      token_id: token.id,
      wallet_address: executionWallet.address,
      status: 'open',
      entry_tx: execution.signature,
      entry_price_usd: entryPrice,
      input_sol: row.amount_native,
      quantity_atomic: execution.outputAmountAtomic || row.payload?.quotedOutAtomic || null,
      high_water_pnl_pct: state.highWaterPnlPct,
      highest_price_usd: state.highestPriceUsd,
      current_stop: state.currentStop,
      stop_reason: state.stopReason,
      protection_started_at: isoNow(),
      last_protection_check_at: null,
      metadata: {
        request_id: row.request_id,
        manual_confirm: true,
        wallet_id: executionWallet.id,
        wallet_label: executionWallet.label,
        router: execution.router || null,
        mode: execution.mode || null,
        entry_liquidity_usd: market?.liquidityUsd || null,
        remaining_cost_basis_sol: row.amount_native
      }
    };

    let inserted = null;
    for (let attempt = 0; attempt < 3 && !inserted; attempt += 1) {
      try {
        inserted = await store.insertLiveTrade(liveRow);
      } catch (error) {
        const existing = await store.findOpenLiveTrades(token.id).catch(() => []);
        inserted = existing.find((trade) =>
          String(trade.entry_tx || '') === String(execution.signature)
          || String(trade?.metadata?.request_id || '') === String(row.request_id)
        ) || null;
        if (!inserted && attempt < 2) await new Promise((resolve) => setTimeout(resolve, 150 * (attempt + 1)));
      }
    }
    if (!inserted) {
      await store.appendAuditEvent(row.request_id, {
        type: 'live-trade-registration-failed',
        reason: 'post-buy-protection-row-unavailable',
        entryTx: execution.signature
      }).catch(() => {});
      console.error(`[manual-live:protection] BUY landed but live_trades registration failed request=${short(row.request_id)} tx=${short(execution.signature)}`);
      return null;
    }
    return inserted;
  }

  const open = await store.findOpenLiveTrades(token.id).catch(() => []);
  for (const trade of open) {
    const soldAtomic = /^\d+$/.test(String(row.payload?.amountAtomic || '')) ? BigInt(String(row.payload.amountAtomic)) : 0n;
    const quantityBefore = /^\d+$/.test(String(trade.quantity_atomic || '')) ? BigInt(String(trade.quantity_atomic)) : 0n;
    const remainingAtomic = quantityBefore > soldAtomic ? quantityBefore - soldAtomic : 0n;
    const outputLamportsRaw = String(execution.outputAmountAtomic || execution.totalOutputAmount || row.payload?.quotedOutLamports || '0');
    const outputSol = /^\d+$/.test(outputLamportsRaw) ? Number(BigInt(outputLamportsRaw)) / 1e9 : null;
    const priorCost = finite(trade?.metadata?.remaining_cost_basis_sol, finite(trade.input_sol));
    const soldFraction = quantityBefore > 0n ? Math.min(1, Number(soldAtomic) / Number(quantityBefore)) : Number(row.payload?.sellPct || 0) / 100;
    const soldCost = priorCost > 0 ? priorCost * soldFraction : 0;
    const realizedPnlSol = outputSol != null && soldCost > 0 ? outputSol - soldCost : null;
    const realizedPnlPct = realizedPnlSol != null && soldCost > 0 ? realizedPnlSol / soldCost * 100 : null;
    const close = Number(row.payload?.sellPct || 0) >= 100 || remainingAtomic === 0n;
    const metadata = {
      ...(trade.metadata || {}),
      remaining_cost_basis_sol: close ? 0 : Math.max(0, priorCost - soldCost),
      last_manual_sell: {
        request_id: row.request_id,
        pct: row.payload?.sellPct,
        tx: execution.signature,
        amount_atomic: soldAtomic.toString(),
        output_sol: outputSol,
        at: isoNow()
      }
    };
    await store.updateLiveTrade(trade.id, {
      quantity_atomic: remainingAtomic.toString(),
      ...(close ? {
        status: 'closed',
        closed_at: isoNow(),
        exit_tx: execution.signature,
        exit_price_usd: market?.priceUsd || null,
        exit_reason: 'manual-confirm-sell',
        ...(outputSol != null ? { exit_amount_sol: outputSol } : {}),
        ...(realizedPnlSol != null ? { realized_pnl_sol: realizedPnlSol } : {}),
        ...(realizedPnlPct != null ? { realized_pnl_pct: realizedPnlPct } : {}),
        sell_lock_request_id: null
      } : {}),
      metadata
    }).catch(() => null);
  }
  return open[0] || null;
}

async function confirmIntent(requestId) {
  if (!store.enabled) return { text: '❌ Audit/idempotency store غير متاح؛ التنفيذ موقوف.', keyboard: [] };
  const row = await store.getAudit(requestId);
  if (!row) return { text: '❌ Request غير موجود.', keyboard: [] };
  if (row.status !== 'awaiting_confirm') {
    return { text: `🧷 لم يتم التنفيذ. Request status = ${row.status}\n\nنفس Request لا يمكن تنفيذه مرتين.`, keyboard: [[{ text: '📜 Audit', callback_data: 'p6:a' }]] };
  }
  if (row.confirmation_expires_at && Date.parse(row.confirmation_expires_at) <= Date.now()) {
    await store.transitionAudit(requestId, 'awaiting_confirm', 'expired', { error: 'confirmation TTL expired' });
    return { text: '⌛ انتهت مهلة التأكيد. أنشئ Preview جديدًا للحصول على Quote حديث.', keyboard: [] };
  }

  const claimed = await store.transitionAudit(requestId, 'awaiting_confirm', 'confirmed', { payload: { ...(row.payload || {}), confirmedAt: isoNow() } });
  if (!claimed) return { text: '🧷 تم استهلاك هذا التأكيد بالفعل أو تغيّرت حالته. لم تُرسل صفقة أخرى.', keyboard: [[{ text: '📜 Audit', callback_data: 'p6:a' }]] };

  const gate = manualLiveGate();
  if (!gate.liveEnabled || !gate.manualArmed) {
    await store.transitionAudit(requestId, 'confirmed', 'blocked', { error: !gate.liveEnabled ? 'LIVE_TRADING_ENABLED=false' : 'MANUAL_TRADING_ARMED=false' });
    return {
      text: ['🔒 MANUAL CONFIRM GUARD — PASSED', '', 'تم استهلاك Request مرة واحدة ومنع التكرار بنجاح.', gateText(), '✅ لم يتم توقيع أو إرسال أي معاملة.'].join('\n'),
      keyboard: [[{ text: '📜 Audit', callback_data: 'p6:a' }]]
    };
  }
  if (row.network !== 'sol') {
    await store.transitionAudit(requestId, 'confirmed', 'blocked', { error: 'No production EVM signer/router configured' });
    return { text: '🔒 التنفيذ الحقيقي لهذه الشبكة غير متصل بـ signer/router إنتاجي.', keyboard: [] };
  }

  const caps = manualTradeCaps();
  const executionWallet = auditExecutionWallet(row);
  if (!executionWallet?.id || !isTerminalAddress('sol', executionWallet?.address)) {
    await store.transitionAudit(requestId, 'confirmed', 'blocked', { error: 'execution wallet missing from audit intent' });
    return { text: '⛔ محفظة التنفيذ المرتبطة بالـPreview غير متاحة؛ تم إيقاف الصفقة.', keyboard: [] };
  }
  const inputMint = String(row.payload?.inputMint || '');
  const outputMint = String(row.payload?.outputMint || '');
  const amountAtomic = String(row.payload?.amountAtomic || '');
  if (!/^\d+$/.test(amountAtomic) || BigInt(amountAtomic) <= 0n) {
    await store.transitionAudit(requestId, 'confirmed', 'blocked', { error: 'invalid atomic amount' });
    return { text: '⛔ Atomic amount غير صالح؛ أوقفت الصفقة.', keyboard: [] };
  }

  const freshQuote = await jupiterQuote(inputMint, outputMint, amountAtomic, caps.maxSlippageBps);
  const impact = quoteImpactPct(freshQuote);
  if (impact > caps.maxPriceImpactPct) {
    await store.transitionAudit(requestId, 'confirmed', 'blocked', { error: `fresh price impact ${impact}% exceeds cap`, price_impact_pct: impact });
    return { text: `⛔ تغيّر السوق قبل التنفيذ. Fresh price impact ${impact.toFixed(3)}% > cap ${caps.maxPriceImpactPct.toFixed(2)}%.`, keyboard: [] };
  }

  if (row.side === 'buy') {
    const balance = await walletSolBalanceLamports(executionWallet.address);
    const reserve = BigInt(Math.round(caps.reserveSol * 1e9));
    if (balance < BigInt(amountAtomic) + reserve) {
      await store.transitionAudit(requestId, 'confirmed', 'blocked', { error: 'insufficient SOL after reserve cap' });
      return { text: `⛔ الرصيد لا يترك احتياطي ${caps.reserveSol.toFixed(4)} SOL بعد الصفقة.`, keyboard: [] };
    }
  } else {
    const balance = await tokenBalanceAtomic(executionWallet.address, row.token_address);
    if (balance < BigInt(amountAtomic)) {
      await store.transitionAudit(requestId, 'confirmed', 'blocked', { error: 'token balance changed before execution' });
      return { text: '⛔ رصيد التوكن تغيّر منذ Preview؛ أعد إنشاء Sell Preview.', keyboard: [] };
    }
  }

  const wallet = privyClientForTradingWallet(executionWallet);
  const client = new JupiterSwapClient({ apiKey: env.jupiterApiKey, wallet });
  if (!client.configured) {
    await store.transitionAudit(requestId, 'confirmed', 'blocked', { error: 'Privy/Jupiter client not configured' });
    return { text: '🔒 Privy/Jupiter غير مكتمل الإعداد؛ لم يتم توقيع شيء.', keyboard: [] };
  }

  let broadcasting = false;
  try {
    const order = await client.getOrder({ inputMint, outputMint, amount: amountAtomic });
    const feeBps = finite(order?.feeBps);
    if (feeBps > caps.maxFeeBps) {
      await store.transitionAudit(requestId, 'confirmed', 'blocked', { error: `router fee ${feeBps}bps exceeds cap`, payload: { ...(claimed.payload || {}), feeBps } });
      return { text: `⛔ Router fee ${feeBps} bps أعلى من cap ${caps.maxFeeBps} bps.`, keyboard: [] };
    }
    const locked = await store.transitionAudit(requestId, 'confirmed', 'broadcasting', {
      price_impact_pct: impact,
      payload: { ...(claimed.payload || {}), freshQuoteOutAtomic: String(freshQuote?.outAmount || ''), feeBps, router: order?.router || null, executionStartedAt: isoNow() }
    });
    if (!locked) return { text: '🧷 لم أحصل على execution lock؛ لم يتم إرسال الصفقة.', keyboard: [] };
    broadcasting = true;
    const execution = await client.executeOrder(order);
    await store.updateAudit(requestId, {
      status: 'succeeded', tx_hash: String(execution.signature), error: null,
      payload: { ...(locked.payload || {}), executionRequestId: order.requestId, executionFinishedAt: isoNow(), executionInputAmountAtomic: String(execution.inputAmountAtomic || execution.totalInputAmount || amountAtomic), executionOutputAmountAtomic: String(execution.outputAmountAtomic || execution.totalOutputAmount || freshQuote?.outAmount || '0') }
    });
    await recordSuccessfulTrade({ ...row, payload: locked.payload || row.payload }, execution);
    return {
      text: [
        '✅ LIVE MANUAL TRADE EXECUTED', '',
        `${row.side.toUpperCase()} • SOLANA • ${short(row.token_address)}`,
        `TX: ${execution.signature}`,
        '✅ Request idempotency lock consumed — نفس الطلب لن يُنفذ مرة ثانية.',
        '', '⚠️ هذه صفقة حقيقية تمت فقط بعد Manual Confirm.'
      ].join('\n'),
      keyboard: [[{ text: '🔎 Solscan TX', url: `https://solscan.io/tx/${encodeURIComponent(execution.signature)}` }, { text: '📜 Audit', callback_data: 'p6:a' }]]
    };
  } catch (error) {
    const message = String(error?.message ?? error).slice(0, 300);
    await store.updateAudit(requestId, {
      status: 'failed', error: message,
      payload: { ...(claimed.payload || {}), executionUncertain: broadcasting, failedAt: isoNow(), automaticRetryDisabled: true }
    }).catch(() => {});
    return {
      text: [
        '❌ LIVE MANUAL EXECUTION FAILED', '',
        message,
        broadcasting ? '⚠️ الخطأ حصل بعد دخول مرحلة broadcast. لا تعِد المحاولة تلقائيًا؛ افحص السلسلة/Audit أولًا لتجنب صفقة مكررة.' : '✅ لم ندخل مرحلة broadcast؛ لا يوجد retry تلقائي.',
        `Request: ${short(requestId)}`
      ].join('\n'),
      keyboard: [[{ text: '📜 Audit', callback_data: 'p6:a' }]]
    };
  }
}

async function cancelIntent(requestId) {
  if (!store.enabled) return { text: '❌ Audit store غير متاح.', keyboard: [] };
  const row = await store.transitionAudit(requestId, 'awaiting_confirm', 'cancelled', { error: 'cancelled by owner' });
  return row
    ? { text: '✅ تم إلغاء Request. لن يمكن تنفيذه لاحقًا.', keyboard: [[{ text: '📜 Audit', callback_data: 'p6:a' }]] }
    : { text: 'ℹ️ لم يتم الإلغاء لأن Request لم يعد في حالة awaiting_confirm.', keyboard: [[{ text: '📜 Audit', callback_data: 'p6:a' }]] };
}

async function auditView() {
  if (!store.enabled) return { text: '❌ Audit store غير متاح.', keyboard: [] };
  const rows = await store.recentAudits(10).catch(() => []);
  const lines = ['📜 SUMMECA EXECUTION AUDIT', ''];
  if (!rows.length) lines.push('لا توجد محاولات تنفيذ مسجلة بعد.');
  for (const row of rows) {
    const icon = row.status === 'succeeded' ? '✅' : row.status === 'broadcasting' ? '📡' : row.status === 'failed' ? '❌' : row.status === 'blocked' ? '🔒' : '•';
    lines.push(`${icon} ${row.side?.toUpperCase()} ${row.network?.toUpperCase()} ${short(row.token_address)} — ${row.status}`);
    lines.push(`  ${short(row.request_id)}${row.tx_hash ? ` • TX ${short(row.tx_hash)}` : ''}`);
  }
  lines.push('', 'Audit لا يحتوي مفاتيح خاصة أو Secrets.');
  return { text: lines.join('\n'), keyboard: [[{ text: '🏠 القائمة', callback_data: 'menu:home' }]] };
}

async function liveReadiness() {
  const gate = manualLiveGate();
  if (gate.liveEnabled) {
    return { text: `🧪 Live readiness smoke read-only يتطلب LIVE_TRADING_ENABLED=false.\n\n${gateText()}`, keyboard: [[{ text: '📜 Audit', callback_data: 'p6:a' }]] };
  }
  try {
    await runLiveConfigSmoke(env);
    return { text: ['✅ LIVE CONFIG READ-ONLY CHECK PASSED', '', 'Privy wallet + authorization key + Solana balance read + Jupiter quote تم التحقق منها بدون توقيع أو إرسال معاملة.', gateText()].join('\n'), keyboard: [[{ text: '📜 Audit', callback_data: 'p6:a' }]] };
  } catch (error) {
    return { text: `❌ Live readiness check failed:\n${String(error?.message ?? error).slice(0, 240)}\n\nلم يتم توقيع أو إرسال أي معاملة.`, keyboard: [] };
  }
}

function buySizeKeyboard(address) {
  const cap = manualTradeCaps().maxBuySol;
  const values = [...new Set([0.005, 0.01, 0.025, 0.05, cap].filter((v) => v <= cap && v >= 0.001).map((v) => Number(v.toFixed(4))))];
  return [
    values.slice(0, 3).map((v) => ({ text: `${v} SOL`, callback_data: `p6:bp:${v}:sol:${address}` })),
    values.slice(3).map((v) => ({ text: `${v} SOL`, callback_data: `p6:bp:${v}:sol:${address}` })),
    [{ text: '❌ إلغاء', callback_data: `term:a:sol:${address}` }]
  ].filter((row) => row.length);
}

let installed = false;
export function installPhase6ManualConfirm() {
  if (installed) return;
  installed = true;

  const previousAnalyze = TradingTerminal.prototype.analyze;
  TradingTerminal.prototype.analyze = async function(network, address) {
    const result = await previousAnalyze.call(this, network, address);
    const key = normalizeTerminalNetwork(network);
    if (result?.keyboard && isTerminalAddress(key, address)) {
      const has = result.keyboard.some((row) => row.some((button) => String(button?.callback_data || '').startsWith('p6:')));
      if (!has) {
        if (key === 'sol') result.keyboard.push([
          { text: '🔐 Manual Live Buy', callback_data: `p6:b:sol:${address}` },
          { text: '🔐 Manual Live Sell', callback_data: `p6:s:sol:${address}` }
        ]);
        else result.keyboard.push([{ text: '🔒 EVM Live signer غير متصل', callback_data: `p6:u:${key}` }]);
      }
    }
    return result;
  };

  const previousBuyPreview = TradingTerminal.prototype.buyPreview;
  TradingTerminal.prototype.buyPreview = async function(network, address) {
    const result = await previousBuyPreview.call(this, network, address);
    const key = normalizeTerminalNetwork(network);
    if (key === 'sol' && result?.keyboard && isTerminalAddress(key, address)) {
      result.keyboard.push([{ text: '🔐 فتح Manual Live Buy', callback_data: `p6:b:sol:${address}` }]);
    }
    return result;
  };

  const previousHandle = TradingTerminal.prototype.handle;
  TradingTerminal.prototype.handle = async function(data) {
    const value = String(data ?? '');
    if (!value.startsWith('p6:')) return previousHandle.call(this, data);
    const parts = value.split(':');
    try {
      if (parts[1] === 'b' && parts[2] === 'sol' && parts.length >= 4) {
        const address = parts.slice(3).join(':');
        return { handled: true, text: ['🔐 MANUAL LIVE BUY', '', `SOLANA • ${short(address)}`, `Max buy: ${manualTradeCaps().maxBuySol.toFixed(4)} SOL`, `Price-impact cap: ${manualTradeCaps().maxPriceImpactPct.toFixed(2)}%`, `Slippage cap: ${(manualTradeCaps().maxSlippageBps / 100).toFixed(2)}%`, '', gateText(), 'اختر الحجم. سيتم أخذ Quote جديد قبل زر التأكيد النهائي.'].join('\n'), keyboard: buySizeKeyboard(address) };
      }
      if (parts[1] === 'bp' && parts.length >= 5) return { handled: true, ...(await prepareBuy(parts[2], parts.slice(4).join(':'))) };
      if (parts[1] === 's' && parts[2] === 'sol' && parts.length >= 4) {
        const address = parts.slice(3).join(':');
        return { handled: true, text: `🔐 MANUAL LIVE SELL\n\nSOLANA • ${short(address)}\nاختر نسبة البيع من الرصيد الفعلي. سيتم أخذ Quote جديد قبل التأكيد.\n\n${gateText()}`, keyboard: [[25, 50, 100].map((p) => ({ text: `${p}%`, callback_data: `p6:sp:${p}:sol:${address}` }))] };
      }
      if (parts[1] === 'sp' && parts.length >= 5) return { handled: true, ...(await prepareSell(parts[2], parts.slice(4).join(':'))) };
      if (parts[1] === 'c' && parts[2]) return { handled: true, ...(await confirmIntent(parts[2])) };
      if (parts[1] === 'x' && parts[2]) return { handled: true, ...(await cancelIntent(parts[2])) };
      if (parts[1] === 'a') return { handled: true, ...(await auditView()) };
      if (parts[1] === 'r') return { handled: true, ...(await liveReadiness()) };
      if (parts[1] === 'u') return { handled: true, text: '🔒 Arc / BNB / Robinhood: التحليل وPreflight جاهزان، لكن لا يوجد signer/router إنتاجي متصل بهذه الشبكات بعد. لن يتم استخدام مسار Solana لتوقيع EVM.', keyboard: [[{ text: '🏠 القائمة', callback_data: 'menu:home' }]] };
    } catch (error) {
      return { handled: true, text: `❌ Phase 6 error: ${String(error?.message ?? error).slice(0, 220)}`, keyboard: [[{ text: '📜 Audit', callback_data: 'p6:a' }]] };
    }
    return { handled: true, text: 'ℹ️ أمر Phase 6 غير معروف.', keyboard: [] };
  };

  const gate = manualLiveGate();
  console.log(`SUMMECA PHASE 6: durable audit + idempotent manual confirm + hard caps active; liveEnabled=${gate.liveEnabled} manualArmed=${gate.manualArmed}`);
}
