import { env } from '../config/env.mjs';
import { AppSettings } from '../storage/appSettings.mjs';
import { telegramApi } from '../notifiers/telegram.mjs';
import { fetchPumpNativeMarket } from '../feeds/pumpFunNative.mjs';
import { sharedHeliusRpc, sharedSolanaPublicRpc } from '../infra/solanaRpcManager.mjs';

const STATE_KEY = 'auto_smart_wallet_discovery_v1';
const TRANSFER_TOPIC = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';
const EVM = /^0x[0-9a-fA-F]{40}$/;
const SOLANA = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
const ZERO = '0x0000000000000000000000000000000000000000';

const NETWORKS = {
  bsc: {
    label: 'BNB CHAIN',
    dex: 'bsc',
    rpc: () => process.env.BNB_RPC_URL || 'https://bsc-dataseed.bnbchain.org'
  },
  robinhood: {
    label: 'ROBINHOOD CHAIN',
    dex: 'robinhood',
    rpc: () => process.env.ROBINHOOD_RPC_URL || 'https://rpc.mainnet.chain.robinhood.com'
  },
  arc: {
    label: 'ARC',
    dex: 'arc',
    rpc: () => process.env.ARC_RPC_URL || process.env.TRENCHES_RPC_URL || 'https://rpc.mainnet.arc.io'
  }
};

const finite = (value, fallback = 0) => Number.isFinite(Number(value)) ? Number(value) : fallback;
const clamp = (value, min, max) => Math.max(min, Math.min(max, value));
const low = (value) => String(value ?? '').trim().toLowerCase();
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, Math.max(0, ms)));
const hex = (value) => `0x${Math.max(0, Math.floor(finite(value))).toString(16)}`;
const topicAddress = (topic) => topic && String(topic).length >= 42 ? `0x${String(topic).slice(-40)}`.toLowerCase() : '';
const short = (value) => {
  const text = String(value ?? '');
  return text.length > 16 ? `${text.slice(0, 7)}…${text.slice(-5)}` : text;
};
const money = (value) => {
  const n = finite(value);
  if (Math.abs(n) >= 1e6) return `${(n / 1e6).toFixed(2)}M`;
  if (Math.abs(n) >= 1e3) return `${(n / 1e3).toFixed(1)}K`;
  return `${n.toFixed(n >= 10 ? 2 : 4)}`;
};
const priceText = (value) => {
  const n = finite(value);
  if (!(n > 0)) return '—';
  if (n >= 1) return `${n.toFixed(4)}`;
  if (n >= 0.01) return `${n.toFixed(6)}`;
  if (n >= 0.000001) return `${n.toFixed(9)}`;
  return `${n.toExponential(4)}`;
};
const utcTime = (value) => {
  const n = finite(value);
  if (!(n > 0)) return '—';
  const ms = n < 10_000_000_000 ? n * 1_000 : n;
  return new Date(ms).toISOString().replace('T', ' ').replace('.000Z', ' UTC');
};
const normalizeNetwork = (chain) => {
  const key = low(chain);
  if (key === 'sol' || key === 'solana') return 'solana';
  if (key === 'bnb' || key === 'bsc') return 'bsc';
  if (key === 'rh' || key === 'robinhood') return 'robinhood';
  if (key === 'arc') return 'arc';
  return '';
};
const normalizeWallet = (network, address) => network === 'solana' ? String(address || '').trim() : low(address);
const walletKey = (network, address) => `${network}:${normalizeWallet(network, address)}`;
const tokenKey = (network, address) => `${network}:${network === 'solana' ? String(address || '').trim() : low(address)}`;

export function solanaMonitorBatchSize(walletCount, {
  intervalMs = 8_000,
  targetSweepMs = 90_000,
  maxBatch = 6
} = {}) {
  const count = Math.max(0, Math.floor(finite(walletCount)));
  if (!count) return 0;
  const interval = Math.max(1_000, finite(intervalMs, 8_000));
  const sweep = Math.max(interval, finite(targetSweepMs, 90_000));
  const cyclesPerSweep = Math.max(1, Math.floor(sweep / interval));
  const cap = Math.max(1, Math.min(12, Math.floor(finite(maxBatch, 6))));
  return Math.max(1, Math.min(count, cap, Math.ceil(count / cyclesPerSweep)));
}

function parseJson(raw, fallback) {
  try {
    const value = JSON.parse(String(raw ?? ''));
    return value ?? fallback;
  } catch {
    return fallback;
  }
}

function emptyState() {
  return {
    version: 1,
    updatedAt: new Date().toISOString(),
    wallets: [],
    processed: {},
    networkBlocks: {}
  };
}

export function scoreAutoSmartWallet(row, {
  minSamples = 2,
  minScore = 60,
  minAveragePeakRoi = 40
} = {}) {
  const evidence = Array.isArray(row?.evidence) ? row.evidence : [];
  const samples = evidence.length;
  const peakRois = evidence.map((item) => finite(item?.peakRoiPct)).filter(Number.isFinite);
  const avgPeakRoi = peakRois.length ? peakRois.reduce((a, b) => a + b, 0) / peakRois.length : 0;
  const hit50 = peakRois.filter((value) => value >= 50).length;
  const hit100 = peakRois.filter((value) => value >= 100).length;
  const score = clamp(Math.round(
    Math.min(44, samples * 22)
    + Math.min(21, hit50 * 7)
    + Math.min(20, hit100 * 10)
    + Math.min(15, Math.max(0, avgPeakRoi) * 0.08)
  ), 0, 100);
  const promoted = samples >= minSamples && score >= minScore && avgPeakRoi >= minAveragePeakRoi;
  return { samples, avgPeakRoi, hit50, hit100, score, promoted };
}

export function smartWalletSignalStats(wallet = {}) {
  const samples = Math.max(0, Math.floor(finite(wallet?.samples)));
  const hit50 = Math.max(0, Math.floor(finite(wallet?.hit50)));
  const hit100 = Math.max(0, Math.floor(finite(wallet?.hit100)));
  return {
    score: clamp(Math.round(finite(wallet?.score)), 0, 100),
    samples,
    avgPeakRoi: finite(wallet?.avgPeakRoi),
    hit50,
    hit100,
    hit50Rate: samples ? hit50 / samples * 100 : 0,
    hit100Rate: samples ? hit100 / samples * 100 : 0
  };
}

