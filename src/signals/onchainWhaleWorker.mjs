import { env } from '../config/env.mjs';
import { evaluateSignalSafety } from '../core/safetyGate.mjs';
import { scoreToken } from '../core/scoring.mjs';
import { enrichTokenSnapshot } from '../feeds/birdeye.mjs';
import { fetchDexScreenerSnapshot } from '../feeds/dexscreener.mjs';
import { PUMP_FUN_PROGRAM_ID } from '../feeds/heliusWs.mjs';
import { telegramApi } from '../notifiers/telegram.mjs';

const SOLANA_ADDRESS = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
const LAMPORTS_PER_SOL = 1_000_000_000;

const finite = (value, fallback = 0) => {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
};

const pubkey = (entry) => {
  if (typeof entry === 'string') return entry;
  if (entry && typeof entry.pubkey === 'string') return entry.pubkey;
  return '';
};

const rawAmount = (row) => {
  const value = row?.uiTokenAmount?.amount;
  return /^\d+$/.test(String(value ?? '')) ? BigInt(value) : 0n;
};

export function parseWhaleTradeNotification(result, candidateMints = new Set()) {
  const signature = String(result?.signature ?? '').trim();
  const envelope = result?.transaction ?? {};
  const tx = envelope?.transaction;
  const meta = envelope?.meta ?? {};
  if (!signature || !tx || Array.isArray(tx) || meta?.err) return null;

  const message = tx?.message ?? {};
  const accountKeys = Array.isArray(message.accountKeys) ? message.accountKeys : [];
  const signerIndex = accountKeys.findIndex((entry) => Boolean(entry?.signer));
  const walletIndex = signerIndex >= 0 ? signerIndex : 0;
  const wallet = pubkey(accountKeys[walletIndex]);
  if (!SOLANA_ADDRESS.test(wallet)) return null;

  const balances = new Map();
  const apply = (rows, side) => {
    for (const row of Array.isArray(rows) ? rows : []) {
      if (String(row?.owner ?? '') !== wallet) continue;
      const mint = String(row?.mint ?? '');
      if (!SOLANA_ADDRESS.test(mint) || (candidateMints.size && !candidateMints.has(mint))) continue;
      const state = balances.get(mint) ?? { pre: 0n, post: 0n };
      state[side] += rawAmount(row);
      balances.set(mint, state);
    }
  };
  apply(meta?.preTokenBalances, 'pre');
  apply(meta?.postTokenBalances, 'post');

  let mint = '';
  let tokenDelta = 0n;
  for (const [candidate, state] of balances) {
    const delta = state.post - state.pre;
    if (delta > tokenDelta) {
      tokenDelta = delta;
      mint = candidate;
    }
  }
  if (!mint || tokenDelta <= 0n) return null;

  const preBalances = Array.isArray(meta?.preBalances) ? meta.preBalances : [];
  const postBalances = Array.isArray(meta?.postBalances) ? meta.postBalances : [];
  const preSol = finite(preBalances[walletIndex]);
  const postSol = finite(postBalances[walletIndex]);
  const fee = finite(meta?.fee);
  const spentLamports = Math.max(0, preSol - postSol - fee);
  const spentSol = spentLamports / LAMPORTS_PER_SOL;

  return {
    signature,
    slot: finite(result?.slot),
    wallet,
    mint,
    tokenDeltaAtomic: tokenDelta.toString(),
    spentSol,
    observedAt: Date.now()
  };
}

class WhaleStore {
  constructor(url, secretKey) {
    this.url = String(url ?? '').replace(/\/$/, '');
    this.secretKey = String(secretKey ?? '');
  }

