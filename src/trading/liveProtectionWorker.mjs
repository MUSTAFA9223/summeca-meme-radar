import crypto from 'node:crypto';
import { isMainThread, parentPort } from 'node:worker_threads';
import { env } from '../config/env.mjs';
import { fetchTokenOverview, fetchTokenSecurity } from '../feeds/birdeye.mjs';
import { fetchDexScreenerSnapshot } from '../feeds/dexscreener.mjs';
import { HardeningStore } from '../storage/hardeningStore.mjs';
import { AppSettings } from '../storage/appSettings.mjs';
import { DEFAULT_STOP_LADDER_CONFIG, STOP_LADDER_KEY, normalizeStopLadderConfig } from './stopLadder.mjs';
import { JupiterSwapClient, SOL_MINT } from './jupiterSwap.mjs';
import { PrivySolanaWallet } from './privyWallet.mjs';
import { SolanaRpcClient, parseMintSecurityAccount } from './solanaRpc.mjs';
import {
  advanceProtectionState,
  initialProtectionState,
  liquidityEmergency,
  protectionSettings
} from './liveProtectionPolicy.mjs';

const PUBLICNODE_SOLANA_RPC = 'https://solana-rpc.publicnode.com';
const PUBLIC_SOLANA_RPC = 'https://api.mainnet-beta.solana.com';
const LAMPORTS_PER_SOL = 1_000_000_000;
const finite = (value, fallback = 0) => Number.isFinite(Number(value)) ? Number(value) : fallback;
const isoNow = () => new Date().toISOString();
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const asAtomic = (value) => /^\d+$/.test(String(value ?? '')) ? BigInt(String(value)) : 0n;
const short = (value) => {
  const s = String(value ?? '');
  return s.length > 16 ? `${s.slice(0, 7)}…${s.slice(-5)}` : s;
};

async function fetchJson(url, options = {}, timeoutMs = 5_000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, { ...options, signal: controller.signal });
    const text = await response.text().catch(() => '');
    let body = null;
    try { body = text ? JSON.parse(text) : null; } catch { body = text; }
    if (!response.ok) throw new Error(body?.errorMessage ?? body?.error ?? `HTTP ${response.status}`);
    return body;
  } finally {
    clearTimeout(timer);
  }
}

async function rawSolanaRpc(endpoint, method, params = []) {
  const body = await fetchJson(endpoint, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: `protect-${Date.now()}`, method, params })
  }, 5_500);
  if (body?.error) throw new Error(body.error.message || `RPC ${body.error.code}`);
  return body?.result;
}

export function riskSignalReason(signal) {
  const reason = signal?.reason;
  const text = typeof reason === 'string' ? reason : JSON.stringify(reason ?? {});
  if (/developer.{0,24}(sell|dump)|deployer.{0,24}(sell|dump)|insider.{0,24}(sell|dump)|creator.{0,24}(sell|dump)/i.test(text)) {
    return text.slice(0, 220);
  }
  return '';
}

function validPrice(value) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : null;
}

function validLiquidity(value) {
  const n = Number(value);
  return Number.isFinite(n) && n >= 0 ? n : null;
}

function quotePnlPct(outAmountAtomic, costBasisSol) {
  const out = asAtomic(outAmountAtomic);
  const cost = finite(costBasisSol);
  if (out <= 0n || !(cost > 0)) return null;
  const outputSol = Number(out) / LAMPORTS_PER_SOL;
  return (outputSol / cost - 1) * 100;
}

export class LiveProtectionEngine {
  constructor({
    store = new HardeningStore(),
    settings = protectionSettings(),
    rpc = new SolanaRpcClient({ heliusApiKey: env.heliusApiKey }),
    wallet = new PrivySolanaWallet({
      appId: env.privyAppId,
      appSecret: env.privyAppSecret,
      walletId: env.privyWalletId,
      walletAddress: env.privyWalletAddress,
      authorizationPrivateKey: env.privyAuthorizationPrivateKey
    }),
    jupiter = null,
    broadcastEnabled = env.liveTradingEnabled,
    marketProvider = null,
    securityProvider = null,
    balanceReader = null,
    signatureReader = null,
    now = () => Date.now()
  } = {}) {
    this.store = store;
    this.settings = settings;
    this.rpc = rpc;
    this.wallet = wallet;
    this.jupiter = jupiter ?? new JupiterSwapClient({ apiKey: env.jupiterApiKey, wallet });
    this.broadcastEnabled = Boolean(broadcastEnabled);
    this.marketProvider = marketProvider;
    this.securityProvider = securityProvider;
    this.balanceReader = balanceReader;
    this.signatureReader = signatureReader;
    this.now = now;
    this.marketCache = new Map();
    this.birdeyeCache = new Map();
    this.quoteCache = new Map();
    this.securityCache = new Map();
    this.sellabilityFailures = new Map();
    this.dryTriggerCache = new Map();
    this.walletJupiter = new Map();
    this.lastRecoveryScanAt = 0;
    this.appSettings = new AppSettings(env.supabaseUrl, env.supabaseSecretKey);
    this.stopLadderConfig = normalizeStopLadderConfig(DEFAULT_STOP_LADDER_CONFIG);
    this.lastStopLadderRefreshAt = 0;
    this.running = false;
    this.timer = null;
  }

