import { env } from '../config/env.mjs';
import { evaluateSignalSafety } from '../core/safetyGate.mjs';
import { peakExitDecision } from '../core/peakHunter.mjs';
import { scoreToken } from '../core/scoring.mjs';
import { enrichTokenSnapshot } from '../feeds/birdeye.mjs';
import { fetchDexScreenerSnapshot } from '../feeds/dexscreener.mjs';
import { telegramApi } from '../notifiers/telegram.mjs';
import { JupiterSwapClient, SOL_MINT } from './jupiterSwap.mjs';
import { PrivySolanaWallet } from './privyWallet.mjs';
import { PumpPortalSwapClient } from './pumpPortalSwap.mjs';
import { SolanaRpcClient } from './solanaRpc.mjs';

const LAMPORTS_PER_SOL = 1_000_000_000n;
const SIGNAL_MAX_AGE_MS = 90_000;
const SECURITY_REFRESH_MS = 60_000;
const SOLANA_ADDRESS = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const finite = (value, fallback = 0) => {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
};

const isRisingMomentum = (snapshot) => {
  const buys = finite(snapshot?.buys30s);
  const sells = finite(snapshot?.sells30s);
  const ratio = buys / Math.max(1, sells);
  const price5 = finite(snapshot?.priceChange5mPct);
  const volume5 = finite(snapshot?.volume5mUsd);
  const buyerAcceleration = finite(snapshot?.buyerAcceleration);
  const volumeAcceleration = finite(snapshot?.volumeAcceleration);
  return price5 >= 5
    || (ratio >= 1.8 && buys >= 4 && volume5 >= 2_000)
    || (buyerAcceleration >= 1.5 && volumeAcceleration >= 1.5 && ratio >= 1.25);
};

const isStrictSecurityVerified = (snapshot) =>
  typeof snapshot?.honeypot === 'boolean'
  && typeof snapshot?.mintAuthorityDisabled === 'boolean'
  && typeof snapshot?.freezeAuthorityDisabled === 'boolean';

const isMarketVerified = (snapshot) => {
  const price = finite(snapshot?.priceUsd);
  const activity = finite(snapshot?.buys30s) + finite(snapshot?.sells30s);
  return price > 0 && (activity > 0 || finite(snapshot?.volume5mUsd) > 0);
};

class LiveStore {
  constructor(url, secretKey) {
    this.url = String(url ?? '').replace(/\/$/, '');
    this.secretKey = String(secretKey ?? '');
  }

  async request(path, { method = 'GET', body, prefer } = {}) {
    const response = await fetch(`${this.url}/rest/v1/${path}`, {
      method,
      headers: {
        apikey: this.secretKey,
        Authorization: `Bearer ${this.secretKey}`,
        accept: 'application/json',
        ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
        ...(prefer ? { Prefer: prefer } : {})
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {})
    });
    const text = await response.text().catch(() => '');
    if (!response.ok) throw new Error(`Supabase ${method} ${path} HTTP ${response.status}${text ? `: ${text.slice(0, 180)}` : ''}`);
    return text ? JSON.parse(text) : null;
  }

  async recentStrongSignals(sinceIso) {
    const params = new URLSearchParams({
      select: 'id,token_id,created_at,signal_type,entry_score,moon_score,risk_score,reason,tokens(address,symbol,name,source,listed_at)',
      signal_type: 'in.(watch,entry)',
      entry_score: `gte.${env.entryScoreThreshold}`,
      created_at: `gte.${sinceIso}`,
      order: 'id.asc',
      limit: '25'
    });
    const rows = await this.request(`signals?${params}`);
    return Array.isArray(rows) ? rows : [];
  }