  get configured() {
    return Boolean(this.url && this.secretKey);
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

  async recentSolanaTokens() {
    const since = new Date(Date.now() - env.onchainWhaleCandidateAgeMs).toISOString();
    const params = new URLSearchParams({
      select: 'id,address,symbol,name,source,listed_at,first_seen_at',
      chain: 'eq.solana',
      first_seen_at: `gte.${since}`,
      order: 'first_seen_at.desc',
      limit: String(env.onchainWhaleMaxCandidates)
    });
    const rows = await this.request(`tokens?${params}`);
    return (Array.isArray(rows) ? rows : []).filter((row) => {
      const source = String(row?.source ?? '').toLowerCase();
      return SOLANA_ADDRESS.test(String(row?.address ?? ''))
        && (source.includes('pump') || String(row.address).toLowerCase().endsWith('pump'));
    });
  }

  async insertSignal({ tokenId, scores, reason }) {
    const rows = await this.request('signals', {
      method: 'POST',
      prefer: 'return=representation',
      body: {
        token_id: tokenId,
        signal_type: 'entry',
        entry_score: scores.entry,
        moon_score: scores.moon,
        risk_score: scores.risk,
        reason
      }
    });
    return Array.isArray(rows) ? rows[0] ?? null : null;
  }

  async chatId() {
    if (env.telegramChatId) return String(env.telegramChatId);
    const rows = await this.request('app_settings?select=value&key=eq.telegram_chat_id&limit=1');
    return String(Array.isArray(rows) ? rows[0]?.value ?? '' : '');
  }
}

export class OnchainWhaleWorker {
  constructor() {
    this.store = new WhaleStore(env.supabaseUrl, env.supabaseSecretKey);
    this.tokens = new Map();
    this.walletStats = new Map();
    this.clusters = new Map();
    this.seen = new Map();
    this.emitted = new Map();
    this.ws = null;
    this.subscriptionId = null;
    this.subscribeRequestId = 700;
    this.active = false;
    this.reconnectTimer = null;
    this.refreshTimer = null;
    this.watchdogTimer = null;
    this.reconnectAttempt = 0;
    this.lastMessageAt = 0;
    this.chatId = '';
  }

  async notify(ar, en) {
    if (!env.telegramBotToken) return;
    if (!this.chatId && this.store.configured) {
      try { this.chatId = await this.store.chatId(); } catch {}
    }
    if (!this.chatId) return;
    const text = env.telegramLanguage === 'en' ? en : env.telegramLanguage === 'bilingual' ? `${ar}\n\n────────────\n\n${en}` : ar;
    await telegramApi(env.telegramBotToken, 'sendMessage', { chat_id: this.chatId, text }).catch((error) => {
      console.error('[onchain-whale:telegram]', error.message);
    });
  }

  walletScore(wallet, spentSol) {
    const previous = this.walletStats.get(wallet) ?? { buys: 0, totalSol: 0, mints: new Set(), lastSeenAt: 0 };
    previous.buys += 1;
    previous.totalSol += spentSol;
    previous.lastSeenAt = Date.now();
    this.walletStats.set(wallet, previous);
    const repeatBonus = Math.min(18, Math.max(0, previous.buys - 1) * 3);
    const sizeBonus = Math.min(25, Math.log2(1 + Math.max(0, previous.totalSol)) * 7);
    const diversityBonus = Math.min(12, previous.mints.size * 2);
    return Math.max(0, Math.min(100, Math.round(45 + repeatBonus + sizeBonus + diversityBonus)));
  }

  remember(signature) {
    if (!signature) return false;
    if (this.seen.has(signature)) return true;
    this.seen.set(signature, Date.now());
    if (this.seen.size > 6000) {
      const cutoff = Date.now() - 60 * 60 * 1000;
      for (const [sig, at] of this.seen) if (at < cutoff) this.seen.delete(sig);
    }
    return false;
  }