  rpcEndpoints() {
    return [
      env.heliusApiKey ? `https://mainnet.helius-rpc.com/?api-key=${encodeURIComponent(env.heliusApiKey)}` : '',
      PUBLICNODE_SOLANA_RPC,
      PUBLIC_SOLANA_RPC
    ].filter(Boolean);
  }

  async refreshStopLadderConfig() {
    if (!this.appSettings.enabled) return this.stopLadderConfig;
    if (this.now() - this.lastStopLadderRefreshAt < 10_000) return this.stopLadderConfig;
    this.lastStopLadderRefreshAt = this.now();
    const raw = await this.appSettings.get(STOP_LADDER_KEY).catch(() => '');
    this.stopLadderConfig = normalizeStopLadderConfig(raw || DEFAULT_STOP_LADDER_CONFIG);
    return this.stopLadderConfig;
  }

  async readTokenBalance(mint, walletAddress = env.privyWalletAddress) {
    if (this.balanceReader) return BigInt(await this.balanceReader(mint, walletAddress));
    let lastError = null;
    for (const endpoint of this.rpcEndpoints()) {
      try {
        const result = await rawSolanaRpc(endpoint, 'getTokenAccountsByOwner', [
          String(walletAddress),
          { mint: String(mint) },
          { encoding: 'jsonParsed', commitment: 'confirmed' }
        ]);
        let total = 0n;
        for (const item of Array.isArray(result?.value) ? result.value : []) {
          const amount = item?.account?.data?.parsed?.info?.tokenAmount?.amount;
          if (/^\d+$/.test(String(amount ?? ''))) total += BigInt(amount);
        }
        return total;
      } catch (error) {
        lastError = error;
      }
    }
    throw lastError || new Error('all Solana RPC balance providers failed');
  }

  executionWalletForTrade(trade) {
    return {
      id: String(trade?.metadata?.wallet_id || env.privyWalletId || ''),
      address: String(trade?.wallet_address || env.privyWalletAddress || ''),
      label: String(trade?.metadata?.wallet_label || 'SUMMECA Trading Wallet')
    };
  }

  jupiterForTrade(trade) {
    const walletInfo = this.executionWalletForTrade(trade);
    if (!walletInfo.id || !walletInfo.address) return this.jupiter;
    if (walletInfo.id === String(env.privyWalletId || '') && walletInfo.address === String(env.privyWalletAddress || '')) {
      return this.jupiter;
    }
    const cached = this.walletJupiter.get(walletInfo.id);
    if (cached) return cached;
    const wallet = new PrivySolanaWallet({
      appId: env.privyAppId,
      appSecret: env.privyAppSecret,
      walletId: walletInfo.id,
      walletAddress: walletInfo.address,
      authorizationPrivateKey: env.privyAuthorizationPrivateKey
    });
    const client = new JupiterSwapClient({ apiKey: env.jupiterApiKey, wallet });
    this.walletJupiter.set(walletInfo.id, client);
    return client;
  }

  async signatureStatus(signature) {
    if (!signature) return { known: true, status: null };
    if (this.signatureReader) return this.signatureReader(signature);
    let lastError = null;
    for (const endpoint of this.rpcEndpoints()) {
      try {
        const result = await rawSolanaRpc(endpoint, 'getSignatureStatuses', [[String(signature)], { searchTransactionHistory: true }]);
        return { known: true, status: result?.value?.[0] ?? null };
      } catch (error) {
        lastError = error;
      }
    }
    throw lastError || new Error('all Solana RPC signature providers failed');
  }

  async birdeyeMarket(token) {
    const key = String(token.address);
    const cached = this.birdeyeCache.get(key);
    const ttl = Math.max(10_000, this.settings.marketRefreshMs * 3);
    if (cached && this.now() - cached.at < ttl) return cached.value;
    try {
      const value = await fetchTokenOverview(env.birdeyeApiKey, key);
      this.birdeyeCache.set(key, { at: this.now(), value });
      return value;
    } catch (error) {
      if (cached) return cached.value;
      console.warn(`[live-protect:birdeye] mint=${short(key)} ${String(error?.message ?? error)}`);
      return {};
    }
  }