  async openTrades() {
    const params = new URLSearchParams({
      select: 'id,token_id,wallet_address,status,opened_at,entry_tx,entry_price_usd,input_sol,quantity_atomic,high_water_pnl_pct,highest_price_usd,metadata,tokens(address,symbol,name,source,listed_at)',
      wallet_address: `eq.${env.privyWalletAddress}`,
      status: 'in.(open,closing)',
      order: 'opened_at.asc'
    });
    const rows = await this.request(`live_trades?${params}`);
    return Array.isArray(rows) ? rows : [];
  }

  async hasAnyTradeForToken(tokenId) {
    const params = new URLSearchParams({ select: 'id', token_id: `eq.${tokenId}`, wallet_address: `eq.${env.privyWalletAddress}`, limit: '1' });
    const rows = await this.request(`live_trades?${params}`);
    return Array.isArray(rows) && rows.length > 0;
  }

  async insertTrade({ signal, snapshot, signature, venue, inputSol, quantityAtomic }) {
    const rows = await this.request('live_trades', {
      method: 'POST',
      prefer: 'return=representation',
      body: {
        token_id: signal.token_id,
        wallet_address: env.privyWalletAddress,
        status: 'open',
        opened_at: new Date().toISOString(),
        entry_tx: signature,
        entry_price_usd: finite(snapshot.priceUsd) || null,
        input_sol: inputSol,
        quantity_atomic: String(quantityAtomic),
        high_water_pnl_pct: 0,
        highest_price_usd: finite(snapshot.priceUsd) || null,
        metadata: {
          symbol: snapshot.symbol ?? signal.tokens?.symbol ?? null,
          venue,
          entry_score: finite(signal.entry_score),
          signal_id: signal.id,
          safety: 'strict-pass'
        }
      }
    });
    return Array.isArray(rows) ? rows[0] ?? null : null;
  }

  async updateTrade(id, patch) {
    return this.request(`live_trades?id=eq.${encodeURIComponent(id)}`, {
      method: 'PATCH',
      prefer: 'return=minimal',
      body: { ...patch, updated_at: new Date().toISOString() }
    });
  }

  async telegramChatId() {
    if (env.telegramChatId) return String(env.telegramChatId);
    const rows = await this.request('app_settings?select=value&key=eq.telegram_chat_id&limit=1');
    return String(Array.isArray(rows) ? rows[0]?.value ?? '' : '');
  }
}

class LiveAutomation {
  constructor() {
    this.store = new LiveStore(env.supabaseUrl, env.supabaseSecretKey);
    this.rpc = new SolanaRpcClient({ heliusApiKey: env.heliusApiKey });
    this.wallet = new PrivySolanaWallet({
      appId: env.privyAppId,
      appSecret: env.privyAppSecret,
      walletId: env.privyWalletId,
      walletAddress: env.privyWalletAddress,
      authorizationPrivateKey: env.privyAuthorizationPrivateKey
    });
    this.jupiter = new JupiterSwapClient({ apiKey: env.jupiterApiKey, wallet: this.wallet });
    this.pumpPortal = new PumpPortalSwapClient({
      wallet: this.wallet,
      rpc: this.rpc,
      slippagePct: env.pumpPortalSlippagePct,
      priorityFeeSol: env.pumpPortalPriorityFeeSol
    });
    this.startedAt = Date.now();
    this.processedSignals = new Set();
    this.busyTokens = new Set();
    this.lastSecurityCheck = new Map();
    this.zeroBalanceCounts = new Map();
    this.running = false;
    this.timer = null;
    this.chatId = '';
  }

  async notify(ar, en) {
    if (!env.telegramBotToken) return;
    if (!this.chatId) {
      try { this.chatId = await this.store.telegramChatId(); } catch {}
    }
    if (!this.chatId) return;
    const text = env.telegramLanguage === 'en' ? en : env.telegramLanguage === 'bilingual' ? `${ar}\n\n────────────\n\n${en}` : ar;
    await telegramApi(env.telegramBotToken, 'sendMessage', { chat_id: this.chatId, text }).catch((error) => {
      console.error('[live:telegram]', error.message);
    });
  }