export function applyWinnerEvidence(existing, {
  network,
  address,
  tokenAddress,
  tokenSymbol = 'TOKEN',
  peakRoiPct = 0,
  txHash = '',
  observedAt = new Date().toISOString()
} = {}, thresholds = {}) {
  const net = normalizeNetwork(network);
  const wallet = normalizeWallet(net, address);
  if (!net || !wallet || !tokenAddress) return existing || null;
  const prior = existing || {
    network: net,
    address: wallet,
    label: `auto-${short(wallet)}`,
    evidence: [],
    promoted: false,
    score: 0,
    firstSeenAt: observedAt,
    lastSeenAt: observedAt
  };
  const key = tokenKey(net, tokenAddress);
  const evidence = Array.isArray(prior.evidence) ? [...prior.evidence] : [];
  if (!evidence.some((item) => tokenKey(net, item?.tokenAddress) === key)) {
    evidence.push({
      tokenAddress,
      tokenSymbol,
      peakRoiPct: Number(finite(peakRoiPct).toFixed(2)),
      txHash: String(txHash || ''),
      observedAt
    });
  }
  const capped = evidence.slice(-12);
  const metrics = scoreAutoSmartWallet({ evidence: capped }, thresholds);
  return {
    ...prior,
    network: net,
    address: wallet,
    evidence: capped,
    samples: metrics.samples,
    avgPeakRoi: Number(metrics.avgPeakRoi.toFixed(2)),
    hit50: metrics.hit50,
    hit100: metrics.hit100,
    score: metrics.score,
    promoted: Boolean(prior.promoted || metrics.promoted),
    promotedAt: prior.promotedAt || (metrics.promoted ? observedAt : null),
    lastSeenAt: observedAt
  };
}

export function extractSolanaWinnerBuyers(transactions, mint, limit = 12) {
  const out = new Map();
  const rows = [...(Array.isArray(transactions) ? transactions : [])]
    .sort((a, b) => finite(a?.timestamp) - finite(b?.timestamp));
  for (const tx of rows) {
    if (String(tx?.type || '').toUpperCase() !== 'SWAP') continue;
    const transfers = Array.isArray(tx?.tokenTransfers) ? tx.tokenTransfers : [];
    for (const transfer of transfers) {
      if (String(transfer?.mint || '') !== mint) continue;
      const recipient = String(
        transfer?.toUserAccount
        || transfer?.to_user_account
        || transfer?.toOwner
        || transfer?.to_owner
        || ''
      ).trim();
      if (!SOLANA.test(recipient) || recipient === mint) continue;
      if (!out.has(recipient)) {
        out.set(recipient, {
          address: recipient,
          txHash: String(tx?.signature || ''),
          timestamp: finite(tx?.timestamp)
        });
      }
      if (out.size >= limit) break;
    }
    if (out.size >= limit) break;
  }
  return [...out.values()];
}

export function extractSolanaRpcWinnerBuyers(transactions, mint, limit = 12) {
  const out = new Map();
  const rows = [...(Array.isArray(transactions) ? transactions : [])]
    .sort((a, b) => finite(a?.blockTime) - finite(b?.blockTime));

  for (const tx of rows) {
    const preRows = Array.isArray(tx?.meta?.preTokenBalances) ? tx.meta.preTokenBalances : [];
    const postRows = Array.isArray(tx?.meta?.postTokenBalances) ? tx.meta.postTokenBalances : [];
    const owners = new Set([
      ...preRows.filter((row) => String(row?.mint || '') === mint).map((row) => String(row?.owner || '')),
      ...postRows.filter((row) => String(row?.mint || '') === mint).map((row) => String(row?.owner || ''))
    ].filter(Boolean));

    const amountMap = (rowsInput) => {
      const map = new Map();
      for (const row of rowsInput) {
        if (String(row?.mint || '') !== mint) continue;
        const owner = String(row?.owner || '');
        const amount = String(row?.uiTokenAmount?.amount ?? '0');
        if (owner && /^\d+$/.test(amount)) map.set(owner, BigInt(amount));
      }
      return map;
    };
    const pre = amountMap(preRows);
    const post = amountMap(postRows);
    const keys = (tx?.transaction?.message?.accountKeys || []).map((entry) =>
      typeof entry === 'string' ? entry : String(entry?.pubkey || entry?.address || '')
    );
    const preSol = Array.isArray(tx?.meta?.preBalances) ? tx.meta.preBalances : [];
    const postSol = Array.isArray(tx?.meta?.postBalances) ? tx.meta.postBalances : [];
    const fee = finite(tx?.meta?.fee);
    const logText = (tx?.meta?.logMessages || []).join('\n').toLowerCase();
    const explicitTrade = /instruction:\s*(?:buy|buyexact|swap)\b|\bswap\b/.test(logText);

    for (const owner of owners) {
      if (!SOLANA.test(owner) || owner === mint) continue;
      const delta = (post.get(owner) || 0n) - (pre.get(owner) || 0n);
      if (delta <= 0n) continue;

      const index = keys.indexOf(owner);
      const nativeSpent = index >= 0
        ? finite(preSol[index]) - finite(postSol[index]) - fee
        : 0;
      if (!explicitTrade && nativeSpent < 500_000) continue;

      if (!out.has(owner)) {
        out.set(owner, {
          address: owner,
          txHash: String(tx?._signature || tx?.signature || ''),
          timestamp: finite(tx?.blockTime)
        });
      }
      if (out.size >= limit) break;
    }
    if (out.size >= limit) break;
  }
  return [...out.values()];
}