  addCluster(event) {
    const stats = this.walletStats.get(event.wallet);
    if (stats) stats.mints.add(event.mint);
    const cutoff = Date.now() - env.onchainWhaleClusterWindowMs;
    const existing = (this.clusters.get(event.mint) ?? []).filter((item) => item.observedAt >= cutoff);
    const byWallet = new Map(existing.map((item) => [item.wallet, item]));
    const prior = byWallet.get(event.wallet);
    if (!prior || event.spentSol > prior.spentSol) byWallet.set(event.wallet, event);
    const cluster = [...byWallet.values()];
    this.clusters.set(event.mint, cluster);
    return cluster;
  }

  clusterConfirmed(cluster) {
    const totalSol = cluster.reduce((sum, item) => sum + item.spentSol, 0);
    const mega = cluster.some((item) => item.spentSol >= env.onchainWhaleMegaBuySol);
    return {
      confirmed: (cluster.length >= env.onchainWhaleMinWallets && totalSol >= env.onchainWhaleMinClusterSol) || mega,
      totalSol,
      mega
    };
  }

  async refreshCandidates() {
    const rows = await this.store.recentSolanaTokens();
    const next = new Map(rows.map((row) => [row.address, row]));
    const changed = next.size !== this.tokens.size
      || [...next.keys()].some((mint) => !this.tokens.has(mint));
    this.tokens = next;
    if (changed && this.ws?.readyState === WebSocket.OPEN) this.resubscribe();
  }

  sendSubscribe() {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN || !this.tokens.size) return;
    this.subscribeRequestId += 1;
    this.ws.send(JSON.stringify({
      jsonrpc: '2.0',
      id: this.subscribeRequestId,
      method: 'transactionSubscribe',
      params: [
        {
          failed: false,
          accountInclude: [...this.tokens.keys()],
          accountRequired: [PUMP_FUN_PROGRAM_ID]
        },
        {
          commitment: 'processed',
          encoding: 'jsonParsed',
          transactionDetails: 'full',
          showRewards: false,
          maxSupportedTransactionVersion: 0
        }
      ]
    }));
  }

  resubscribe() {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
    if (this.subscriptionId != null) {
      this.ws.send(JSON.stringify({
        jsonrpc: '2.0',
        id: ++this.subscribeRequestId,
        method: 'transactionUnsubscribe',
        params: [this.subscriptionId]
      }));
      this.subscriptionId = null;
    }
    this.sendSubscribe();
  }

  async enrich(token) {
    let snapshot = {
      address: token.address,
      symbol: token.symbol ?? 'TOKEN',
      name: token.name ?? token.symbol ?? 'Token',
      source: token.source ?? 'pump_fun_direct',
      listedAt: Date.parse(token.listed_at ?? token.first_seen_at ?? '') || Date.now(),
      observedAt: Date.now(),
      directCreate: true
    };
    try {
      snapshot = await enrichTokenSnapshot(env.birdeyeApiKey, snapshot, { includeSecurity: true });
    } catch (error) {
      console.warn('[onchain-whale:enrich]', token.address, error.message);
    }
    try {
      const dex = await fetchDexScreenerSnapshot(snapshot);
      if (Object.keys(dex).length) snapshot = { ...snapshot, ...dex };
    } catch (error) {
      console.warn('[onchain-whale:dex]', token.address, error.message);
    }
    const activity = finite(snapshot.buys30s) + finite(snapshot.sells30s);
    snapshot.marketDataVerified = finite(snapshot.priceUsd) > 0
      && (activity > 0 || finite(snapshot.volume5mUsd) > 0);
    snapshot.securityVerified = snapshot.onchainSecurityVerified === true
      && snapshot.mintAuthorityDisabled === true
      && snapshot.freezeAuthorityDisabled === true;
    return snapshot;
  }