  async enrich(token, { security = true } = {}) {
    const listedAt = Date.parse(token?.listed_at ?? '') || Date.now();
    let snapshot = {
      address: token.address,
      symbol: token.symbol ?? 'TOKEN',
      name: token.name ?? token.symbol ?? 'Token',
      source: token.source ?? 'solana',
      listedAt,
      observedAt: Date.now(),
      directCreate: String(token.source ?? '').toLowerCase().includes('pump')
    };
    try {
      snapshot = await enrichTokenSnapshot(env.birdeyeApiKey, snapshot, { includeSecurity: security });
    } catch (error) {
      console.warn('[live:birdeye]', token.address, error.message);
    }
    try {
      const dex = await fetchDexScreenerSnapshot(snapshot);
      if (Object.keys(dex).length) snapshot = { ...snapshot, ...dex };
    } catch (error) {
      console.warn('[live:dexscreener]', token.address, error.message);
    }
    snapshot.observedAt = Date.now();
    snapshot.marketDataVerified = isMarketVerified(snapshot);
    snapshot.securityVerified = security ? isStrictSecurityVerified(snapshot) : false;
    return snapshot;
  }

  signalEligible(signal) {
    const trigger = String(signal?.reason?.trigger ?? '');
    if (signal.signal_type === 'watch') return trigger === 'telegram-rising-momentum-signal';
    if (signal.signal_type === 'entry') return trigger === 'paper-entry';
    return false;
  }

  async calculateEntryLamports() {
    const balance = await this.rpc.getSolBalanceLamports(env.privyWalletAddress);
    const reserve = BigInt(Math.floor(env.liveMinSolReserve * 1e9));
    if (balance <= reserve) return 0n;
    const percentage = BigInt(Math.floor(env.liveEntryPercent * 100));
    const pctAmount = balance * percentage / 10_000n;
    const maxAmount = BigInt(Math.floor(env.liveMaxEntrySol * 1e9));
    const spendable = balance - reserve;
    return [pctAmount, maxAmount, spendable].reduce((a, b) => a < b ? a : b);
  }

  preferredVenue(snapshot) {
    const source = String(snapshot?.source ?? '').toLowerCase();
    return source.includes('pump') ? 'pumpportal' : 'jupiter';
  }

  async executeBuy(snapshot, lamports) {
    const mint = snapshot.address;
    const beforeTokens = await this.rpc.getTokenBalanceAtomic(env.privyWalletAddress, mint);
    const venue = this.preferredVenue(snapshot);
    let result;
    if (venue === 'pumpportal') {
      result = await this.pumpPortal.buy({ mint, solAmount: Number(lamports) / 1e9 });
    } else {
      const swap = await this.jupiter.swap({ inputMint: SOL_MINT, outputMint: mint, amount: lamports.toString() });
      result = { signature: swap.signature, venue: 'jupiter', inputSol: Number(BigInt(swap.inputAmountAtomic)) / 1e9 };
    }
    await sleep(1000);
    const afterTokens = await this.rpc.getTokenBalanceAtomic(env.privyWalletAddress, mint);
    const received = afterTokens > beforeTokens ? afterTokens - beforeTokens : 0n;
    if (received <= 0n) throw new Error(`Buy transaction landed but no token balance increase was observed: ${result.signature}`);
    return { ...result, quantityAtomic: received.toString() };
  }

  async executeSell(trade, tokenBalanceAtomic) {
    const mint = trade.tokens.address;
    const venue = String(trade?.metadata?.venue ?? '').toLowerCase();
    if (venue === 'pumpportal' || String(trade.tokens?.source ?? '').toLowerCase().includes('pump')) {
      return this.pumpPortal.sell({ mint, tokenAmountAtomic: tokenBalanceAtomic.toString() });
    }
    const swap = await this.jupiter.swap({ inputMint: mint, outputMint: SOL_MINT, amount: tokenBalanceAtomic.toString() });
    return { signature: swap.signature, venue: 'jupiter' };
  }