  async marketSnapshot(token) {
    const key = String(token.address);
    const cached = this.marketCache.get(key);
    if (cached && this.now() - cached.at < this.settings.marketRefreshMs) return cached.value;

    if (this.marketProvider) {
      const value = await this.marketProvider(token);
      this.marketCache.set(key, { at: this.now(), value });
      return value;
    }

    const base = {
      address: key,
      symbol: token.symbol ?? 'TOKEN',
      name: token.name ?? token.symbol ?? 'Token',
      source: token.source ?? 'manual-confirm-live',
      listedAt: Date.parse(token.listed_at ?? '') || this.now()
    };
    const [dexResult, birdResult] = await Promise.allSettled([
      fetchDexScreenerSnapshot(base, { timeoutMs: 3_500 }),
      this.birdeyeMarket(token)
    ]);
    const dex = dexResult.status === 'fulfilled' ? dexResult.value : {};
    const bird = birdResult.status === 'fulfilled' ? birdResult.value : {};
    const dexPrice = validPrice(dex?.priceUsd);
    const birdPrice = validPrice(bird?.priceUsd);
    const dexLiquidity = validLiquidity(dex?.liquidityUsd);
    const birdLiquidity = validLiquidity(bird?.liquidityUsd);
    const value = {
      priceUsd: birdPrice ?? dexPrice,
      liquidityUsd: dexLiquidity ?? birdLiquidity,
      priceSources: [
        birdPrice ? 'birdeye' : null,
        dexPrice ? String(dex?.source || 'dexscreener/gecko') : null
      ].filter(Boolean),
      liquiditySource: dexLiquidity != null ? String(dex?.source || 'dexscreener/gecko') : birdLiquidity != null ? 'birdeye' : null,
      observedAt: this.now()
    };
    if (!value.priceUsd && cached?.value?.priceUsd) {
      value.priceUsd = cached.value.priceUsd;
      value.priceSources = [...(value.priceSources || []), 'cache'];
    }
    this.marketCache.set(key, { at: this.now(), value });
    return value;
  }

  async freshMintSecurity(mint) {
    let lastError = null;
    for (const endpoint of this.rpcEndpoints()) {
      try {
        const result = await rawSolanaRpc(endpoint, 'getAccountInfo', [
          String(mint),
          { encoding: 'jsonParsed', commitment: 'confirmed' }
        ]);
        return parseMintSecurityAccount(result);
      } catch (error) {
        lastError = error;
      }
    }
    throw lastError || new Error('all Solana RPC mint-security providers failed');
  }

  async securitySnapshot(mint) {
    const key = String(mint);
    const cached = this.securityCache.get(key);
    if (cached && this.now() - cached.at < this.settings.securityRefreshMs) return cached.value;
    if (this.securityProvider) {
      const value = await this.securityProvider(key);
      this.securityCache.set(key, { at: this.now(), value });
      return value;
    }

    const [onchainResult, birdResult] = await Promise.allSettled([
      this.freshMintSecurity(key),
      env.birdeyeApiKey ? fetchTokenSecurity(env.birdeyeApiKey, key) : Promise.resolve({})
    ]);
    const onchain = onchainResult.status === 'fulfilled' ? onchainResult.value : {};
    const bird = birdResult.status === 'fulfilled' ? birdResult.value : {};
    if (!Object.keys(onchain).length && !Object.keys(bird).length) {
      if (cached) return cached.value;
      throw new Error('security providers unavailable');
    }
    const value = { ...bird, ...onchain, observedAt: this.now() };
    this.securityCache.set(key, { at: this.now(), value });
    return value;
  }

  costBasisSol(trade, targetAtomic = null) {
    const metadataCost = finite(trade?.metadata?.remaining_cost_basis_sol, NaN);
    const fullCost = Number.isFinite(metadataCost) && metadataCost > 0 ? metadataCost : finite(trade?.input_sol);
    if (!(fullCost > 0)) return 0;
    const recorded = asAtomic(trade?.quantity_atomic);
    const target = targetAtomic == null ? recorded : BigInt(targetAtomic);
    if (recorded > 0n && target > 0n && target < recorded) {
      return fullCost * Number(target) / Number(recorded);
    }
    return fullCost;
  }

  async sellQuote(trade, amountAtomic) {
    const key = `${trade.id}:${amountAtomic}`;
    const cached = this.quoteCache.get(key);
    if (cached && this.now() - cached.at < this.settings.quoteRefreshMs) return cached.value;

    const params = new URLSearchParams({
      inputMint: String(trade.tokens.address),
      outputMint: SOL_MINT,
      amount: String(amountAtomic),
      slippageBps: String(this.settings.quoteSlippageBps),
      restrictIntermediateTokens: 'true'
    });
    const headers = { accept: 'application/json' };
    if (env.jupiterApiKey) headers['x-api-key'] = env.jupiterApiKey;
    try {
      const quote = await fetchJson(`https://api.jup.ag/swap/v1/quote?${params}`, { headers }, 4_500);
      if (!/^\d+$/.test(String(quote?.outAmount ?? '')) || BigInt(quote.outAmount) <= 0n) {
        throw new Error('Jupiter sell quote has no positive outAmount');
      }
      const value = {
        quote,
        outAmountAtomic: String(quote.outAmount),
        routePnlPct: quotePnlPct(quote.outAmount, this.costBasisSol(trade, amountAtomic))
      };
      this.quoteCache.set(key, { at: this.now(), value });
      this.sellabilityFailures.set(trade.id, 0);
      return value;
    } catch (error) {
      const failures = (this.sellabilityFailures.get(trade.id) ?? 0) + 1;
      this.sellabilityFailures.set(trade.id, failures);
      throw Object.assign(new Error(String(error?.message ?? error)), { sellabilityFailures: failures });
    }
  }