  async emitSignal(mint, cluster, confirmation) {
    const last = this.emitted.get(mint) ?? 0;
    if (Date.now() - last < env.onchainWhaleSignalCooldownMs) return;
    const token = this.tokens.get(mint);
    if (!token?.id) return;

    const snapshot = await this.enrich(token);
    const scores = scoreToken(snapshot);
    const safety = evaluateSignalSafety(snapshot, scores);
    if (!safety.ok || scores.entry < env.entryScoreThreshold || scores.risk > env.onchainWhaleMaxRiskScore) {
      console.log(`[onchain-whale:gate] reject mint=${mint.slice(0, 8)}… entry=${scores.entry} risk=${scores.risk} safety=${safety.status}`);
      return;
    }
    if (finite(snapshot.liquidityUsd) < env.minLiquidityUsd) return;

    const averageScore = cluster.reduce((sum, item) => sum + item.walletScore, 0) / Math.max(1, cluster.length);
    const signal = await this.store.insertSignal({
      tokenId: token.id,
      scores,
      reason: {
        trigger: 'paper-entry',
        origin: 'onchain-whale-cluster',
        source: 'helius-enhanced-websocket',
        confirming_wallets: cluster.length,
        observed_buy_sol: Number(confirmation.totalSol.toFixed(6)),
        mega_whale: confirmation.mega,
        average_wallet_score: Number(averageScore.toFixed(2)),
        wallets: cluster.map((item) => ({
          address: item.wallet,
          buy_sol: Number(item.spentSol.toFixed(6)),
          whale_score: item.walletScore,
          tx: item.signature
        }))
      }
    });
    if (!signal?.id) return;
    this.emitted.set(mint, Date.now());

    console.log(`[onchain-whale:signal] mint=${mint.slice(0, 8)}… wallets=${cluster.length} sol=${confirmation.totalSol.toFixed(2)} entry=${scores.entry} risk=${scores.risk}`);
    await this.notify(
      `🐋🔥 SUMMECA ON-CHAIN WHALE\n\n${snapshot.symbol ?? 'TOKEN'}\nمحافظ كبيرة مؤكدة: ${cluster.length}\nإجمالي الشراء المرصود: ${confirmation.totalSol.toFixed(2)} SOL\nمتوسط Whale Score: ${averageScore.toFixed(0)}/100\nEntry: ${scores.entry}/100 | Risk: ${scores.risk}/100\n✅ فحص العقد والسيولة نجح\n${env.liveTradingEnabled ? '🤖 الإشارة مرسلة لمحرك الشراء الحقيقي' : '🔒 الشراء الحقيقي مقفول حاليًا'}\nCA: ${mint}`,
      `🐋🔥 SUMMECA ON-CHAIN WHALE\n\n${snapshot.symbol ?? 'TOKEN'}\nConfirmed large wallets: ${cluster.length}\nObserved buy total: ${confirmation.totalSol.toFixed(2)} SOL\nAverage Whale Score: ${averageScore.toFixed(0)}/100\nEntry: ${scores.entry}/100 | Risk: ${scores.risk}/100\n✅ Contract and liquidity gates passed\n${env.liveTradingEnabled ? '🤖 Forwarded to live execution' : '🔒 Live execution is currently locked'}\nCA: ${mint}`
    );
  }

  async handleNotification(result) {
    const trade = parseWhaleTradeNotification(result, new Set(this.tokens.keys()));
    if (!trade || this.remember(trade.signature)) return;
    if (trade.spentSol < env.onchainWhaleMinBuySol) return;

    const walletScore = this.walletScore(trade.wallet, trade.spentSol);
    const event = { ...trade, walletScore };
    const cluster = this.addCluster(event);
    const confirmation = this.clusterConfirmed(cluster);
    if (!confirmation.confirmed) return;
    await this.emitSignal(trade.mint, cluster, confirmation);
  }

