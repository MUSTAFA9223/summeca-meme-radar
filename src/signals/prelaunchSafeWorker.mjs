import { PrelaunchWorker } from './prelaunchWorker.mjs';

const TRANSFER_TOPIC = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';
const ARC_SYSTEM_EMITTER = '0xfffffffffffffffffffffffffffffffffffffffe';
const ARC_NATIVE_USDC = '0x3600000000000000000000000000000000000000';
const DEX_API = 'https://api.dexscreener.com/latest/dex/tokens';

const low = (value) => String(value ?? '').trim().toLowerCase();
const finite = (value, fallback = 0) => Number.isFinite(Number(value)) ? Number(value) : fallback;
const topicAddress = (topic) => topic && topic.length >= 42 ? `0x${topic.slice(-40)}`.toLowerCase() : '';
const hexBigInt = (value) => {
  try { return BigInt(value || '0x0'); } catch { return 0n; }
};
const usd18 = (value) => Number(hexBigInt(value)) / 1e18;
const money = (value) => {
  const n = finite(value);
  if (Math.abs(n) >= 1e6) return `${(n / 1e6).toFixed(2)}M`;
  if (Math.abs(n) >= 1e3) return `${(n / 1e3).toFixed(1)}K`;
  return n.toFixed(n >= 100 ? 0 : 2);
};

async function dexSnapshot(address) {
  const response = await fetch(`${DEX_API}/${address}`, { headers: { accept: 'application/json' } });
  if (!response.ok) return null;
  const payload = await response.json();
  const pair = (Array.isArray(payload?.pairs) ? payload.pairs : [])
    .filter((item) => low(item?.chainId) === 'arc')
    .sort((a, b) => finite(b?.liquidity?.usd) - finite(a?.liquidity?.usd))[0];
  if (!pair) return null;
  const token = low(pair?.baseToken?.address) === low(address) ? pair.baseToken : pair.quoteToken;
  return {
    symbol: token?.symbol || 'TOKEN',
    name: token?.name || token?.symbol || 'Arc token',
    priceUsd: finite(pair?.priceUsd),
    liquidityUsd: finite(pair?.liquidity?.usd),
    marketCapUsd: finite(pair?.marketCap, finite(pair?.fdv)),
    buys5m: finite(pair?.txns?.m5?.buys),
    sells5m: finite(pair?.txns?.m5?.sells),
    priceChange5mPct: finite(pair?.priceChange?.m5),
    dexUrl: pair?.url || ''
  };
}

export class SafePrelaunchWorker extends PrelaunchWorker {
  constructor() {
    super();
    this.topTierMinWallets = Math.max(2, Math.floor(finite(process.env.PRELAUNCH_TOP_TIER_MIN_WALLETS, 2)));
    this.topTierEliteUsd = Math.max(1_000, finite(process.env.PRELAUNCH_TOP_TIER_ELITE_USD, 10_000));
    this.topTierClusterMs = Math.max(30_000, finite(process.env.PRELAUNCH_TOP_TIER_CLUSTER_MS, 90_000));
    this.topTierMaxAgeSec = Math.max(60, finite(process.env.PRELAUNCH_TOP_TIER_MAX_AGE_SEC, 600));
    this.topTierMinLiquidityUsd = Math.max(0, finite(process.env.PRELAUNCH_TOP_TIER_MIN_LIQUIDITY_USD, 10_000));
    this.topTierMaxMarketCapUsd = Math.max(0, finite(process.env.PRELAUNCH_TOP_TIER_MAX_MARKET_CAP_USD, 1_500_000));
    this.topTierMaxPrice5mPct = Math.max(0, finite(process.env.PRELAUNCH_TOP_TIER_MAX_PRICE_5M_PCT, 20));
    this.topTierMinBuys5m = Math.max(0, finite(process.env.PRELAUNCH_TOP_TIER_MIN_BUYS_5M, 2));
    this.topTierMinSells5m = Math.max(0, finite(process.env.PRELAUNCH_TOP_TIER_MIN_SELLS_5M, 1));

    this.watchEnabled = String(process.env.PRELAUNCH_WATCH_ENABLED ?? 'true').toLowerCase() !== 'false';
    this.watchMaxAgeSec = Math.max(30, finite(process.env.PRELAUNCH_WATCH_MAX_AGE_SEC, 300));
    this.watchMaxMarketCapUsd = Math.max(0, finite(process.env.PRELAUNCH_WATCH_MAX_MARKET_CAP_USD, 3_000_000));
    this.watchMaxPrice5mPct = Math.max(0, finite(process.env.PRELAUNCH_WATCH_MAX_PRICE_5M_PCT, 35));

    this.topTierClusters = new Map();
    this.topTierSeen = new Set();
    this.topTierAlerted = new Set();
    this.watchAlerted = new Set();
  }