  async reliableEmergencyReasons(trade, market, security, quoteError = null) {
    const reasons = [];
    const entryLiquidity = finite(trade?.metadata?.entry_liquidity_usd, 0);
    if (market?.liquidityUsd != null) {
      const liquidity = liquidityEmergency({
        currentLiquidityUsd: market.liquidityUsd,
        entryLiquidityUsd: entryLiquidity
      }, this.settings);
      if (liquidity.emergency) {
        reasons.push(`liquidity-collapse:${finite(market.liquidityUsd).toFixed(0)}<${finite(liquidity.thresholdUsd).toFixed(0)}`);
      }
    }

    if (security) {
      if (security.mintAuthorityDisabled === false) reasons.push('mint-authority-became-active');
      if (security.freezeAuthorityDisabled === false) reasons.push('freeze-authority-became-active');
      if (security.honeypot === true) reasons.push('honeypot-provider-flag');
      if (security.fakeToken === true) reasons.push('fake-token-provider-flag');
      if (security.nonTransferable === true) reasons.push('token-non-transferable');
      if (Array.isArray(security.token2022UnsafeExtensions) && security.token2022UnsafeExtensions.length) {
        reasons.push(`unsafe-token2022:${security.token2022UnsafeExtensions.join(',')}`);
      }
    }

    if (quoteError && Number(quoteError.sellabilityFailures || 0) >= this.settings.sellabilityFailures) {
      reasons.push(`sellability-route-failed:${quoteError.sellabilityFailures}`);
    }

    try {
      const sinceIso = new Date(this.now() - this.settings.riskSignalMaxAgeMs).toISOString();
      const signal = await this.store.latestRiskSignal(trade.token_id, sinceIso);
      const reason = riskSignalReason(signal);
      if (reason) reasons.push(`trusted-risk-signal:${reason}`);
    } catch (error) {
      console.warn(`[live-protect:risk-signal] trade=${trade.id} ${String(error?.message ?? error)}`);
    }
    return reasons;
  }

  async auditDryTrigger(trade, reason, state) {
    const window = Math.floor(this.now() / 60_000);
    const digest = crypto.createHash('sha256').update(String(reason)).digest('hex').slice(0, 10);
    const requestId = `protect-dry:${trade.id}:${window}:${digest}`;
    if (this.dryTriggerCache.has(requestId)) return;
    this.dryTriggerCache.set(requestId, this.now());
    const existing = await this.store.getAudit(requestId).catch(() => null);
    if (existing) return;
    await this.store.createAudit({
      request_id: requestId,
      network: 'sol',
      token_address: trade.tokens.address,
      side: 'sell',
      status: 'blocked',
      error: 'LIVE_TRADING_ENABLED=false',
      payload: {
        mode: 'live-protection',
        live_trade_id: trade.id,
        trigger: reason,
        safeMode: true,
        currentStop: state.currentStop,
        highWaterPnlPct: state.highWaterPnlPct,
        pnlPct: state.pnlPct
      }
    }).catch((error) => {
      console.warn(`[live-protect:audit-dry] trade=${trade.id} ${String(error?.message ?? error)}`);
    });
  }

