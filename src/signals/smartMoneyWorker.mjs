import { env } from '../config/env.mjs';
import { evaluateSignalSafety } from '../core/safetyGate.mjs';
import { scoreToken } from '../core/scoring.mjs';
import { enrichTokenSnapshot } from '../feeds/birdeye.mjs';
import { fetchDexScreenerSnapshot } from '../feeds/dexscreener.mjs';
import { telegramApi } from '../notifiers/telegram.mjs';

const BIRDEYE = 'https://public-api.birdeye.so';
const SOLANA_ADDRESS = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
const WSOL = 'So11111111111111111111111111111111111111112';
const USDC = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
const USDT = 'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB';
const QUOTE_MINTS = new Set([WSOL, USDC, USDT]);
const RISK_TAGS = new Set(['dev', 'bundler', 'sniper', 'insider']);

const finite = (value, fallback = 0) => {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
};

const clamp = (value, min, max) => Math.max(min, Math.min(max, value));
const nowSec = () => Math.floor(Date.now() / 1000);
const lower = (value) => String(value ?? '').trim().toLowerCase();

function pick(obj, paths, fallback = undefined) {
  for (const path of paths) {
    let cursor = obj;
    for (const part of path.split('.')) cursor = cursor?.[part];
    if (cursor !== undefined && cursor !== null) return cursor;
  }
  return fallback;
}

function asArray(payload) {
  if (Array.isArray(payload)) return payload;
  if (Array.isArray(payload?.data)) return payload.data;
  if (Array.isArray(payload?.data?.items)) return payload.data.items;
  if (Array.isArray(payload?.items)) return payload.items;
  return [];
}

class BirdeyeSmartMoneyClient {
  constructor(apiKey) {
    this.apiKey = String(apiKey ?? '').trim();
  }

  get configured() {
    return Boolean(this.apiKey);
  }

  async request(path, { method = 'GET', body } = {}) {
    const response = await fetch(`${BIRDEYE}${path}`, {
      method,
      headers: {
        accept: 'application/json',
        'X-API-KEY': this.apiKey,
        'x-chain': 'solana',
        ...(body !== undefined ? { 'content-type': 'application/json' } : {})
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {})
    });
    const text = await response.text().catch(() => '');
    const payload = text ? JSON.parse(text) : null;
    if (!response.ok || payload?.success === false) {
      const detail = payload?.message ?? payload?.error ?? text.slice(0, 200);
      const error = new Error(`Birdeye ${method} ${path} HTTP ${response.status}${detail ? `: ${detail}` : ''}`);
      error.status = response.status;
      throw error;
    }
    return payload;
  }

  async smartTokens() {
    const params = new URLSearchParams({
      sort_by: 'net_flow',
      sort_type: 'desc',
      interval: env.smartMoneyInterval,
      trader_style: env.smartMoneyTraderStyle,
      limit: String(env.smartMoneyMaxCandidates)
    });
    return asArray(await this.request(`/smart-money/v1/token/list?${params}`));
  }

  async topTraders(mint) {
    const params = new URLSearchParams({
      address: mint,
      time_frame: '24h',
      sort_by: 'realized_pnl',
      sort_type: 'desc',
      limit: String(env.smartMoneyTopTradersPerToken),
      ui_amount_mode: 'scaled'
    });
    return asArray(await this.request(`/defi/v2/tokens/top_traders?${params}`));
  }

  async walletPnl(wallet) {
    return this.request('/wallet/v2/pnl/details', {
      method: 'POST',
      body: {
        wallet,
        duration: 'all',
        position_scope: 'cumulative',
        sort_by: 'last_trade',
        limit: 100
      }
    });
  }

  async walletTrades(wallet, afterTime) {
    const params = new URLSearchParams({
      address: wallet,
      tx_type: 'swap',
      after_time: String(Math.max(0, afterTime)),
      limit: '100',
      ui_amount_mode: 'scaled'
    });
    return asArray(await this.request(`/trader/txs/seek_by_time?${params}`));
  }
}