  payerEvidence(wallet, tx, receipt, boughtToken) {
    if (low(tx?.from) === wallet) {
      return { verified: true, paidUsd: usd18(tx?.value), mode: 'tx-from' };
    }

    let verified = false;
    let paidUsd = 0;
    for (const log of receipt?.logs ?? []) {
      if (low(log?.topics?.[0]) !== TRANSFER_TOPIC || topicAddress(log?.topics?.[1]) !== wallet) continue;
      const to = topicAddress(log?.topics?.[2]);
      if (!to || low(log?.address) === low(boughtToken)) continue;

      verified = true;
      const asset = low(log?.address);
      if (asset === ARC_SYSTEM_EMITTER || asset === ARC_NATIVE_USDC) {
        paidUsd = Math.max(paidUsd, usd18(log?.data));
      }
    }
    return { verified, paidUsd, mode: verified ? 'outflow-proof' : 'none' };
  }

  addTopTierEvent(token, event) {
    const cutoff = Date.now() - this.topTierClusterMs;
    const fresh = (this.topTierClusters.get(token) ?? [])
      .filter((item) => item.observedAt >= cutoff && item.wallet !== event.wallet);
    fresh.push(event);
    this.topTierClusters.set(token, fresh);
    return fresh;
  }

  marketPasses(market) {
    if (!market) return true;
    if (market.liquidityUsd < this.topTierMinLiquidityUsd) return false;
    if (this.topTierMaxMarketCapUsd > 0 && market.marketCapUsd > this.topTierMaxMarketCapUsd) return false;
    if (market.priceChange5mPct > this.topTierMaxPrice5mPct) return false;
    if (market.buys5m < this.topTierMinBuys5m) return false;
    if (market.sells5m < this.topTierMinSells5m) return false;
    return true;
  }

  watchMarketPasses(market) {
    if (!market) return true;
    if (this.watchMaxMarketCapUsd > 0 && market.marketCapUsd > this.watchMaxMarketCapUsd) return false;
    if (market.priceChange5mPct > this.watchMaxPrice5mPct) return false;
    return true;
  }

  async notifyWatch({ token, meta, info, evidence, market, ageSec, txHash }) {
    if (!this.watchEnabled || this.watchAlerted.has(token) || ageSec > this.watchMaxAgeSec) return;
    if (!this.watchMarketPasses(market)) return;

    this.watchAlerted.add(token);
    const preDex = !market || market.liquidityUsd <= 0;
    await this.notify([
      preDex ? '👀⚡ SUMMECA EARLY WATCH — PRE-DEX' : '👀 SUMMECA EARLY WATCH',
      '',
      `$${market?.symbol || meta.symbol} • ARC`,
      `🧠 أول شراء موثّق: ${info.label}`,
      `⏱️ عمر العقد: ${ageSec}s`,
      `💵 الدفع: ${finite(evidence.paidUsd) > 0 ? `$${money(evidence.paidUsd)}` : 'تم إثبات خروج قيمة من المحفظة'}`,
      market
        ? `💧 السيولة: $${money(market.liquidityUsd)} | MC: $${money(market.marketCapUsd)}`
        : '🟡 ما زال قبل ظهور سوق DEX مؤكد',
      market ? `5m: شراء ${market.buys5m} / بيع ${market.sells5m} | حركة ${market.priceChange5mPct.toFixed(1)}%` : '',
      '',
      '👀 WATCH فقط: فرصة مبكرة قيد المراقبة وليست إشارة CONFIRMED.',
      `CA: ${token}`,
      `TX: ${txHash}`
    ].filter(Boolean).join('\n'));

    if (market?.priceUsd > 0 && !this.tracked.has(token)) {
      this.tracked.set(token, {
        symbol: market.symbol || meta.symbol,
        entryPrice: market.priceUsd,
        lastMilestone: 0,
        wallet: info.label,
        startedAt: Date.now(),
        lastCheckAt: 0
      });
    }
    console.log(`[prelaunch:early-watch] ${meta.symbol} wallet=${info.label} age=${ageSec}s`);
  }