  async monitorOpenTrade(trade) {
    const token = trade.tokens;
    if (!token?.address) return;
    let market = null;
    let security = null;
    let quote = null;
    let quoteError = null;

    try { market = await this.marketSnapshot(token); }
    catch (error) { console.warn(`[live-protect:market] mint=${short(token.address)} ${String(error?.message ?? error)}`); }

    try { security = await this.securitySnapshot(token.address); }
    catch (error) { console.warn(`[live-protect:security] mint=${short(token.address)} ${String(error?.message ?? error)}`); }

    const balance = await this.readTokenBalance(token.address, trade.wallet_address).catch((error) => {
      console.warn(`[live-protect:balance] mint=${short(token.address)} ${String(error?.message ?? error)}`);
      return null;
    });
    const recorded = asAtomic(trade.quantity_atomic);
    const amount = balance == null ? recorded : recorded > 0n ? (balance < recorded ? balance : recorded) : balance;
    if (balance != null && balance <= 0n) {
      await this.store.updateLiveTrade(trade.id, {
        status: 'closed',
        closed_at: isoNow(),
        exit_reason: 'wallet-token-balance-zero-external-or-manual-exit',
        quantity_atomic: '0',
        last_protection_check_at: isoNow()
      });
      return;
    }

    if (amount > 0n) {
      try { quote = await this.sellQuote(trade, amount); }
      catch (error) { quoteError = error; }
    }

    let entryPrice = validPrice(trade.entry_price_usd);
    if (!entryPrice) entryPrice = validPrice(market?.priceUsd);
    const ladderConfig = await this.refreshStopLadderConfig();
    const state = advanceProtectionState({
      entryPriceUsd: entryPrice,
      currentPriceUsd: market?.priceUsd,
      routePnlPct: quote?.routePnlPct,
      previousHighestPriceUsd: trade.highest_price_usd,
      previousHighWaterPnlPct: trade.high_water_pnl_pct,
      previousCurrentStop: trade.current_stop
    }, {
      ...this.settings,
      stopLossPct: ladderConfig.initialStopLossPct,
      stopLadder: ladderConfig.levels
    });
    const nextStopReason = state.stopReason === 'hold-stop'
      ? (trade.stop_reason || 'initial-stop')
      : state.stopReason;

    const patch = {
      ...(entryPrice ? { entry_price_usd: entryPrice } : {}),
      ...(state.highestPriceUsd ? { highest_price_usd: state.highestPriceUsd } : {}),
      high_water_pnl_pct: state.highWaterPnlPct,
      current_stop: state.currentStop,
      stop_reason: nextStopReason,
      last_protection_check_at: isoNow(),
      last_price_source: Array.isArray(market?.priceSources) && market.priceSources.length ? market.priceSources.join('+') : 'jupiter-route'
    };
    await this.store.updateLiveTrade(trade.id, patch);

    const emergencyReasons = await this.reliableEmergencyReasons(trade, market, security, quoteError);
    const triggered = state.triggered || emergencyReasons.length > 0;
    if (!triggered) return;

    const reason = emergencyReasons.length
      ? `emergency:${emergencyReasons.join('|')}`
      : `stop:${nextStopReason}@${state.currentStop.toFixed(2)}% pnl=${finite(state.pnlPct).toFixed(2)}%`;
    console.warn(`[live-protect:trigger] trade=${trade.id} mint=${short(token.address)} reason=${reason}`);

    if (!this.broadcastEnabled) {
      await this.auditDryTrigger(trade, reason, state);
      return;
    }
    await this.attemptSell({ ...trade, ...patch }, reason, {
      state,
      market,
      balance,
      amountAtomic: amount
    });
  }