  async processSignal(signal) {
    const token = signal.tokens;
    if (!token?.address || !SOLANA_ADDRESS.test(token.address)) {
      this.processedSignals.add(signal.id);
      return;
    }
    if (!this.signalEligible(signal)) {
      this.processedSignals.add(signal.id);
      return;
    }
    const ageMs = Date.now() - Date.parse(signal.created_at);
    if (!Number.isFinite(ageMs) || ageMs > SIGNAL_MAX_AGE_MS) {
      this.processedSignals.add(signal.id);
      return;
    }
    if (this.busyTokens.has(token.address)) return;
    if (await this.store.hasAnyTradeForToken(signal.token_id)) {
      this.processedSignals.add(signal.id);
      return;
    }
    const open = await this.store.openTrades();
    if (open.length >= env.liveMaxOpenPositions) return;

    this.busyTokens.add(token.address);
    try {
      const snapshot = await this.enrich(token, { security: true });
      const scores = scoreToken(snapshot);
      const safety = evaluateSignalSafety(snapshot, scores);
      const rising = isRisingMomentum(snapshot);
      if (!safety.ok || !rising || scores.entry < env.entryScoreThreshold) {
        const permanentRisk = safety.emergency || scores.risk > 35 || scores.blockers?.length;
        console.log(`[live:gate] reject mint=${token.address.slice(0, 8)}… entry=${scores.entry} rising=${rising} safety=${safety.ok} reasons=${safety.reasons.join('; ')}`);
        if (permanentRisk) this.processedSignals.add(signal.id);
        return;
      }

      const lamports = await this.calculateEntryLamports();
      const minLamports = BigInt(Math.floor(env.liveMinEntrySol * 1e9));
      if (lamports < minLamports) {
        console.warn(`[live:buy] insufficient spendable SOL; amount=${Number(lamports) / 1e9}`);
        this.processedSignals.add(signal.id);
        return;
      }

      const fill = await this.executeBuy(snapshot, lamports);
      const trade = await this.store.insertTrade({
        signal,
        snapshot,
        signature: fill.signature,
        venue: fill.venue,
        inputSol: fill.inputSol,
        quantityAtomic: fill.quantityAtomic
      });
      this.processedSignals.add(signal.id);
      console.log(`[live:buy] FILLED ${snapshot.symbol} mint=${snapshot.address.slice(0, 8)}… sol=${fill.inputSol} tx=${fill.signature}`);
      await this.notify(
        `🟢 شراء تلقائي حقيقي — ${snapshot.symbol}\n\nتم اجتياز فحص السكام والزخم.\nالمبلغ: ${Number(fill.inputSol).toFixed(5)} SOL\nالمنفذ: ${fill.venue}\nEntry: ${scores.entry}/100 | Risk: ${scores.risk}/100\nStop: -${env.liveStopLossPct}%\nحماية الربح: +${env.liveProfitLockFloorPct}% بعد بلوغ +${env.liveProfitLockTriggerPct}%\nTX: ${fill.signature}\nCA: ${snapshot.address}`,
        `🟢 LIVE AUTO BUY — ${snapshot.symbol}\n\nScam and momentum gates passed.\nSize: ${Number(fill.inputSol).toFixed(5)} SOL\nVenue: ${fill.venue}\nEntry: ${scores.entry}/100 | Risk: ${scores.risk}/100\nStop: -${env.liveStopLossPct}%\nProfit lock: +${env.liveProfitLockFloorPct}% after reaching +${env.liveProfitLockTriggerPct}%\nTX: ${fill.signature}\nCA: ${snapshot.address}`
      );
      if (!trade?.id) console.warn('[live:buy] trade filled but database row was not returned');
    } catch (error) {
      console.error(`[live:buy] ${token.address}`, error.message);
      // Execution errors are treated as terminal for this signal to avoid accidental
      // duplicate buys after an ambiguous network timeout.
      this.processedSignals.add(signal.id);
      await this.notify(
        `⚠️ تعذر تنفيذ الشراء الحقيقي لـ ${token.symbol ?? 'TOKEN'}\nلم تتم إعادة المحاولة تلقائيًا لتجنب شراء مكرر.\nالسبب: ${error.message}`,
        `⚠️ LIVE BUY failed for ${token.symbol ?? 'TOKEN'}\nNo automatic retry was attempted to avoid a duplicate buy.\nReason: ${error.message}`
      );
    } finally {
      this.busyTokens.delete(token.address);
    }
  }