export function extractSolanaWalletBuy(tx, walletAddress) {
  const wallet = String(walletAddress || '').trim();
  const txMessage = tx?.transaction?.message;
  if (!SOLANA.test(wallet) || !txMessage) return null;

  const keys = (txMessage.accountKeys || []).map((entry) =>
    typeof entry === 'string' ? entry : String(entry?.pubkey || entry?.address || '')
  );
  const walletIndex = keys.indexOf(wallet);
  if (walletIndex < 0) return null;

  const preSol = Array.isArray(tx?.meta?.preBalances) ? tx.meta.preBalances : [];
  const postSol = Array.isArray(tx?.meta?.postBalances) ? tx.meta.postBalances : [];
  let spentLamports = Math.max(0, finite(preSol[walletIndex]) - finite(postSol[walletIndex]));
  if (walletIndex === 0) spentLamports = Math.max(0, spentLamports - finite(tx?.meta?.fee));

  const balanceMap = (rows) => {
    const map = new Map();
    for (const row of Array.isArray(rows) ? rows : []) {
      if (String(row?.owner || '') !== wallet) continue;
      const mint = String(row?.mint || '');
      if (!SOLANA.test(mint) || mint === 'So11111111111111111111111111111111111111112') continue;
      const raw = String(row?.uiTokenAmount?.amount ?? '0');
      const decimals = Math.max(0, Math.floor(finite(row?.uiTokenAmount?.decimals)));
      const uiRaw = row?.uiTokenAmount?.uiAmountString ?? row?.uiTokenAmount?.uiAmount;
      const ui = Number(uiRaw);
      map.set(mint, {
        raw: /^\d+$/.test(raw) ? BigInt(raw) : 0n,
        decimals,
        ui: Number.isFinite(ui) ? ui : Number(raw || 0) / (10 ** decimals)
      });
    }
    return map;
  };

  const pre = balanceMap(tx?.meta?.preTokenBalances);
  const post = balanceMap(tx?.meta?.postTokenBalances);
  const logText = (tx?.meta?.logMessages || []).join('\n').toLowerCase();
  const explicitTrade = /instruction:\s*(?:buy|buyexact|swap)\b|\bswap\b/.test(logText);
  let best = null;

  for (const mint of new Set([...pre.keys(), ...post.keys()])) {
    const before = pre.get(mint) || { raw: 0n, ui: 0 };
    const after = post.get(mint) || { raw: 0n, ui: 0 };
    const rawDelta = after.raw - before.raw;
    const uiDelta = finite(after.ui) - finite(before.ui);
    if (rawDelta <= 0n && !(uiDelta > 0)) continue;
    const candidate = {
      mint,
      tokenAmount: uiDelta > 0 ? uiDelta : null,
      tokenAmountRaw: rawDelta > 0n ? rawDelta.toString() : null
    };
    if (!best || finite(candidate.tokenAmount) > finite(best.tokenAmount)) best = candidate;
  }

  if (!best) return null;
  if (!explicitTrade && spentLamports < 500_000) return null;

  const blockTime = finite(tx?.blockTime);
  const solSpent = spentLamports / 1_000_000_000;
  return {
    ...best,
    solSpent,
    blockTime: blockTime > 0 ? blockTime : null,
    blockTimeMs: blockTime > 0 ? blockTime * 1_000 : null,
    signature: String(tx?._signature || tx?.signature || '')
  };
}


export function extractEvmWinnerBuyers(logs, tokenAddress, pairAddress = '', limit = 20) {
  const token = low(tokenAddress);
  const pair = low(pairAddress);
  const out = new Map();
  for (const log of Array.isArray(logs) ? logs : []) {
    if (low(log?.address) !== token) continue;
    if (low(log?.topics?.[0]) !== TRANSFER_TOPIC) continue;
    const from = topicAddress(log?.topics?.[1]);
    const to = topicAddress(log?.topics?.[2]);
    if (!EVM.test(to) || to === ZERO || to === token || (pair && to === pair)) continue;
    if (!from || from === ZERO) continue;
    if (!out.has(to)) {
      out.set(to, {
        address: to,
        txHash: String(log?.transactionHash || ''),
        blockNumber: Number.parseInt(String(log?.blockNumber || '0x0'), 16)
      });
    }
    if (out.size >= limit) break;
  }
  return [...out.values()];
}

class Store {
  constructor() {
    this.base = String(env.supabaseUrl || '').replace(/\/$/, '');
    this.key = String(env.supabaseSecretKey || '');
  }

  get enabled() {
    return Boolean(this.base && this.key);
  }

  async request(path, { method = 'GET', body, prefer } = {}) {
    if (!this.enabled) return null;
    const response = await fetch(`${this.base}/rest/v1/${path}`, {
      method,
      headers: {
        apikey: this.key,
        Authorization: `Bearer ${this.key}`,
        accept: 'application/json',
        ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
        ...(prefer ? { Prefer: prefer } : {})
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {})
    });
    const text = await response.text().catch(() => '');
    if (!response.ok) throw new Error(`Supabase ${method} ${path} HTTP ${response.status}${text ? `: ${text.slice(0, 160)}` : ''}`);
    return text ? JSON.parse(text) : null;
  }

  async tokens() {
    const rows = await this.request(
      'tokens?select=id,chain,address,symbol,initial_price_usd,highest_price_usd,listed_at,last_seen_at,status&initial_price_usd=not.is.null&order=last_seen_at.desc&limit=220'
    );
    return Array.isArray(rows) ? rows : [];
  }

  async upsertToken(network, address, market) {
    const rows = await this.request('tokens?on_conflict=address', {
      method: 'POST',
      prefer: 'resolution=merge-duplicates,return=representation',
      body: {
        chain: network,
        address,
        symbol: market?.symbol || null,
        name: market?.name || market?.symbol || null,
        source: 'auto-smart-wallet',
        last_seen_at: new Date().toISOString(),
        initial_price_usd: finite(market?.priceUsd) || null,
        initial_liquidity_usd: finite(market?.liquidityUsd) || null,
        highest_price_usd: finite(market?.priceUsd) || null,
        status: 'tracking'
      }
    });
    return Array.isArray(rows) ? rows[0] ?? null : null;
  }