  async attemptSell(trade, reason, context = {}) {
    const token = trade.tokens;
    const requestId = `protect:${trade.id}:${crypto.randomUUID()}`;
    const claimed = await this.store.claimLiveTradeForSell(trade.id, requestId, reason);
    if (!claimed) {
      console.log(`[live-protect:duplicate-lock] trade=${trade.id} another sell owns the DB lock`);
      return { locked: false };
    }

    let balance;
    try {
      balance = context.balance != null ? BigInt(context.balance) : await this.readTokenBalance(token.address, trade.wallet_address);
    } catch (error) {
      await this.store.releaseLiveTradeSell(trade.id, requestId, { exit_reason: `protection-balance-read-failed: ${String(error?.message ?? error).slice(0, 180)}` });
      return { locked: true, broadcast: false, error };
    }

    const recorded = asAtomic(trade.quantity_atomic);
    const target = context.amountAtomic != null
      ? BigInt(context.amountAtomic)
      : recorded > 0n ? (balance < recorded ? balance : recorded) : balance;
    if (target <= 0n || balance <= 0n) {
      await this.store.updateLiveTrade(trade.id, {
        status: 'closed',
        closed_at: isoNow(),
        quantity_atomic: '0',
        exit_reason: 'wallet-token-balance-zero-before-protection-sell',
        sell_lock_request_id: null,
        sell_broadcast_at: null
      });
      return { locked: true, broadcast: false, closed: true };
    }

    const costBasisSol = this.costBasisSol(trade, target);
    const audit = await this.store.createAudit({
      request_id: requestId,
      network: 'sol',
      token_address: token.address,
      side: 'sell',
      status: 'prepared',
      payload: {
        mode: 'live-protection',
        live_trade_id: trade.id,
        trigger: reason,
        balanceBeforeAtomic: balance.toString(),
        targetAmountAtomic: target.toString(),
        costBasisSol,
        currentStop: context.state?.currentStop ?? trade.current_stop ?? null,
        highWaterPnlPct: context.state?.highWaterPnlPct ?? trade.high_water_pnl_pct ?? null,
        pnlPct: context.state?.pnlPct ?? null,
        marketPriceUsd: context.market?.priceUsd ?? null,
        protectionStartedAt: trade.protection_started_at ?? null
      }
    }).catch(async (error) => {
      await this.store.releaseLiveTradeSell(trade.id, requestId, { exit_reason: `protection-audit-create-failed: ${String(error?.message ?? error).slice(0, 180)}` }).catch(() => {});
      throw error;
    });

    if (!audit) {
      await this.store.releaseLiveTradeSell(trade.id, requestId, { exit_reason: 'protection-audit-create-returned-empty' });
      return { locked: true, broadcast: false };
    }

    const executionClient = this.jupiterForTrade(trade);
    if (!executionClient?.configured) {
      await this.store.updateAudit(requestId, { status: 'failed', error: 'wallet-specific Jupiter/Privy client is not configured' }).catch(() => {});
      await this.store.releaseLiveTradeSell(trade.id, requestId, { exit_reason: 'wallet-specific-protection-client-unavailable' });
      return { locked: true, broadcast: false };
    }

    let order;
    try {
      order = await executionClient.getOrder({ inputMint: token.address, outputMint: SOL_MINT, amount: target.toString() });
    } catch (error) {
      await this.store.updateAudit(requestId, {
        status: 'failed',
        error: `pre-broadcast route failed: ${String(error?.message ?? error).slice(0, 240)}`,
        payload: { ...(audit.payload || {}), executionUncertain: false, failedAt: isoNow() }
      });
      await this.store.releaseLiveTradeSell(trade.id, requestId, { exit_reason: `protection-route-failed: ${String(error?.message ?? error).slice(0, 160)}` });
      console.error(`[live-protect:sell-prebroadcast] trade=${trade.id} ${String(error?.message ?? error)}`);
      return { locked: true, broadcast: false, error };
    }

    const broadcasting = await this.store.transitionAudit(requestId, 'prepared', 'broadcasting', {
      payload: {
        ...(audit.payload || {}),
        router: order?.router ?? null,
        executionRequestId: order?.requestId ?? null,
        executionStartedAt: isoNow()
      }
    });
    if (!broadcasting) {
      await this.store.releaseLiveTradeSell(trade.id, requestId, { exit_reason: 'protection-audit-broadcast-lock-lost' });
      return { locked: true, broadcast: false };
    }
    await this.store.updateLiveTrade(trade.id, { sell_broadcast_at: isoNow() });

    try {
      const execution = await executionClient.executeOrder(order);
      const outputAtomic = String(execution?.totalOutputAmount ?? execution?.outputAmountResult ?? order?.outAmount ?? '0');
      await this.store.updateAudit(requestId, {
        status: 'succeeded',
        tx_hash: String(execution.signature),
        error: null,
        payload: {
          ...(broadcasting.payload || {}),
          executionUncertain: false,
          executionFinishedAt: isoNow(),
          outputAmountAtomic: outputAtomic
        }
      });
      await this.closeTradeFromExecution(trade, {
        requestId,
        signature: String(execution.signature),
        outputAmountAtomic: outputAtomic,
        targetAmountAtomic: target,
        reason,
        marketPriceUsd: context.market?.priceUsd ?? null
      });
      console.log(`[live-protect:sell] FILLED trade=${trade.id} mint=${short(token.address)} tx=${short(execution.signature)} reason=${reason}`);
      return { locked: true, broadcast: true, succeeded: true, signature: execution.signature };
    } catch (error) {
      const message = String(error?.message ?? error).slice(0, 300);
      const knownSignature = error?.signature ? String(error.signature) : null;
      await this.store.updateAudit(requestId, {
        status: 'failed',
        ...(knownSignature ? { tx_hash: knownSignature } : {}),
        error: message,
        payload: {
          ...(broadcasting.payload || {}),
          executionUncertain: true,
          automaticRetryDisabled: true,
          failedAfterBroadcastAt: isoNow(),
          ...(knownSignature ? { candidateSignature: knownSignature } : {})
        }
      }).catch(() => {});
      await this.store.updateLiveTrade(trade.id, {
        status: 'closing',
        exit_reason: `post-broadcast-uncertain: ${reason}`,
        sell_broadcast_at: claimed.sell_broadcast_at || isoNow()
      }).catch(() => {});
      console.error(`[live-protect:sell-uncertain] trade=${trade.id} no blind retry; ${message}`);
      return { locked: true, broadcast: true, uncertain: true, error };
    }
  }

  async closeTradeFromExecution(trade, {
    requestId,
    signature,
    outputAmountAtomic = '0',
    targetAmountAtomic = 0n,
    reason,
    marketPriceUsd = null,
    inferred = false
  }) {
    const output = asAtomic(outputAmountAtomic);
    const exitAmountSol = output > 0n ? Number(output) / LAMPORTS_PER_SOL : null;
    const costBasisSol = this.costBasisSol(trade, BigInt(targetAmountAtomic || 0));
    const realizedPnlSol = exitAmountSol != null && costBasisSol > 0 ? exitAmountSol - costBasisSol : null;
    const realizedPnlPct = realizedPnlSol != null && costBasisSol > 0 ? realizedPnlSol / costBasisSol * 100 : null;
    const metadata = {
      ...(trade.metadata || {}),
      protection_exit: {
        request_id: requestId,
        reason,
        inferred,
        target_amount_atomic: String(targetAmountAtomic || 0),
        output_amount_atomic: String(outputAmountAtomic || '0'),
        at: isoNow()
      },
      remaining_cost_basis_sol: 0
    };
    await this.store.updateLiveTrade(trade.id, {
      status: 'closed',
      closed_at: isoNow(),
      exit_tx: signature || null,
      exit_price_usd: validPrice(marketPriceUsd),
      exit_reason: reason,
      quantity_atomic: '0',
      ...(exitAmountSol != null ? { exit_amount_sol: exitAmountSol } : {}),
      ...(realizedPnlSol != null ? { realized_pnl_sol: realizedPnlSol } : {}),
      ...(realizedPnlPct != null ? { realized_pnl_pct: realizedPnlPct } : {}),
      sell_lock_request_id: null,
      metadata
    });
  }