  async processIncomingTransfers(fromBlock, toBlock) {
    if (!this.walletTopics.length) return;
    const logs = await this.rpc.logs(fromBlock, toBlock, this.walletTopics);

    for (const log of Array.isArray(logs) ? logs : []) {
      const token = low(log?.address);
      const meta = this.contracts.get(token);
      if (!meta || Date.now() - meta.createdAt > this.ttlMs) continue;

      const eventKey = `${low(log?.transactionHash)}:${String(log?.logIndex)}`;
      if (this.topTierSeen.has(eventKey)) continue;
      this.topTierSeen.add(eventKey);

      const wallet = topicAddress(log?.topics?.[2]);
      const info = this.walletByAddress.get(wallet);
      if (!info) continue;

      const [tx, receipt] = await Promise.all([
        this.rpc.tx(log.transactionHash),
        this.rpc.receipt(log.transactionHash)
      ]);
      const evidence = this.payerEvidence(wallet, tx, receipt, token);
      if (!evidence.verified) continue;

      const ageSec = Math.max(0, Math.round((Date.now() - meta.createdAt) / 1000));
      if (ageSec > this.topTierMaxAgeSec) continue;

      const market = await dexSnapshot(token).catch(() => null);
      await this.notifyWatch({
        token,
        meta,
        info,
        evidence,
        market,
        ageSec,
        txHash: log.transactionHash
      });

      const cluster = this.addTopTierEvent(token, {
        wallet,
        label: info.label,
        paidUsd: finite(evidence.paidUsd),
        proof: evidence.mode,
        txHash: log.transactionHash,
        observedAt: Date.now()
      });
      const unique = [...new Map(cluster.map((item) => [item.wallet, item])).values()];
      const totalPaidUsd = unique.reduce((sum, item) => sum + finite(item.paidUsd), 0);
      const qualified = unique.length >= this.topTierMinWallets || totalPaidUsd >= this.topTierEliteUsd;

      if (!qualified) {
        console.log(`[prelaunch:watch] ${meta.symbol} wallets=${unique.length}/${this.topTierMinWallets} paid=$${Math.round(totalPaidUsd)}`);
        continue;
      }
      if (this.topTierAlerted.has(token)) continue;

      if (!this.marketPasses(market)) {
        console.log(`[prelaunch:top-tier-drop] ${meta.symbol} market-filter`);
        continue;
      }

      this.topTierAlerted.add(token);
      meta.lastSeenAt = Date.now();
      const preDex = !market || market.liquidityUsd <= 0;
      const labels = unique.map((item) => item.label).join(' + ');
      const text = [
        preDex ? '🚨💎 SUMMECA TOP-TIER PRE-DEX' : '💎⚡ SUMMECA TOP-TIER ULTRA-EARLY',
        '',
        `$${market?.symbol || meta.symbol} • ARC`,
        `🧠 محافظ مؤكدة: ${unique.length} (${labels})`,
        `⏱️ عمر العقد: ${ageSec}s`,
        `💵 دفع موثّق: ${totalPaidUsd > 0 ? `$${money(totalPaidUsd)}` : 'تم إثبات الدفع من المحافظ'}`,
        `👨‍💻 المنشئ: ${meta.deployer}`,
        market
          ? `💧 السيولة: $${money(market.liquidityUsd)} | MC: $${money(market.marketCapUsd)}`
          : '🟡 لم يظهر سوق DEX مؤكد بعد',
        market ? `5m: شراء ${market.buys5m} / بيع ${market.sells5m} | حركة ${market.priceChange5mPct.toFixed(1)}%` : '',
        '',
        preDex
          ? '⚠️ TOP-TIER WATCH قبل السوق: إشارة مبكرة جدًا وليست ضمان صعود أو أمر شراء.'
          : '✅ اجتازت فلاتر Top-Tier المبكرة؛ انتظر CONFIRMED من محرك Trenches للتأكيد الأقوى.',
        `CA: ${token}`,
        `TX: ${log.transactionHash}`
      ].filter(Boolean).join('\n');
      await this.notify(text);

      if (market?.priceUsd > 0) {
        this.tracked.set(token, {
          symbol: market.symbol || meta.symbol,
          entryPrice: market.priceUsd,
          lastMilestone: 0,
          wallet: labels,
          startedAt: Date.now(),
          lastCheckAt: 0
        });
      }
      console.log(`[prelaunch:top-tier] ${meta.symbol} wallets=${unique.length} paid=$${Math.round(totalPaidUsd)} predex=${preDex}`);
    }
  }
}

let singleton = null;
export async function startSafePrelaunchWorker() {
  if (!singleton) singleton = new SafePrelaunchWorker();
  await singleton.start();
  return singleton;
}