  async insertSignal(tokenId, network, wallet, market, txHash, entryContext = {}) {
    const stats = smartWalletSignalStats(wallet);
    const blockTime = finite(entryContext?.blockTime);
    const detectedPriceUsd = finite(market?.priceUsd);
    return this.request('signals', {
      method: 'POST',
      prefer: 'return=minimal',
      body: {
        token_id: tokenId,
        signal_type: 'entry',
        entry_score: clamp(Math.round(55 + stats.score * 0.35), 0, 100),
        risk_score: 25,
        reason: {
          trigger: `${network}-auto-smart-wallet-buy`,
          origin: 'auto-smart-wallet-discovery',
          network,
          auto_discovered: true,
          wallet_score: stats.score,
          wallet_samples: stats.samples,
          wallet_avg_peak_roi_pct: Number(stats.avgPeakRoi.toFixed(2)),
          wallet_hit_50: stats.hit50,
          wallet_hit_100: stats.hit100,
          wallet_hit_50_rate_pct: Number(stats.hit50Rate.toFixed(2)),
          wallet_hit_100_rate_pct: Number(stats.hit100Rate.toFixed(2)),
          tx: txHash,
          wallet_buy_block_time: blockTime > 0 ? blockTime : null,
          detected_price_usd: detectedPriceUsd > 0 ? detectedPriceUsd : null,
          estimated_sol_spent: finite(entryContext?.solSpent) > 0 ? finite(entryContext.solSpent) : null,
          token_amount_received: finite(entryContext?.tokenAmount) > 0 ? finite(entryContext.tokenAmount) : null,
          confirming_wallets: 1,
          wallets: [{
            network,
            address: wallet.address,
            label: wallet.label,
            score: stats.score,
            paid_usd: 0
          }],
          liquidity_usd: finite(market?.liquidityUsd),
          market_cap_usd: finite(market?.marketCapUsd),
          buys_5m: finite(market?.buys5m),
          sells_5m: finite(market?.sells5m)
        }
      }
    });
  }}

async function fetchJson(url, options = {}, timeoutMs = 7_000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, { ...options, signal: controller.signal });
    const text = await response.text().catch(() => '');
    if (!response.ok) throw new Error(`HTTP ${response.status}${text ? `: ${text.slice(0, 120)}` : ''}`);
    return text ? JSON.parse(text) : null;
  } finally {
    clearTimeout(timer);
  }
}

async function rpc(url, method, params = []) {
  const body = await fetchJson(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: `auto-${Date.now()}`, method, params })
  }, 8_000);
  if (body?.error) throw new Error(`${method} ${body.error.code}: ${body.error.message}`);
  return body?.result;
}

async function dexMarket(network, address) {
  const dex = network === 'solana' ? 'solana' : NETWORKS[network]?.dex;
  if (!dex) return null;
  const rows = await fetchJson(
    `https://api.dexscreener.com/tokens/v1/${encodeURIComponent(dex)}/${encodeURIComponent(address)}`,
    { headers: { accept: 'application/json' } },
    5_500
  ).catch(() => []);
  const pairs = (Array.isArray(rows) ? rows : [])
    .filter((row) => low(row?.chainId) === dex)
    .sort((a, b) => finite(b?.liquidity?.usd) - finite(a?.liquidity?.usd));
  const pair = pairs[0] || (Array.isArray(rows) ? rows[0] : null);
  if (!pair) return null;
  const base = String(pair?.baseToken?.address || '');
  const token = network === 'solana'
    ? (base === address ? pair.baseToken : pair.quoteToken)
    : (low(base) === low(address) ? pair.baseToken : pair.quoteToken);
  return {
    symbol: token?.symbol || 'TOKEN',
    name: token?.name || token?.symbol || 'Token',
    priceUsd: finite(pair?.priceUsd),
    liquidityUsd: finite(pair?.liquidity?.usd),
    marketCapUsd: finite(pair?.marketCap, finite(pair?.fdv)),
    buys5m: finite(pair?.txns?.m5?.buys),
    sells5m: finite(pair?.txns?.m5?.sells),
    volume5mUsd: finite(pair?.volume?.m5),
    priceChange5mPct: finite(pair?.priceChange?.m5),
    pairCreatedAt: finite(pair?.pairCreatedAt),
    pairAddress: String(pair?.pairAddress || ''),
    url: String(pair?.url || '')
  };
}

async function findBlockNearTime(rpcUrl, targetMs, latest) {
  let lo = Math.max(1, latest - 250_000);
  let hi = latest;
  let best = lo;
  for (let i = 0; i < 18 && lo <= hi; i += 1) {
    const mid = Math.floor((lo + hi) / 2);
    const block = await rpc(rpcUrl, 'eth_getBlockByNumber', [hex(mid), false]).catch(() => null);
    const ts = Number.parseInt(String(block?.timestamp || '0x0'), 16) * 1000;
    if (!ts) break;
    best = mid;
    if (ts < targetMs) lo = mid + 1;
    else hi = mid - 1;
    await sleep(50);
  }
  return Math.max(1, best - 2);
}

async function solanaHistoryRpc(method, params = []) {
  return sharedSolanaPublicRpc(method, params, {
    purpose: 'background',
    timeoutMs: 8_000,
    minIntervalMs: 900,
    maxAttempts: 2
  });
}

async function harvestSolanaRpcFallback(token) {
  const mint = String(token.address || '');
  if (!SOLANA.test(mint)) return [];
  const start = Date.parse(token.listed_at || '') || 0;
  const signatures = await solanaHistoryRpc('getSignaturesForAddress', [
    mint,
    { limit: 80, commitment: 'confirmed' }
  ]).catch((error) => {
    console.warn(`[auto-smart:solana-rpc-history] ${short(mint)} signatures ${error.message}`);
    return [];
  });
  if (!Array.isArray(signatures) || !signatures.length) return [];

  const startSec = start > 0 ? Math.floor(start / 1000) : 0;
  let selected = signatures.filter((row) => {
    if (!startSec) return true;
    const at = finite(row?.blockTime);
    return at >= startSec && at <= startSec + 12 * 60;
  });
  if (!selected.length) selected = signatures.slice(-30);
  selected = selected.sort((a, b) => finite(a?.blockTime) - finite(b?.blockTime)).slice(0, 30);

  const transactions = [];
  for (const row of selected) {
    const tx = await solanaHistoryRpc('getTransaction', [
      row.signature,
      { encoding: 'jsonParsed', commitment: 'confirmed', maxSupportedTransactionVersion: 0 }
    ]).catch(() => null);
    if (tx) transactions.push({ ...tx, _signature: row.signature });
    if (transactions.length >= 24) break;
    await sleep(110);
  }
  const buyers = extractSolanaRpcWinnerBuyers(transactions, mint, 12);
  if (buyers.length) {
    console.log(`[auto-smart:solana-rpc-fallback] mint=${short(mint)} txs=${transactions.length} buyers=${buyers.length}`);
  }
  return buyers;
}