  async monitorTrade(trade) {
    const token = trade.tokens;
    if (!token?.address || this.busyTokens.has(token.address)) return;
    this.busyTokens.add(token.address);
    try {
      const now = Date.now();
      const needSecurity = now - Number(this.lastSecurityCheck.get(token.address) ?? 0) >= SECURITY_REFRESH_MS;
      const snapshot = await this.enrich(token, { security: needSecurity });
      if (needSecurity) this.lastSecurityCheck.set(token.address, now);

      // Market-only refreshes deliberately do not convert missing security data into
      // an emergency. Full scam checks are repeated at least once a minute.
      let safety = { ok: true, emergency: false, reasons: [], emergencyReasons: [] };
      const scores = scoreToken(snapshot);
      if (needSecurity) safety = evaluateSignalSafety(snapshot, scores);

      const entryPrice = finite(trade.entry_price_usd);
      const currentPrice = finite(snapshot.priceUsd);
      if (!(entryPrice > 0 && currentPrice > 0)) return;
      const pnlPct = (currentPrice / entryPrice - 1) * 100;
      const previousHigh = finite(trade.high_water_pnl_pct);
      const highWater = Math.max(previousHigh, pnlPct);
      const highestPrice = Math.max(finite(trade.highest_price_usd), currentPrice);
      await this.store.updateTrade(trade.id, { high_water_pnl_pct: highWater, highest_price_usd: highestPrice });

      let decision = peakExitDecision({
        snapshot,
        scores,
        pnlPct,
        highWaterPnlPct: highWater,
        stopLossPct: env.liveStopLossPct,
        peakHunterStartPct: env.peakHunterStartPct,
        profitLockTriggerPct: env.liveProfitLockTriggerPct,
        profitLockFloorPct: env.liveProfitLockFloorPct
      });
      if (decision.reason === 'paper stop-loss') decision = { ...decision, reason: 'live stop-loss' };
      if (safety.emergency) decision = { exit: true, reason: `emergency-risk: ${safety.emergencyReasons.join(', ') || safety.reasons.join(', ')}` };
      if (!decision.exit) return;

      await this.store.updateTrade(trade.id, { status: 'closing', exit_reason: decision.reason });
      const balance = await this.rpc.getTokenBalanceAtomic(env.privyWalletAddress, token.address);
      if (balance <= 0n) {
        const count = (this.zeroBalanceCounts.get(token.address) ?? 0) + 1;
        this.zeroBalanceCounts.set(token.address, count);
        await this.store.updateTrade(trade.id, { status: 'open' });
        if (count < 3) return;
        await this.store.updateTrade(trade.id, {
          status: 'closed',
          closed_at: new Date().toISOString(),
          exit_price_usd: currentPrice,
          exit_reason: 'wallet token balance is zero (external/manual exit detected)'
        });
        return;
      }
      this.zeroBalanceCounts.delete(token.address);

      try {
        const fill = await this.executeSell(trade, balance);
        await this.store.updateTrade(trade.id, {
          status: 'closed',
          closed_at: new Date().toISOString(),
          exit_tx: fill.signature,
          exit_price_usd: currentPrice,
          quantity_atomic: balance.toString(),
          exit_reason: decision.reason,
          high_water_pnl_pct: highWater,
          highest_price_usd: highestPrice
        });
        console.log(`[live:sell] FILLED ${token.symbol ?? 'TOKEN'} pnl=${pnlPct.toFixed(1)}% reason=${decision.reason} tx=${fill.signature}`);
        await this.notify(
          `🔴 بيع تلقائي حقيقي — ${token.symbol ?? 'TOKEN'}\n\nالسبب: ${decision.reason}\nالعائد المرصود تقريبًا: ${pnlPct.toFixed(1)}%\nالقمة المرصودة: ${highWater.toFixed(1)}%\nTX: ${fill.signature}\nCA: ${token.address}`,
          `🔴 LIVE AUTO SELL — ${token.symbol ?? 'TOKEN'}\n\nReason: ${decision.reason}\nObserved return (approx): ${pnlPct.toFixed(1)}%\nObserved peak: ${highWater.toFixed(1)}%\nTX: ${fill.signature}\nCA: ${token.address}`
        );
      } catch (error) {
        // A failed/ambiguous exit must remain visible and retriable. Set it back to
        // open so the next poll can protect the position again.
        await this.store.updateTrade(trade.id, { status: 'open', exit_reason: `last sell error: ${error.message}` });
        throw error;
      }
    } catch (error) {
      console.error(`[live:monitor] ${token?.address ?? trade.id}`, error.message);
    } finally {
      this.busyTokens.delete(token?.address ?? trade.id);
    }
  }