  async reconcileClosingTrade(trade) {
    const requestId = String(trade.sell_lock_request_id ?? '');
    if (!requestId) {
      console.warn(`[live-protect:recovery] closing trade=${trade.id} has no sell lock; holding closed-to-retry state for safety`);
      return;
    }
    const audit = await this.store.getAudit(requestId).catch(() => null);
    if (!audit) {
      console.warn(`[live-protect:recovery] trade=${trade.id} audit missing for lock=${short(requestId)}; no retry`);
      return;
    }

    const trigger = String(audit?.payload?.trigger || trade.exit_reason || 'protection-recovery');
    if (audit.status === 'succeeded' && audit.tx_hash) {
      await this.closeTradeFromExecution(trade, {
        requestId,
        signature: audit.tx_hash,
        outputAmountAtomic: String(audit?.payload?.outputAmountAtomic || '0'),
        targetAmountAtomic: asAtomic(audit?.payload?.targetAmountAtomic),
        reason: trigger,
        marketPriceUsd: audit?.payload?.marketPriceUsd ?? null
      });
      console.log(`[live-protect:recovery] completed previously succeeded exit trade=${trade.id}`);
      return;
    }

    const uncertain = audit.status === 'broadcasting' || audit?.payload?.executionUncertain === true;
    if (!uncertain) {
      if (audit.status === 'failed') {
        await this.store.releaseLiveTradeSell(trade.id, requestId, { exit_reason: `recovered-prebroadcast-failure: ${trigger}` });
      }
      return;
    }

    const signature = audit.tx_hash || audit?.payload?.candidateSignature || null;
    let signatureResult = { known: true, status: null };
    if (signature) {
      try {
        signatureResult = await this.signatureStatus(signature);
      } catch (error) {
        console.warn(`[live-protect:reconcile-signature] trade=${trade.id} ${String(error?.message ?? error)}`);
        return;
      }
      if (signatureResult.status?.err) {
        await this.store.appendAuditEvent(requestId, { type: 'signature-failed', error: JSON.stringify(signatureResult.status.err).slice(0, 220) }).catch(() => {});
      } else if (signatureResult.status && ['confirmed', 'finalized'].includes(signatureResult.status.confirmationStatus)) {
        await this.store.updateAudit(requestId, {
          status: 'succeeded',
          tx_hash: String(signature),
          error: null,
          payload: { ...(audit.payload || {}), executionUncertain: false, reconciledBy: 'signature', reconciledAt: isoNow() }
        });
        await this.closeTradeFromExecution(trade, {
          requestId,
          signature: String(signature),
          outputAmountAtomic: String(audit?.payload?.outputAmountAtomic || '0'),
          targetAmountAtomic: asAtomic(audit?.payload?.targetAmountAtomic),
          reason: trigger,
          marketPriceUsd: audit?.payload?.marketPriceUsd ?? null,
          inferred: true
        });
        console.log(`[live-protect:recovery] signature confirmed trade=${trade.id} tx=${short(signature)}`);
        return;
      }
    }

    let currentBalance;
    try {
      currentBalance = await this.readTokenBalance(trade.tokens.address, trade.wallet_address);
    } catch (error) {
      console.warn(`[live-protect:reconcile-balance] trade=${trade.id} ${String(error?.message ?? error)}`);
      return;
    }
    const before = asAtomic(audit?.payload?.balanceBeforeAtomic);
    if (before > 0n && currentBalance < before) {
      await this.store.updateAudit(requestId, {
        status: 'succeeded',
        ...(signature ? { tx_hash: String(signature) } : {}),
        error: null,
        payload: {
          ...(audit.payload || {}),
          executionUncertain: false,
          reconciledBy: 'balance-decrease',
          balanceAfterAtomic: currentBalance.toString(),
          reconciledAt: isoNow()
        }
      });
      await this.closeTradeFromExecution(trade, {
        requestId,
        signature,
        outputAmountAtomic: String(audit?.payload?.outputAmountAtomic || '0'),
        targetAmountAtomic: before - currentBalance,
        reason: `${trigger} (reconciled by balance)`,
        marketPriceUsd: audit?.payload?.marketPriceUsd ?? null,
        inferred: true
      });
      console.log(`[live-protect:recovery] balance confirms exit trade=${trade.id}`);
      return;
    }

    const broadcastAt = Date.parse(trade.sell_broadcast_at || audit?.payload?.executionStartedAt || audit.updated_at || audit.created_at || '') || this.now();
    const elapsed = this.now() - broadcastAt;
    if (elapsed < this.settings.uncertaintyGraceMs) return;

    if (signatureResult.known && !signatureResult.status && (before <= 0n || currentBalance === before)) {
      await this.store.updateAudit(requestId, {
        status: 'failed',
        error: audit.error || 'broadcast outcome reconciled as not landed',
        payload: {
          ...(audit.payload || {}),
          executionUncertain: false,
          reconciledNoLanding: true,
          balanceAfterAtomic: currentBalance.toString(),
          reconciledAt: isoNow()
        }
      });
      await this.store.releaseLiveTradeSell(trade.id, requestId, {
        exit_reason: `reconciled-no-landing; protection remains active: ${trigger}`
      });
      console.warn(`[live-protect:recovery] no landing observed after grace trade=${trade.id}; lock released for a fresh protected attempt`);
    }
  }