async function harvestSolana(token) {
  if (!SOLANA.test(String(token.address || ''))) return [];
  const start = Date.parse(token.listed_at || '') || 0;
  let buyers = [];

  const native = await fetchPumpNativeMarket(token.address, { includeFlow: true }).catch(() => null);
  if (Array.isArray(native?.buyerWallets) && native.buyerWallets.length) {
    buyers = native.buyerWallets
      .filter((row) => SOLANA.test(String(row?.address || '')))
      .slice(0, 12)
      .map((row) => ({
        address: String(row.address),
        txHash: '',
        timestamp: finite(row.at) / 1000
      }));
    if (buyers.length) {
      console.log(`[auto-smart:pump-buyers] mint=${short(token.address)} buyers=${buyers.length}`);
      return buyers;
    }
  }

  if (env.heliusApiKey) {
    const qs = new URLSearchParams({
      'api-key': env.heliusApiKey,
      type: 'SWAP',
      limit: '100',
      'sort-order': 'asc',
      commitment: 'confirmed'
    });
    if (start > 0) {
      qs.set('gte-time', String(Math.floor(start / 1000)));
      qs.set('lte-time', String(Math.floor((start + 12 * 60_000) / 1000)));
    }
    const url = `https://api.helius.xyz/v0/addresses/${encodeURIComponent(token.address)}/transactions?${qs}`;
    const rows = await fetchJson(url, { headers: { accept: 'application/json' } }, 8_000).catch((error) => {
      console.warn(`[auto-smart:solana-history] ${short(token.address)} ${error.message}`);
      return [];
    });
    buyers = extractSolanaWinnerBuyers(rows, token.address, 12);
  }

  if (buyers.length) return buyers;
  return harvestSolanaRpcFallback(token);
}

async function harvestEvm(token, network) {
  const cfg = NETWORKS[network];
  const address = low(token.address);
  if (!cfg || !EVM.test(address)) return [];
  const market = await dexMarket(network, address);
  const startMs = finite(market?.pairCreatedAt) || Date.parse(token.listed_at || '') || 0;
  if (!(startMs > 0)) return [];

  const rpcUrl = cfg.rpc();
  const latest = Number.parseInt(String(await rpc(rpcUrl, 'eth_blockNumber') || '0x0'), 16);
  if (!(latest > 0)) return [];
  const from = await findBlockNearTime(rpcUrl, startMs, latest);
  const to = Math.min(latest, from + 700);
  const logs = await rpc(rpcUrl, 'eth_getLogs', [{
    address,
    fromBlock: hex(from),
    toBlock: hex(to),
    topics: [TRANSFER_TOPIC]
  }]).catch((error) => {
    console.warn(`[auto-smart:${network}-history] token=${short(address)} ${error.message}`);
    return [];
  });
  const raw = extractEvmWinnerBuyers(logs, address, market?.pairAddress || '', 24);
  const buyers = [];
  for (const item of raw) {
    const code = await rpc(rpcUrl, 'eth_getCode', [item.address, 'latest']).catch(() => '0x1');
    if (code && code !== '0x' && code !== '0x0') continue;
    buyers.push(item);
    if (buyers.length >= 12) break;
    await sleep(50);
  }
  return buyers;
}

function peakRoi(token) {
  const entry = finite(token?.initial_price_usd);
  const high = finite(token?.highest_price_usd);
  if (!(entry > 0 && high > 0)) return 0;
  return (high / entry - 1) * 100;
}

function normalizeState(state) {
  const base = state && typeof state === 'object' ? state : emptyState();
  return {
    ...emptyState(),
    ...base,
    wallets: Array.isArray(base.wallets) ? base.wallets : [],
    processed: base.processed && typeof base.processed === 'object' ? base.processed : {},
    networkBlocks: base.networkBlocks && typeof base.networkBlocks === 'object' ? base.networkBlocks : {}
  };
}

export class SmartWalletDiscoveryWorker {
  constructor() {
    this.store = new Store();
    this.settings = new AppSettings(env.supabaseUrl, env.supabaseSecretKey);
    this.discoveryRunning = false;
    this.monitorRunning = false;
    this.state = emptyState();
    this.stateLoaded = false;
    this.discoveryIntervalMs = Math.max(45_000, finite(process.env.AUTO_SMART_DISCOVERY_INTERVAL_MS, 60_000));
    this.monitorIntervalMs = Math.max(5_000, finite(process.env.AUTO_SMART_MONITOR_INTERVAL_MS, 8_000));
    this.solanaTargetSweepMs = Math.max(30_000, finite(process.env.AUTO_SMART_SOLANA_TARGET_SWEEP_MS, 90_000));
    this.solanaMaxBatch = Math.max(1, Math.min(12, Math.floor(finite(process.env.AUTO_SMART_SOLANA_MAX_BATCH, 6))));
    this.winnerMinPeakRoi = Math.max(20, finite(process.env.AUTO_SMART_WINNER_MIN_PEAK_ROI_PCT, 50));
    this.minSamples = Math.max(2, Math.floor(finite(process.env.AUTO_SMART_MIN_WINNING_TOKENS, 2)));
    this.minScore = clamp(finite(process.env.AUTO_SMART_MIN_SCORE, 60), 40, 95);
    this.minAveragePeakRoi = Math.max(20, finite(process.env.AUTO_SMART_MIN_AVG_PEAK_ROI_PCT, 40));
    this.winnersPerCycle = Math.max(1, Math.min(4, Math.floor(finite(process.env.AUTO_SMART_WINNERS_PER_CYCLE, 2))));
    this.solMonitorCursor = 0;
    this.evmMonitorCursor = 0;
  }

  async loadState() {
    if (this.stateLoaded) return;
    const raw = await this.settings.get(STATE_KEY).catch(() => null);
    this.state = normalizeState(parseJson(raw, emptyState()));
    this.stateLoaded = true;
  }

  async saveState() {
    this.state.updatedAt = new Date().toISOString();
    if (this.state.wallets.length > 500) {
      this.state.wallets = [...this.state.wallets]
        .sort((a, b) => finite(b.score) - finite(a.score) || finite(b.samples) - finite(a.samples))
        .slice(0, 500);
    }
    const processedEntries = Object.entries(this.state.processed);
    if (processedEntries.length > 400) {
      processedEntries.sort((a, b) => finite(b[1]?.at) - finite(a[1]?.at));
      this.state.processed = Object.fromEntries(processedEntries.slice(0, 400));
    }
    await this.settings.set(STATE_KEY, JSON.stringify(this.state));
  }