  async cycle() {
    if (this.running) return;
    this.running = true;
    try {
      const since = new Date(Math.max(this.startedAt - 5000, Date.now() - SIGNAL_MAX_AGE_MS)).toISOString();
      const [signals, trades] = await Promise.all([
        this.store.recentStrongSignals(since),
        this.store.openTrades()
      ]);
      for (const trade of trades) await this.monitorTrade(trade);
      for (const signal of signals) {
        if (!this.processedSignals.has(signal.id)) await this.processSignal(signal);
      }
    } catch (error) {
      console.error('[live:cycle]', error.message);
    } finally {
      this.running = false;
    }
  }

  async start() {
    if (!env.liveTradingEnabled) {
      console.log('SUMMECA LIVE AUTO: 🔒 LOCKED — LIVE_TRADING_ENABLED=false');
      return false;
    }
    if (!this.wallet.configured || !this.jupiter.configured || !this.pumpPortal.configured) {
      throw new Error('Live trading is enabled but secure execution clients are not configured');
    }
    const balance = await this.rpc.getSolBalanceLamports(env.privyWalletAddress);
    console.log(`SUMMECA LIVE AUTO: 🟢 ARMED wallet=${env.privyWalletAddress.slice(0, 6)}… balance=${(Number(balance) / 1e9).toFixed(5)} SOL entry=${env.liveEntryPercent}% max=${env.liveMaxEntrySol} SOL positions=${env.liveMaxOpenPositions}`);
    await this.notify(
      `🟢 التداول الحقيقي الآلي أصبح مسلحًا\nالمحفظة المنفصلة: ${env.privyWalletAddress}\nالدخول: ${env.liveEntryPercent}% بحد أقصى ${env.liveMaxEntrySol} SOL\nأقصى صفقات مفتوحة: ${env.liveMaxOpenPositions}\nStop: -${env.liveStopLossPct}%`,
      `🟢 LIVE AUTO TRADING ARMED\nDedicated wallet: ${env.privyWalletAddress}\nEntry: ${env.liveEntryPercent}% capped at ${env.liveMaxEntrySol} SOL\nMax open positions: ${env.liveMaxOpenPositions}\nStop: -${env.liveStopLossPct}%`
    );
    await this.cycle();
    this.timer = setInterval(() => void this.cycle(), env.livePollMs);
    return true;
  }
}

let instance = null;
export async function startLiveAutomation() {
  if (instance) return instance;
  instance = new LiveAutomation();
  await instance.start();
  return instance;
}