  async recoverManualBuyRows() {
    if (this.now() - this.lastRecoveryScanAt < 60_000) return;
    this.lastRecoveryScanAt = this.now();
    const sinceIso = new Date(this.now() - 24 * 60 * 60 * 1000).toISOString();
    const audits = await this.store.recentSucceededManualBuys(sinceIso, 50);
    for (const audit of audits) {
      const tx = String(audit.tx_hash || '');
      const address = String(audit.token_address || '');
      if (!tx || !address) continue;
      const payload = audit.payload || {};
      const walletAddress = String(payload.walletAddress || env.privyWalletAddress || '');
      const walletId = String(payload.walletId || env.privyWalletId || '');
      const walletLabel = String(payload.walletLabel || 'SUMMECA Trading Wallet');
      if (!walletAddress) continue;
      const existing = await this.store.findLiveTradeByEntryTx(tx, walletAddress);
      if (existing) continue;
      const quantityAtomic = String(
        payload.executionOutputAmountAtomic
        || payload.freshQuoteOutAtomic
        || payload.quotedOutAtomic
        || '0'
      );
      if (!/^\d+$/.test(quantityAtomic) || BigInt(quantityAtomic) <= 0n) continue;
      const token = await this.store.upsertSolanaToken(address, {
        symbol: payload.symbol || null,
        priceUsd: payload.priceUsd || null,
        source: 'manual-confirm-live-recovery'
      });
      if (!token?.id) continue;

      const state = initialProtectionState(payload.priceUsd || null, this.settings);
      try {
        await this.store.insertLiveTrade({
          token_id: token.id,
          wallet_address: walletAddress,
          status: 'open',
          entry_tx: tx,
          entry_price_usd: state.entryPriceUsd,
          input_sol: audit.amount_native,
          quantity_atomic: quantityAtomic,
          high_water_pnl_pct: state.highWaterPnlPct,
          highest_price_usd: state.highestPriceUsd,
          current_stop: state.currentStop,
          stop_reason: 'recovered-initial-stop',
          protection_started_at: isoNow(),
          metadata: {
            request_id: audit.request_id,
            manual_confirm: true,
            wallet_id: walletId,
            wallet_label: walletLabel,
            recovered_from_execution_audit: true,
            remaining_cost_basis_sol: audit.amount_native
          }
        });
        await this.store.appendAuditEvent(audit.request_id, {
          type: 'live-protection-recovered',
          liveTradeEntryTx: tx
        }).catch(() => {});
        console.warn(`[live-protect:recovery] restored missing live_trade from successful manual buy tx=${short(tx)}`);
      } catch (error) {
        const raced = await this.store.findLiveTradeByEntryTx(tx, walletAddress).catch(() => null);
        if (!raced) console.warn(`[live-protect:recovery] could not restore tx=${short(tx)} ${String(error?.message ?? error)}`);
      }
    }
  }

  async cycle() {
    if (this.running) return;
    this.running = true;
    try {
      await this.recoverManualBuyRows();
      const trades = await this.store.openLiveTradesForProtection();
      await Promise.allSettled(trades.map((trade) => trade.status === 'closing'
        ? this.reconcileClosingTrade(trade)
        : this.monitorOpenTrade(trade)));
    } catch (error) {
      console.error(`[live-protect:cycle] ${String(error?.message ?? error)}`);
    } finally {
      this.running = false;
    }
  }

  async start() {
    if (!this.store.enabled) {
      console.warn('[live-protect] disabled: hardening store is not configured');
      return false;
    }
    if (this.broadcastEnabled && !this.jupiter?.configured) {
      throw new Error('Live protection broadcast is enabled but Privy/Jupiter is not configured');
    }
    console.log(
      `[live-protect] worker active poll=${this.settings.pollMs}ms broadcast=${this.broadcastEnabled ? 'ENABLED' : 'LOCKED'} manual-entry=unchanged stop=-${this.settings.stopLossPct}% trail=${this.settings.trailPct}%`
    );
    await this.cycle();
    this.timer = setInterval(() => void this.cycle(), this.settings.pollMs);
    return true;
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }
}

export async function startLiveProtectionWorker(options = {}) {
  const engine = new LiveProtectionEngine(options);
  await engine.start();
  return engine;
}

if (!isMainThread) {
  startLiveProtectionWorker()
    .then(() => parentPort?.postMessage({ type: 'ready', broadcastEnabled: env.liveTradingEnabled }))
    .catch((error) => {
      parentPort?.postMessage({ type: 'fatal', error: String(error?.message ?? error) });
      setImmediate(() => process.exit(1));
    });
}