  walletMap() {
    return new Map(this.state.wallets.map((row) => [walletKey(row.network, row.address), row]));
  }

  async notifyPromotion(wallet) {
    if (!env.telegramBotToken) return;
    const chatId = env.telegramChatId || await this.settings.get('telegram_chat_id').catch(() => '');
    if (!chatId) return;
    const label = wallet.network === 'solana' ? 'SOLANA' : (NETWORKS[wallet.network]?.label || wallet.network.toUpperCase());
    const evidence = (Array.isArray(wallet.evidence) ? wallet.evidence : []).slice(-5);
    const evidenceLines = evidence.flatMap((item, index) => [
      `${index + 1}) $${item.tokenSymbol || 'TOKEN'} • أعلى صعود +${finite(item.peakRoiPct).toFixed(1)}%`,
      `   العقد: ${item.tokenAddress}`
    ]);
    const lastEvidence = evidence[evidence.length - 1];
    const networkKey = wallet.network === 'solana' ? 'sol' : wallet.network === 'robinhood' ? 'rh' : wallet.network;
    const keyboard = [
      [{ text: '📋 نسخ عنوان المحفظة', copy_text: { text: wallet.address } }]
    ];
    if (lastEvidence?.tokenAddress) {
      keyboard.push([
        { text: '📋 نسخ آخر عقد', copy_text: { text: lastEvidence.tokenAddress } },
        { text: '🔎 تحليل آخر عملة', callback_data: `term:a:${networkKey}:${lastEvidence.tokenAddress}` }
      ]);
      if (wallet.network === 'solana') {
        keyboard.push([{ text: '🟢 فتح الشراء', callback_data: `p6:b:sol:${lastEvidence.tokenAddress}` }]);
      }
    }
    await telegramApi(env.telegramBotToken, 'sendMessage', {
      chat_id: String(chatId),
      text: [
        '🧠🏆 محفظة ذكية مكتشفة تلقائيًا — تمت الترقية',
        '',
        `الشبكة: ${label}`,
        'عنوان المحفظة:',
        wallet.address,
        `درجة الاكتشاف: ${wallet.score}/100`,
        `عدد العملات الناجحة الداعمة: ${wallet.samples}`,
        `متوسط أعلى صعود بعد الرصد: +${finite(wallet.avgPeakRoi).toFixed(1)}%`,
        `نجاح +50%: ${smartWalletSignalStats(wallet).hit50}/${smartWalletSignalStats(wallet).samples} (${smartWalletSignalStats(wallet).hit50Rate.toFixed(0)}%)`,
        `نجاح +100%: ${smartWalletSignalStats(wallet).hit100}/${smartWalletSignalStats(wallet).samples} (${smartWalletSignalStats(wallet).hit100Rate.toFixed(0)}%)`,
        '',
        evidenceLines.length ? '🧾 العملات التي دعمت ترقية هذه المحفظة:' : '',
        ...evidenceLines,
        '',
        '✅ تمت إضافتها للمراقبة الآلية. أي شراء جديد منها سيصلك مع عقد العملة كاملًا.',
        '⚠️ التقييم دليل تاريخي وليس ضمانًا لنجاح الصفقة التالية.'
      ].filter(Boolean).join('\n'),
      reply_markup: { inline_keyboard: keyboard }
    }).catch(() => {});
  }

  async discoveryCycle() {
    if (this.discoveryRunning || !this.store.enabled || !this.settings.enabled) return;
    this.discoveryRunning = true;
    try {
      await this.loadState();
      const tokens = await this.store.tokens();
      const now = Date.now();
      const emptyRetryMs = Math.max(60_000, finite(process.env.AUTO_SMART_EMPTY_RETRY_MS, 120_000));
      const winners = tokens
        .map((token) => {
          const network = normalizeNetwork(token.chain);
          const key = tokenKey(network, token.address);
          const prior = this.state.processed[key];
          return {
            token,
            network,
            roi: peakRoi(token),
            prior,
            retry: Boolean(prior),
            lastSeenAt: Date.parse(token.last_seen_at || token.listed_at || '') || 0
          };
        })
        .filter((row) => row.network && row.roi >= this.winnerMinPeakRoi)
        .filter((row) => {
          if (!row.prior) return true;
          if (row.prior.buyers > 0) return false;
          return now - finite(row.prior.at) >= emptyRetryMs;
        })
        .sort((a, b) =>
          Number(a.retry) - Number(b.retry)
          || b.lastSeenAt - a.lastSeenAt
          || b.roi - a.roi
        )
        .slice(0, this.winnersPerCycle);

      if (!winners.length) {
        console.log(`[auto-smart:discover] winners=0 promoted=${this.state.wallets.filter((w) => w.promoted).length}`);
        return;
      }

      const map = this.walletMap();
      let harvested = 0;
      let promoted = 0;
      for (const row of winners) {
        const { token, network, roi } = row;
        let buyers = [];
        if (network === 'solana') buyers = await harvestSolana(token);
        else buyers = await harvestEvm(token, network);

        const processedKey = tokenKey(network, token.address);
        this.state.processed[processedKey] = { at: Date.now(), buyers: buyers.length, roi: Number(roi.toFixed(2)) };
        harvested += buyers.length;

        for (const buyer of buyers) {
          const key = walletKey(network, buyer.address);
          const before = map.get(key);
          const next = applyWinnerEvidence(before, {
            network,
            address: buyer.address,
            tokenAddress: token.address,
            tokenSymbol: token.symbol || 'TOKEN',
            peakRoiPct: roi,
            txHash: buyer.txHash,
            observedAt: new Date().toISOString()
          }, {
            minSamples: this.minSamples,
            minScore: this.minScore,
            minAveragePeakRoi: this.minAveragePeakRoi
          });
          if (!next) continue;
          const newlyPromoted = !before?.promoted && next.promoted;
          map.set(key, next);
          if (newlyPromoted) {
            promoted += 1;
            await this.notifyPromotion(next);
          }
        }
        await sleep(250);
      }

      this.state.wallets = [...map.values()];
      await this.saveState();
      console.log(`[auto-smart:discover] winners=${winners.length} buyers=${harvested} wallets=${this.state.wallets.length} promoted+=${promoted} promotedTotal=${this.state.wallets.filter((w) => w.promoted).length}`);
    } catch (error) {
      console.warn('[auto-smart:discover]', String(error?.message ?? error));
    } finally {
      this.discoveryRunning = false;
    }
  }