class SmartMoneyStore {
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

  async upsertToken(snapshot) {
    const rows = await this.request('tokens?on_conflict=address', {
      method: 'POST',
      prefer: 'resolution=merge-duplicates,return=representation',
      body: {
        chain: 'solana',
        address: snapshot.address,
        symbol: snapshot.symbol ?? null,
        name: snapshot.name ?? null,
        source: 'smart_money',
        listed_at: snapshot.listedAt ? new Date(snapshot.listedAt).toISOString() : null,
        last_seen_at: new Date().toISOString(),
        initial_price_usd: finite(snapshot.priceUsd) || null,
        initial_liquidity_usd: finite(snapshot.liquidityUsd) || null,
        highest_price_usd: finite(snapshot.priceUsd) || null,
        status: 'tracking'
      }
    });
    return Array.isArray(rows) ? rows[0] ?? null : null;
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

function normalizeSmartToken(row) {
  const mint = String(pick(row, ['token', 'address', 'token_address'], '')).trim();
  return {
    mint,
    netFlowUsd: finite(pick(row, ['net_flow', 'netFlow', 'net_flow_usd'])),
    smartTraders: finite(pick(row, ['smart_traders_no', 'smartTradersNo', 'smart_traders'])),
    buyUsd: finite(pick(row, ['volume_buy_usd', 'volumeBuyUSD', 'buy_volume_usd'])),
    sellUsd: finite(pick(row, ['volume_sell_usd', 'volumeSellUSD', 'sell_volume_usd'])),
    marketCapUsd: finite(pick(row, ['market_cap', 'marketCap', 'market_cap_usd'])),
    raw: row
  };
}

function normalizeWalletPnl(payload) {
  const summary = payload?.data?.summary ?? payload?.summary ?? {};
  const winRateRaw = finite(pick(summary, ['counts.win_rate', 'win_rate', 'winRate']));
  const winRate = winRateRaw > 1 ? winRateRaw / 100 : winRateRaw;
  const realizedPnlUsd = finite(pick(summary, [
    'pnl.realized_profit',
    'realized_profit',
    'realized_pnl',
    'realizedPnl',
    'profit.realized'
  ]));
  const uniqueTokens = finite(pick(summary, ['counts.unique_tokens', 'counts.total', 'unique_tokens', 'uniqueTokens']));
  return { winRate, realizedPnlUsd, uniqueTokens };
}

function normalizeTrader(row) {
  const wallet = String(pick(row, ['owner', 'wallet', 'address'], '')).trim();
  const tags = Array.isArray(row?.tags) ? row.tags.map(lower) : [];
  return {
    wallet,
    tags,
    tokenRealizedPnl: finite(pick(row, ['realizedPnl', 'realized_pnl', 'realizedProfit'])),
    raw: row
  };
}

function normalizeTrade(row) {
  const legs = [row?.base, row?.quote].filter(Boolean);
  const bought = legs.find((leg) => lower(leg?.type_swap ?? leg?.typeSwap) === 'to');
  const sold = legs.find((leg) => lower(leg?.type_swap ?? leg?.typeSwap) === 'from');
  const mint = String(pick(bought, ['address', 'token_address', 'mint'], '')).trim();
  const symbol = String(pick(bought, ['symbol', 'token_symbol'], '')).trim();
  const tx = String(pick(row, ['tx_hash', 'txHash', 'signature'], '')).trim();
  const at = finite(pick(row, ['block_unix_time', 'blockUnixTime', 'unix_time']), nowSec());
  const amount = finite(pick(bought, ['ui_amount', 'uiAmount', 'amount']));
  const price = finite(pick(bought, ['price', 'price_usd', 'basePrice', 'quotePrice']));
  const directUsd = finite(pick(row, ['volume_usd', 'volumeUsd', 'volumeUSD', 'value_usd']));
  const usd = directUsd || (amount > 0 && price > 0 ? amount * price : 0);
  const key = `${tx}:${pick(row, ['ins_index', 'insIndex'], '')}:${pick(row, ['inner_ins_index', 'innerInsIndex'], '')}`;
  return { mint, symbol, tx, at, usd, key, bought, sold, raw: row };
}

export class SmartMoneyWorker {
  constructor() {
    this.client = new BirdeyeSmartMoneyClient(env.birdeyeApiKey);
    this.store = new SmartMoneyStore(env.supabaseUrl, env.supabaseSecretKey);
    this.candidates = new Map();
    this.trustedWallets = new Map();
    this.pnlCache = new Map();
    this.clusters = new Map();
    this.seenTrades = new Map();
    this.emitted = new Map();
    this.lastDiscoveryAt = 0;
    this.running = false;
    this.timer = null;
    this.chatId = '';
    this.apiUnavailableUntil = 0;
  }

  async notify(ar, en) {
    if (!env.telegramBotToken) return;
    if (!this.chatId && this.store.configured) {
      try { this.chatId = await this.store.chatId(); } catch {}
    }
    if (!this.chatId) return;
    const text = env.telegramLanguage === 'en' ? en : env.telegramLanguage === 'bilingual' ? `${ar}\n\n────────────\n\n${en}` : ar;
    await telegramApi(env.telegramBotToken, 'sendMessage', { chat_id: this.chatId, text }).catch((error) => {
      console.error('[smart-money:telegram]', error.message);
    });
  }

  async scoreWallet(wallet, tags = []) {
    const cached = this.pnlCache.get(wallet);
    if (cached?.expiresAt > Date.now()) return cached.value;
    const pnl = normalizeWalletPnl(await this.client.walletPnl(wallet));
    const tagPenalty = tags.filter((tag) => RISK_TAGS.has(tag)).length * 12;
    const pnlBonus = pnl.realizedPnlUsd > 0 ? Math.min(20, Math.log10(1 + pnl.realizedPnlUsd) * 4) : 0;
    const experienceBonus = Math.min(10, Math.log10(1 + Math.max(0, pnl.uniqueTokens)) * 4);
    const score = clamp(Math.round(pnl.winRate * 80 + pnlBonus + experienceBonus - tagPenalty), 0, 100);
    const value = { ...pnl, score, tags };
    this.pnlCache.set(wallet, { value, expiresAt: Date.now() + env.smartMoneyWalletScoreCacheMs });
    return value;
  }

  candidateEligible(candidate) {
    const buySellRatio = candidate.buyUsd / Math.max(1, candidate.sellUsd);
    if (!SOLANA_ADDRESS.test(candidate.mint)) return false;
    if (candidate.netFlowUsd < env.smartMoneyMinNetFlowUsd) return false;
    if (candidate.smartTraders < env.smartMoneyMinTraders) return false;
    if (candidate.buyUsd > 0 && candidate.sellUsd > 0 && buySellRatio < env.smartMoneyMinBuySellRatio) return false;
    if (env.smartMoneyMaxMarketCapUsd > 0 && candidate.marketCapUsd > env.smartMoneyMaxMarketCapUsd) return false;
    return true;
  }

  async discover() {
    const rows = await this.client.smartTokens();
    const fresh = rows.map(normalizeSmartToken).filter((candidate) => this.candidateEligible(candidate));
    const expiresAt = Date.now() + env.smartMoneyCandidateTtlMs;
    for (const candidate of fresh) this.candidates.set(candidate.mint, { ...candidate, expiresAt });

    const stillFresh = new Set(fresh.map((candidate) => candidate.mint));
    for (const [mint, candidate] of this.candidates) {
      if (candidate.expiresAt <= Date.now() && !stillFresh.has(mint)) this.candidates.delete(mint);
    }

    const walletCandidates = new Map();
    for (const candidate of fresh.slice(0, env.smartMoneyMaxCandidates)) {
      let traders = [];
      try {
        traders = (await this.client.topTraders(candidate.mint)).map(normalizeTrader);
      } catch (error) {
        console.warn('[smart-money:top-traders]', candidate.mint, error.message);
        continue;
      }
      for (const trader of traders) {
        if (!SOLANA_ADDRESS.test(trader.wallet)) continue;
        const existing = walletCandidates.get(trader.wallet);
        if (!existing || trader.tokenRealizedPnl > existing.tokenRealizedPnl) {
          walletCandidates.set(trader.wallet, { ...trader, candidateMint: candidate.mint });
        }
      }
    }

    const ordered = [...walletCandidates.values()]
      .sort((a, b) => b.tokenRealizedPnl - a.tokenRealizedPnl)
      .slice(0, env.smartMoneyMaxWallets * 2);

    const trusted = [];
    for (const trader of ordered) {
      if (trusted.length >= env.smartMoneyMaxWallets) break;
      try {
        const quality = await this.scoreWallet(trader.wallet, trader.tags);
        if (quality.winRate < env.smartMoneyMinWalletWinRate) continue;
        if (quality.realizedPnlUsd < env.smartMoneyMinWalletRealizedPnlUsd) continue;
        if (quality.score < env.smartMoneyMinWalletScore) continue;
        trusted.push({ ...trader, ...quality });
      } catch (error) {
        console.warn('[smart-money:wallet-score]', trader.wallet.slice(0, 8), error.message);
      }
    }

    const discoveredAt = nowSec();
    for (const wallet of trusted) {
      const previous = this.trustedWallets.get(wallet.wallet);
      this.trustedWallets.set(wallet.wallet, {
        ...previous,
        ...wallet,
        lastTradeTime: previous?.lastTradeTime ?? discoveredAt - 5,
        refreshedAt: Date.now()
      });
    }
    for (const [wallet, info] of this.trustedWallets) {
      if (Date.now() - info.refreshedAt > env.smartMoneyWalletScoreCacheMs * 2) this.trustedWallets.delete(wallet);
    }

    console.log(`[smart-money:discover] candidates=${fresh.length} trustedWallets=${this.trustedWallets.size}`);
  }

  rememberTrade(key) {
    if (!key) return false;
    if (this.seenTrades.has(key)) return true;
    this.seenTrades.set(key, Date.now());
    if (this.seenTrades.size > 5000) {
      const cutoff = Date.now() - 6 * 60 * 60 * 1000;
      for (const [tradeKey, seenAt] of this.seenTrades) if (seenAt < cutoff) this.seenTrades.delete(tradeKey);
    }
    return false;
  }

  addClusterBuy(mint, event) {
    const cutoff = Date.now() - env.smartMoneyClusterWindowMs;
    const existing = (this.clusters.get(mint) ?? []).filter((item) => item.observedAt >= cutoff);
    const withoutSameWallet = existing.filter((item) => item.wallet !== event.wallet);
    withoutSameWallet.push(event);
    this.clusters.set(mint, withoutSameWallet);
    return withoutSameWallet;
  }

  async emitClusterSignal(mint, cluster, candidate) {
    const last = this.emitted.get(mint) ?? 0;
    if (Date.now() - last < env.smartMoneySignalCooldownMs) return;
    this.emitted.set(mint, Date.now());

    let snapshot = {
      address: mint,
      symbol: cluster.find((item) => item.symbol)?.symbol || 'TOKEN',
      name: cluster.find((item) => item.symbol)?.symbol || 'Smart Money Token',
      source: 'smart_money',
      listedAt: Date.now(),
      observedAt: Date.now(),
      directCreate: false
    };
    try {
      snapshot = await enrichTokenSnapshot(env.birdeyeApiKey, snapshot, { includeSecurity: true });
    } catch (error) {
      console.warn('[smart-money:enrich]', mint, error.message);
    }
    try {
      const dex = await fetchDexScreenerSnapshot(snapshot);
      if (Object.keys(dex).length) snapshot = { ...snapshot, ...dex };
    } catch (error) {
      console.warn('[smart-money:dex]', mint, error.message);
    }
    snapshot.observedAt = Date.now();

    const scores = scoreToken(snapshot);
    const safety = evaluateSignalSafety(snapshot, scores);
    if (!safety.ok || scores.entry < env.entryScoreThreshold || scores.risk > env.smartMoneyMaxRiskScore) {
      console.log(`[smart-money:gate] reject mint=${mint.slice(0, 8)}… entry=${scores.entry} risk=${scores.risk} safety=${safety.ok}`);
      return;
    }
    if (finite(snapshot.liquidityUsd) < env.minLiquidityUsd) return;

    const totalObservedUsd = cluster.reduce((sum, item) => sum + finite(item.usd), 0);
    const averageWalletScore = cluster.reduce((sum, item) => sum + finite(item.walletScore), 0) / Math.max(1, cluster.length);
    const token = await this.store.upsertToken(snapshot);
    if (!token?.id) throw new Error(`Unable to persist smart-money token ${mint}`);

    const signal = await this.store.insertSignal({
      tokenId: token.id,
      scores,
      reason: {
        // Keep compatibility with the existing live executor while preserving the
        // real provenance below. liveAutomation independently re-runs safety.
        trigger: 'paper-entry',
        origin: 'smart-money-cluster',
        source: 'birdeye-smart-money',
        confirming_wallets: cluster.length,
        average_wallet_score: Number(averageWalletScore.toFixed(2)),
        observed_buy_usd: Number(totalObservedUsd.toFixed(2)),
        smart_money_net_flow_usd: candidate.netFlowUsd,
        smart_traders_no: candidate.smartTraders,
        wallets: cluster.map((item) => ({
          address: item.wallet,
          score: item.walletScore,
          win_rate: item.winRate,
          realized_pnl_usd: item.realizedPnlUsd,
          tx: item.tx
        }))
      }
    });
    if (!signal?.id) throw new Error(`Unable to persist smart-money signal ${mint}`);

    console.log(`[smart-money:signal] mint=${mint.slice(0, 8)}… wallets=${cluster.length} avgScore=${averageWalletScore.toFixed(1)} entry=${scores.entry} risk=${scores.risk}`);
    await this.notify(
      `🧠🔥 SUMMECA SMART MONEY\n\n${snapshot.symbol ?? 'TOKEN'}\nمحافظ موثوقة اشترت: ${cluster.length}\nمتوسط تقييم المحافظ: ${averageWalletScore.toFixed(1)}/100\nتدفق Smart Money: $${Math.round(candidate.netFlowUsd).toLocaleString('en-US')}\nشراء مرصود: $${Math.round(totalObservedUsd).toLocaleString('en-US')}\nEntry: ${scores.entry}/100 | Risk: ${scores.risk}/100\n✅ فحص الأمان نجح\n${env.liveTradingEnabled ? '🤖 تم إرسال الإشارة لمحرك الشراء الحقيقي' : '🔒 التداول الحقيقي غير مفعّل؛ الإشارة للتنبيه فقط'}\nCA: ${mint}`,
      `🧠🔥 SUMMECA SMART MONEY\n\n${snapshot.symbol ?? 'TOKEN'}\nTrusted wallets buying: ${cluster.length}\nAverage wallet score: ${averageWalletScore.toFixed(1)}/100\nSmart-money net flow: $${Math.round(candidate.netFlowUsd).toLocaleString('en-US')}\nObserved buys: $${Math.round(totalObservedUsd).toLocaleString('en-US')}\nEntry: ${scores.entry}/100 | Risk: ${scores.risk}/100\n✅ Safety gate passed\n${env.liveTradingEnabled ? '🤖 Forwarded to the live execution engine' : '🔒 Live trading is disabled; alert only'}\nCA: ${mint}`
    );
  }

  async processWalletTrade(walletInfo, row) {
    const trade = normalizeTrade(row);
    if (!trade.tx || this.rememberTrade(trade.key)) return;
    if (!SOLANA_ADDRESS.test(trade.mint) || QUOTE_MINTS.has(trade.mint)) return;
    const candidate = this.candidates.get(trade.mint);
    if (!candidate || candidate.expiresAt <= Date.now()) return;

    const event = {
      wallet: walletInfo.wallet,
      walletScore: walletInfo.score,
      winRate: walletInfo.winRate,
      realizedPnlUsd: walletInfo.realizedPnlUsd,
      mint: trade.mint,
      symbol: trade.symbol,
      tx: trade.tx,
      usd: trade.usd,
      chainTime: trade.at,
      observedAt: Date.now()
    };
    const cluster = this.addClusterBuy(trade.mint, event);
    const strongSingleWallet = walletInfo.score >= env.smartMoneyEliteWalletScore
      && walletInfo.winRate >= env.smartMoneyEliteWalletWinRate
      && candidate.smartTraders >= env.smartMoneyMinTraders;
    const confirmed = cluster.length >= env.smartMoneyMinConfirmingWallets || strongSingleWallet;
    if (!confirmed) return;
    await this.emitClusterSignal(trade.mint, cluster, candidate);
  }

  async pollWallet(walletInfo) {
    const after = Math.max(0, Number(walletInfo.lastTradeTime ?? nowSec() - 5));
    const rows = await this.client.walletTrades(walletInfo.wallet, after);
    let latest = after;
    const ordered = [...rows].sort((a, b) => finite(pick(a, ['block_unix_time', 'blockUnixTime'])) - finite(pick(b, ['block_unix_time', 'blockUnixTime'])));
    for (const row of ordered) {
      const eventTime = finite(pick(row, ['block_unix_time', 'blockUnixTime']), latest);
      latest = Math.max(latest, eventTime);
      await this.processWalletTrade(walletInfo, row);
    }
    walletInfo.lastTradeTime = latest;
  }

  async cycle() {
    if (this.running || Date.now() < this.apiUnavailableUntil) return;
    this.running = true;
    try {
      if (Date.now() - this.lastDiscoveryAt >= env.smartMoneyDiscoveryPollMs) {
        this.lastDiscoveryAt = Date.now();
        await this.discover();
      }
      const wallets = [...this.trustedWallets.values()];
      for (const wallet of wallets) {
        try {
          await this.pollWallet(wallet);
        } catch (error) {
          console.warn('[smart-money:wallet-poll]', wallet.wallet.slice(0, 8), error.message);
          if ([401, 403].includes(error.status)) throw error;
        }
      }
    } catch (error) {
      console.error('[smart-money:cycle]', error.message);
      if ([401, 403].includes(error.status)) {
        this.apiUnavailableUntil = Date.now() + 30 * 60 * 1000;
        console.warn('[smart-money] Birdeye plan/key does not currently allow this endpoint; backing off for 30 minutes');
      }
    } finally {
      this.running = false;
    }
  }

  async start() {
    if (!env.smartMoneyEnabled) {
      console.log('SUMMECA SMART MONEY: disabled');
      return false;
    }
    if (!this.client.configured || !this.store.configured) {
      console.log('SUMMECA SMART MONEY: skipped — Birdeye or Supabase configuration missing');
      return false;
    }
    console.log(`SUMMECA SMART MONEY: armed style=${env.smartMoneyTraderStyle} confirm=${env.smartMoneyMinConfirmingWallets} wallet(s) winRate>=${Math.round(env.smartMoneyMinWalletWinRate * 100)}%`);
    await this.cycle();
    this.timer = setInterval(() => void this.cycle(), env.smartMoneyWalletPollMs);
    return true;
  }
}

let instance = null;
export async function startSmartMoneyWorker() {
  if (instance) return instance;
  instance = new SmartMoneyWorker();
  await instance.start();
  return instance;
}