  connect() {
    if (!this.active || !env.heliusApiKey || !this.tokens.size) return;
    const url = `wss://mainnet.helius-rpc.com/?api-key=${encodeURIComponent(env.heliusApiKey)}`;
    const ws = new WebSocket(url);
    this.ws = ws;

    ws.addEventListener('open', () => {
      this.reconnectAttempt = 0;
      this.lastMessageAt = Date.now();
      console.log(`[onchain-whale] connected candidates=${this.tokens.size}`);
      this.sendSubscribe();
      if (this.watchdogTimer) clearInterval(this.watchdogTimer);
      this.watchdogTimer = setInterval(() => {
        if (!this.active || this.ws !== ws) return;
        if (Date.now() - this.lastMessageAt > env.onchainWhaleStaleAfterMs) {
          console.warn('[onchain-whale] stream stale; reconnecting');
          try { ws.close(4000, 'stale'); } catch {}
        }
      }, 30_000);
    });

    ws.addEventListener('message', (event) => {
      this.lastMessageAt = Date.now();
      let message;
      try { message = JSON.parse(String(event.data)); } catch { return; }
      if (message?.id !== undefined && message?.error) {
        console.warn(`[onchain-whale] subscription error: ${message.error.message ?? 'unknown error'}`);
        try { ws.close(4001, 'subscription error'); } catch {}
        return;
      }
      if (message?.id !== undefined && typeof message?.result === 'number') {
        this.subscriptionId = message.result;
        console.log(`[onchain-whale] subscribed id=${this.subscriptionId} candidates=${this.tokens.size}`);
        return;
      }
      if (message?.method !== 'transactionNotification') return;
      void this.handleNotification(message?.params?.result).catch((error) => {
        console.error('[onchain-whale:trade]', error.message);
      });
    });

    ws.addEventListener('error', () => {
      console.warn('[onchain-whale] websocket error');
      try { ws.close(4002, 'error'); } catch {}
    });

    ws.addEventListener('close', (event) => {
      if (this.watchdogTimer) clearInterval(this.watchdogTimer);
      this.watchdogTimer = null;
      if (!this.active || this.ws !== ws) return;
      this.ws = null;
      this.subscriptionId = null;
      const delay = Math.min(60_000, 2_000 * (2 ** this.reconnectAttempt));
      this.reconnectAttempt += 1;
      console.warn(`[onchain-whale] closed code=${event.code}; reconnect in ${delay}ms`);
      this.reconnectTimer = setTimeout(() => this.connect(), delay);
    });
  }

  async refresh() {
    try {
      await this.refreshCandidates();
      if (this.active && (!this.ws || this.ws.readyState === WebSocket.CLOSED) && this.tokens.size) this.connect();
    } catch (error) {
      console.error('[onchain-whale:refresh]', error.message);
    }
  }

  async start() {
    if (!env.onchainWhaleEnabled) {
      console.log('SUMMECA ON-CHAIN WHALE: disabled');
      return false;
    }
    if (!env.heliusApiKey || !this.store.configured || typeof WebSocket === 'undefined') {
      console.log('SUMMECA ON-CHAIN WHALE: skipped — Helius/Supabase/WebSocket unavailable');
      return false;
    }
    this.active = true;
    await this.refresh();
    this.refreshTimer = setInterval(() => void this.refresh(), env.onchainWhaleRefreshMs);
    console.log(`SUMMECA ON-CHAIN WHALE: armed minBuy=${env.onchainWhaleMinBuySol} SOL cluster=${env.onchainWhaleMinWallets} wallets/${env.onchainWhaleMinClusterSol} SOL mega=${env.onchainWhaleMegaBuySol} SOL`);
    return true;
  }

  stop() {
    this.active = false;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    if (this.refreshTimer) clearInterval(this.refreshTimer);
    if (this.watchdogTimer) clearInterval(this.watchdogTimer);
    this.reconnectTimer = null;
    this.refreshTimer = null;
    this.watchdogTimer = null;
    try { this.ws?.close(1000, 'shutdown'); } catch {}
    this.ws = null;
  }
}

let instance = null;
export async function startOnchainWhaleWorker() {
  if (instance) return instance;
  instance = new OnchainWhaleWorker();
  await instance.start();
  return instance;
}