  async marketSignal(network, tokenAddress, wallet, txHash, entryContext = {}) {
    const market = await dexMarket(network, tokenAddress).catch(() => null);
    if (!market?.priceUsd || market.liquidityUsd < 2_000 || market.sells5m < 1) return false;

    const stats = smartWalletSignalStats(wallet);
    const signature = String(entryContext?.signature || txHash || '');
    const observedAtMs = finite(entryContext?.blockTimeMs) > 0 ? finite(entryContext.blockTimeMs) : Date.now();
    const observedAtIso = new Date(observedAtMs).toISOString();
    const solSpent = finite(entryContext?.solSpent);
    const tokenAmount = finite(entryContext?.tokenAmount);

    wallet.lastBuyAt = observedAtIso;
    wallet.lastBuyTokenAddress = tokenAddress;
    wallet.lastBuyTokenSymbol = market.symbol || 'TOKEN';
    wallet.lastBuyTxHash = signature;
    wallet.lastDetectedPriceUsd = finite(market.priceUsd);
    wallet.lastEstimatedSolSpent = solSpent > 0 ? solSpent : null;

    const token = await this.store.upsertToken(network, tokenAddress, market).catch(() => null);
    if (token?.id) {
      await this.store.insertSignal(token.id, network, wallet, market, signature, {
        ...entryContext,
        blockTime: finite(entryContext?.blockTime),
        blockTimeMs: observedAtMs,
        solSpent: solSpent > 0 ? solSpent : null,
        tokenAmount: tokenAmount > 0 ? tokenAmount : null
      }).catch(() => null);
    }

    console.log(
      `[auto-smart:entry] wallet=${short(wallet.address)} mint=${short(tokenAddress)} score=${stats.score} price=${finite(market.priceUsd)} solSpent=${solSpent > 0 ? solSpent.toFixed(6) : 'na'}`
    );

    if (env.telegramBotToken) {
      const chatId = env.telegramChatId || await this.settings.get('telegram_chat_id').catch(() => '');
      if (chatId) {
        const label = network === 'solana' ? 'SOLANA' : (NETWORKS[network]?.label || network.toUpperCase());
        const networkKey = network === 'solana' ? 'sol' : network === 'robinhood' ? 'rh' : network;
        const buttons = [
          [
            { text: '📋 نسخ المحفظة', copy_text: { text: wallet.address } },
            { text: '📋 نسخ عقد العملة', copy_text: { text: tokenAddress } }
          ],
          [
            { text: '🔎 تحليل العملة', callback_data: `term:a:${networkKey}:${tokenAddress}` },
            network === 'solana'
              ? { text: '🟢 شراء مع التأكيد', callback_data: `p6:b:sol:${tokenAddress}` }
              : { text: '🟢 معاينة شراء', callback_data: `term:b:${networkKey}:${tokenAddress}` }
          ],
          [{ text: '🧠 ترتيب المحافظ الذكية', callback_data: 'p4:lb' }]
        ];
        if (network === 'solana') {
          buttons.splice(2, 0, [{ text: '👀 متابعة العملة', callback_data: `watch:add:${tokenAddress}` }]);
        }

        await telegramApi(env.telegramBotToken, 'sendMessage', {
          chat_id: String(chatId),
          text: [
            '🧠🔥 محفظة ذكية دخلت عملة جديدة',
            '',
            `العملة: $${market.symbol} • الشبكة: ${label}`,
            `🏆 درجة المحفظة: ${stats.score}/100 • أدلة تاريخية: ${stats.samples}`,
            `📈 متوسط أعلى صعود تاريخي: +${stats.avgPeakRoi.toFixed(1)}%`,
            `🎯 +50%: ${stats.hit50}/${stats.samples} (${stats.hit50Rate.toFixed(0)}%) • +100%: ${stats.hit100}/${stats.samples} (${stats.hit100Rate.toFixed(0)}%)`,
            '',
            '👛 عنوان المحفظة الذكية:',
            wallet.address,
            '',
            '🪙 عقد العملة التي دخلتها:',
            tokenAddress,
            '',
            `⏱️ وقت المعاملة: ${utcTime(observedAtMs)}`,
            `💵 سعر السوق عند رصد الدخول: ${priceText(market.priceUsd)}`,
            solSpent > 0 ? `◎ انخفاض SOL الصافي في المعاملة: ~${solSpent.toFixed(6)} SOL` : '',
            tokenAmount > 0 ? `🪙 كمية التوكن المستلمة تقريبًا: ${tokenAmount.toLocaleString('en-US', { maximumFractionDigits: 6 })}` : '',
            `💧 السيولة: ${money(market.liquidityUsd)} • القيمة السوقية: ${money(market.marketCapUsd)}`,
            `5 دقائق — شراء: ${market.buys5m} • بيع: ${market.sells5m} • الحركة: ${finite(market.priceChange5mPct).toFixed(1)}%`,
            signature ? `🔗 المعاملة: ${signature}` : '',
            '',
            'ℹ️ سعر الدخول المعروض هو سعر السوق عند رصد المعاملة، وليس سعر تنفيذ المحفظة الدقيق.',
            'يمكنك نسخ العقد أو فتح الشراء من الأزرار أدناه.',
            '⚠️ دخول المحفظة الذكية ليس ضمانًا لصعود العملة.'
          ].filter(Boolean).join('\n'),
          reply_markup: { inline_keyboard: buttons }
        }).catch(() => {});
      }
    }
    return true;
  }
  async solanaRpc(method, params = []) {
    let lastError = null;
    if (env.heliusApiKey) {
      try {
        return await sharedHeliusRpc(env.heliusApiKey, method, params, {
          timeoutMs: 8_000,
          minIntervalMs: 500,
          cooldown429Ms: 60_000,
          maxCooldownMs: 180_000
        });
      } catch (error) {
        lastError = error;
      }
    }

    try {
      return await sharedSolanaPublicRpc(method, params, {
        purpose: 'normal',
        timeoutMs: 8_000,
        minIntervalMs: 700,
        maxAttempts: 3
      });
    } catch (error) {
      throw error || lastError || new Error(`Solana ${method} failed`);
    }
  }

  async monitorSolanaWallet(wallet) {
    const signatures = await this.solanaRpc('getSignaturesForAddress', [wallet.address, { limit: 6, commitment: 'confirmed' }]).catch((error) => {
      console.warn(`[auto-smart:solana-monitor] wallet=${short(wallet.address)} ${String(error?.message ?? error).slice(0, 140)}`);
      return [];
    });
    if (!Array.isArray(signatures) || !signatures.length) return false;
    if (!wallet.lastMonitorCursor) {
      wallet.lastMonitorCursor = signatures[0]?.signature || '';
      return true;
    }

    const fresh = [];
    for (const row of signatures) {
      if (row.signature === wallet.lastMonitorCursor) break;
      fresh.push(row);
    }
    wallet.lastMonitorCursor = signatures[0]?.signature || wallet.lastMonitorCursor;

    for (const row of fresh.reverse().slice(-4)) {
      const tx = await this.solanaRpc('getTransaction', [row.signature, {
        encoding: 'jsonParsed',
        commitment: 'confirmed',
        maxSupportedTransactionVersion: 0
      }]).catch(() => null);
      const buy = extractSolanaWalletBuy(tx, wallet.address);
      if (buy?.mint) {
        await this.marketSignal('solana', buy.mint, wallet, row.signature, {
          ...buy,
          signature: row.signature,
          blockTime: buy.blockTime || finite(row?.blockTime),
          blockTimeMs: buy.blockTimeMs || (finite(row?.blockTime) > 0 ? finite(row.blockTime) * 1_000 : null)
        });
      }
      await sleep(100);
    }
    return true;
  }

  async monitorSolana(promoted) {
    if (!promoted.length) return 0;
    const batchSize = solanaMonitorBatchSize(promoted.length, {
      intervalMs: this.monitorIntervalMs,
      targetSweepMs: this.solanaTargetSweepMs,
      maxBatch: this.solanaMaxBatch
    });
    const start = this.solMonitorCursor % promoted.length;
    let checked = 0;
    for (let offset = 0; offset < batchSize; offset += 1) {
      const wallet = promoted[(start + offset) % promoted.length];
      await this.monitorSolanaWallet(wallet);
      checked += 1;
      if (offset + 1 < batchSize) await sleep(90);
    }
    this.solMonitorCursor = (start + batchSize) % promoted.length;
    return checked;
  }

  incomingEvmTokens(receipt, walletAddress) {
    const out = new Set();
    for (const log of receipt?.logs || []) {
      if (low(log?.topics?.[0]) !== TRANSFER_TOPIC) continue;
      if (topicAddress(log?.topics?.[2]) !== low(walletAddress)) continue;
      const token = low(log?.address);
      if (EVM.test(token) && token !== ZERO) out.add(token);
    }
    return [...out];
  }

  async monitorEvm(network, promoted) {
    if (!promoted.length) return;
    const cfg = NETWORKS[network];
    if (!cfg) return;
    const rpcUrl = cfg.rpc();
    const latest = Number.parseInt(String(await rpc(rpcUrl, 'eth_blockNumber') || '0x0'), 16);
    if (!(latest > 0)) return;
    let cursor = finite(this.state.networkBlocks[network]);
    if (!cursor) {
      this.state.networkBlocks[network] = Math.max(0, latest - 1);
      return;
    }
    if (cursor >= latest) return;
    const to = Math.min(latest, cursor + 2);
    const byAddress = new Map(promoted.map((item) => [low(item.address), item]));
    for (let n = cursor + 1; n <= to; n += 1) {
      const block = await rpc(rpcUrl, 'eth_getBlockByNumber', [hex(n), true]).catch(() => null);
      for (const tx of Array.isArray(block?.transactions) ? block.transactions : []) {
        const wallet = byAddress.get(low(tx?.from));
        if (!wallet || !tx?.hash) continue;
        const receipt = await rpc(rpcUrl, 'eth_getTransactionReceipt', [tx.hash]).catch(() => null);
        if (!receipt || low(receipt.status) === '0x0') continue;
        for (const token of this.incomingEvmTokens(receipt, wallet.address)) {
          await this.marketSignal(network, token, wallet, tx.hash);
        }
      }
      this.state.networkBlocks[network] = n;
    }
  }

  async monitorCycle() {
    if (this.monitorRunning || !this.settings.enabled) return;
    this.monitorRunning = true;
    try {
      await this.loadState();
      const promoted = this.state.wallets.filter((row) => row.promoted);
      const solana = promoted.filter((row) => row.network === 'solana' && SOLANA.test(row.address));
      const solanaChecked = solana.length ? await this.monitorSolana(solana) : 0;

      const evmNetworks = ['bsc', 'robinhood', 'arc'].filter((network) => promoted.some((row) => row.network === network));
      if (evmNetworks.length) {
        const network = evmNetworks[this.evmMonitorCursor % evmNetworks.length];
        this.evmMonitorCursor = (this.evmMonitorCursor + 1) % evmNetworks.length;
        await this.monitorEvm(network, promoted.filter((row) => row.network === network));
      }
      if (promoted.length) await this.saveState();
      console.log(`[auto-smart:monitor] promoted=${promoted.length} sol=${solana.length} solChecked=${solanaChecked} evm=${promoted.length - solana.length}`);
    } catch (error) {
      console.warn('[auto-smart:monitor]', String(error?.message ?? error));
    } finally {
      this.monitorRunning = false;
    }
  }

  async start() {
    if (!this.store.enabled || !this.settings.enabled) {
      console.warn('[auto-smart] disabled — persistence unavailable');
      return false;
    }
    await this.loadState();
    await this.discoveryCycle();
    await this.monitorCycle();
    setInterval(() => void this.discoveryCycle(), this.discoveryIntervalMs).unref?.();
    setInterval(() => void this.monitorCycle(), this.monitorIntervalMs).unref?.();
    console.log(
      `SUMMECA AUTO SMART WALLETS: Solana + BNB + Robinhood + Arc discovery=${this.discoveryIntervalMs}ms monitor=${this.monitorIntervalMs}ms winner>=${this.winnerMinPeakRoi}% minEvidence=${this.minSamples}`
    );
    return true;
  }
}

let singleton = null;
export async function startSmartWalletDiscoveryWorker() {
  if (!singleton) singleton = new SmartWalletDiscoveryWorker();
  return singleton.start();
}
