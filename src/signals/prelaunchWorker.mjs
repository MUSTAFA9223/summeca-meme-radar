import { env } from '../config/env.mjs';
import { telegramApi } from '../notifiers/telegram.mjs';

const TRANSFER_TOPIC = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';
const EVM = /^0x[0-9a-f]{40}$/;
const SELECTOR = {
  name: '0x06fdde03',
  symbol: '0x95d89b41',
  decimals: '0x313ce567',
  totalSupply: '0x18160ddd'
};
const DEX_API = 'https://api.dexscreener.com/latest/dex/tokens';

const low = (value) => String(value ?? '').trim().toLowerCase();
const finite = (value, fallback = 0) => Number.isFinite(Number(value)) ? Number(value) : fallback;
const padTopicAddress = (address) => `0x${'0'.repeat(24)}${low(address).slice(2)}`;
const topicAddress = (topic) => topic && topic.length >= 42 ? `0x${topic.slice(-40)}`.toLowerCase() : '';
const hexBigInt = (value) => {
  try { return BigInt(value || '0x0'); } catch { return 0n; }
};
const usd18 = (value) => Number(hexBigInt(value)) / 1e18;
const short = (value) => `${String(value ?? '').slice(0, 8)}…`;

function parseWallets() {
  return String(process.env.TRENCHES_WALLETS ?? '')
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean)
    .map((entry, index) => {
      const [left, right] = entry.includes('|') ? entry.split('|', 2) : entry.includes('=') ? entry.split('=', 2) : [entry, ''];
      const address = EVM.test(low(left)) ? low(left) : EVM.test(low(right)) ? low(right) : '';
      const label = address === low(left) ? String(right || `wallet-${index + 1}`).trim() : String(left || `wallet-${index + 1}`).trim();
      return address ? { address, label } : null;
    })
    .filter(Boolean);
}

function decodeAbiString(hex) {
  const raw = String(hex ?? '').replace(/^0x/, '');
  if (!raw || raw === '0'.repeat(raw.length)) return '';
  try {
    if (raw.length >= 128) {
      const offset = Number.parseInt(raw.slice(0, 64), 16) * 2;
      if (Number.isFinite(offset) && offset + 64 <= raw.length) {
        const len = Number.parseInt(raw.slice(offset, offset + 64), 16) * 2;
        const data = raw.slice(offset + 64, offset + 64 + len);
        return Buffer.from(data, 'hex').toString('utf8').replace(/\0/g, '').trim();
      }
    }
    return Buffer.from(raw.slice(0, 64), 'hex').toString('utf8').replace(/\0/g, '').trim();
  } catch {
    return '';
  }
}

class RpcClient {
  constructor(url) { this.url = String(url ?? '').trim(); this.id = 0; }
  async call(method, params = []) {
    const response = await fetch(this.url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: ++this.id, method, params })
    });
    if (!response.ok) throw new Error(`Arc RPC ${method} HTTP ${response.status}`);
    const body = await response.json();
    if (body?.error) throw new Error(`Arc RPC ${method} ${body.error.code}: ${body.error.message}`);
    return body?.result;
  }
  blockNumber() { return this.call('eth_blockNumber').then((hex) => Number.parseInt(String(hex ?? '0x0'), 16)); }
  block(number) { return this.call('eth_getBlockByNumber', [`0x${number.toString(16)}`, true]); }
  receipt(hash) { return this.call('eth_getTransactionReceipt', [hash]); }
  tx(hash) { return this.call('eth_getTransactionByHash', [hash]); }
  logs(fromBlock, toBlock, walletTopics) {
    return this.call('eth_getLogs', [{
      fromBlock: `0x${fromBlock.toString(16)}`,
      toBlock: `0x${toBlock.toString(16)}`,
      topics: [TRANSFER_TOPIC, null, walletTopics]
    }]);
  }
  ethCall(address, data) { return this.call('eth_call', [{ to: address, data }, 'latest']); }
}

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

export class PrelaunchWorker {
  constructor() {
    this.wallets = parseWallets();
    this.walletByAddress = new Map(this.wallets.map((wallet) => [wallet.address, wallet]));
    this.walletTopics = this.wallets.map((wallet) => padTopicAddress(wallet.address));
    this.rpc = new RpcClient(process.env.TRENCHES_RPC_URL || 'https://rpc.mainnet.arc.io');
    this.pollMs = Math.max(3_000, finite(process.env.PRELAUNCH_POLL_MS, 5_000));
    this.maxBlocks = Math.max(1, Math.min(8, Math.floor(finite(process.env.PRELAUNCH_MAX_BLOCKS_PER_CYCLE, 3))));
    this.ttlMs = Math.max(5 * 60_000, finite(process.env.PRELAUNCH_TTL_MS, 30 * 60_000));
    this.lastBlock = 0;
    this.running = false;
    this.contracts = new Map();
    this.alerted = new Set();
    this.tracked = new Map();
    this.chatId = '';
  }

  async resolveChatId() {
    if (this.chatId) return this.chatId;
    if (env.telegramChatId) return (this.chatId = String(env.telegramChatId));
    if (!env.supabaseUrl || !env.supabaseSecretKey) return '';
    try {
      const response = await fetch(`${String(env.supabaseUrl).replace(/\/$/, '')}/rest/v1/app_settings?select=value&key=eq.telegram_chat_id&limit=1`, {
        headers: { apikey: env.supabaseSecretKey, Authorization: `Bearer ${env.supabaseSecretKey}` }
      });
      const rows = response.ok ? await response.json() : [];
      this.chatId = String(Array.isArray(rows) ? rows[0]?.value ?? '' : '');
    } catch {}
    return this.chatId;
  }

  async notify(text) {
    if (!env.telegramBotToken) return;
    const chatId = await this.resolveChatId();
    if (!chatId) return;
    await telegramApi(env.telegramBotToken, 'sendMessage', { chat_id: chatId, text }).catch((error) => {
      console.warn('[prelaunch:telegram]', error.message);
    });
  }

  async probeToken(address) {
    try {
      const [nameHex, symbolHex, decimalsHex, supplyHex] = await Promise.all([
        this.rpc.ethCall(address, SELECTOR.name),
        this.rpc.ethCall(address, SELECTOR.symbol),
        this.rpc.ethCall(address, SELECTOR.decimals),
        this.rpc.ethCall(address, SELECTOR.totalSupply)
      ]);
      const symbol = decodeAbiString(symbolHex);
      const name = decodeAbiString(nameHex) || symbol;
      const decimals = Number(hexBigInt(decimalsHex));
      const totalSupplyRaw = hexBigInt(supplyHex);
      if (!symbol || !Number.isFinite(decimals) || decimals < 0 || decimals > 36 || totalSupplyRaw <= 0n) return null;
      const divisor = 10 ** Math.min(decimals, 18);
      const totalSupply = Number(totalSupplyRaw) / divisor;
      return { address: low(address), symbol: symbol.slice(0, 24), name: name.slice(0, 80), decimals, totalSupply };
    } catch {
      return null;
    }
  }

  async scanCreations(fromBlock, toBlock) {
    let probed = 0;
    for (let number = fromBlock; number <= toBlock; number += 1) {
      const block = await this.rpc.block(number);
      for (const tx of block?.transactions ?? []) {
        if (tx?.to != null || probed >= 8) continue;
        const receipt = await this.rpc.receipt(tx.hash).catch(() => null);
        const address = low(receipt?.contractAddress);
        if (!EVM.test(address) || this.contracts.has(address)) continue;
        probed += 1;
        const token = await this.probeToken(address);
        if (!token) continue;
        this.contracts.set(address, {
          ...token,
          deployer: low(tx.from),
          txHash: tx.hash,
          blockNumber: number,
          createdAt: Date.now(),
          lastSeenAt: Date.now()
        });
        console.log(`[prelaunch:new-contract] ${token.symbol} ${short(address)} deployer=${short(tx.from)} block=${number}`);
      }
    }
  }

  payerEvidence(wallet, tx, receipt, boughtToken) {
    if (low(tx?.from) === wallet) return { verified: true, paidUsd: usd18(tx?.value) };
    let verified = false;
    let paidUsd = 0;
    for (const log of receipt?.logs ?? []) {
      if (low(log?.topics?.[0]) !== TRANSFER_TOPIC || topicAddress(log?.topics?.[1]) !== wallet) continue;
      const to = topicAddress(log?.topics?.[2]);
      if (!to || low(log?.address) === low(boughtToken)) continue;
      verified = true;
      paidUsd = Math.max(paidUsd, usd18(log?.data));
    }
    return { verified, paidUsd };
  }

  async processIncomingTransfers(fromBlock, toBlock) {
    if (!this.walletTopics.length) return;
    const logs = await this.rpc.logs(fromBlock, toBlock, this.walletTopics);
    for (const log of Array.isArray(logs) ? logs : []) {
      const token = low(log?.address);
      const meta = this.contracts.get(token);
      if (!meta || Date.now() - meta.createdAt > this.ttlMs) continue;
      const wallet = topicAddress(log?.topics?.[2]);
      const info = this.walletByAddress.get(wallet);
      if (!info) continue;
      const key = `${token}:${wallet}`;
      if (this.alerted.has(key)) continue;
      const [tx, receipt] = await Promise.all([this.rpc.tx(log.transactionHash), this.rpc.receipt(log.transactionHash)]);
      const evidence = this.payerEvidence(wallet, tx, receipt, token);
      if (!evidence.verified) continue;
      this.alerted.add(key);
      meta.lastSeenAt = Date.now();
      const ageSec = Math.max(0, Math.round((Date.now() - meta.createdAt) / 1000));
      const market = await dexSnapshot(token).catch(() => null);
      const preDex = !market || market.liquidityUsd <= 0;
      const text = [
        preDex ? '🚨⚡ SUMMECA PRE-DEX — SMART WALLET' : '⚡ SUMMECA ULTRA-EARLY — SMART WALLET',
        '',
        `$${meta.symbol} • ARC`,
        `🧠 المحفظة: ${info.label}`,
        `⏱️ عمر العقد: ${ageSec}s`,
        `💵 إثبات شراء: ${evidence.paidUsd > 0 ? `$${evidence.paidUsd.toFixed(2)}` : 'تم إثبات خروج قيمة من نفس المحفظة'}`,
        `👨‍💻 المنشئ: ${meta.deployer}`,
        `📦 Supply: ${Number.isFinite(meta.totalSupply) ? meta.totalSupply.toLocaleString('en-US', { maximumFractionDigits: 2 }) : '—'}`,
        market ? `💧 السيولة: $${Math.round(market.liquidityUsd).toLocaleString('en-US')} | MC: $${Math.round(market.marketCapUsd).toLocaleString('en-US')}` : '🟡 لم يظهر سوق DEX مؤكد بعد',
        '',
        preDex ? '⚠️ هذه إشارة ما قبل السوق وليست تأكيد شراء؛ العقد جديد جدًا ولم يثبت البيع/السيولة بعد.' : '🟡 دخول مبكر جدًا؛ انتظر إشارة CONFIRMED إذا نجحت فحوص السيولة والبيع.',
        `CA: ${token}`,
        `TX: ${log.transactionHash}`
      ].join('\n');
      await this.notify(text);
      if (market?.priceUsd > 0) {
        this.tracked.set(token, {
          symbol: market.symbol || meta.symbol,
          entryPrice: market.priceUsd,
          lastMilestone: 0,
          wallet: info.label,
          startedAt: Date.now(),
          lastCheckAt: 0
        });
      }
      console.log(`[prelaunch:wallet-buy] ${meta.symbol} wallet=${info.label} age=${ageSec}s predex=${preDex}`);
    }
  }

  async trackMoonshots() {
    const now = Date.now();
    const entries = [...this.tracked.entries()].slice(0, 12);
    for (const [address, state] of entries) {
      if (now - state.startedAt > 3 * 60 * 60 * 1000) {
        this.tracked.delete(address);
        continue;
      }
      if (now - state.lastCheckAt < 30_000) continue;
      state.lastCheckAt = now;
      const market = await dexSnapshot(address).catch(() => null);
      if (!market?.priceUsd || !state.entryPrice) continue;
      const pct = ((market.priceUsd / state.entryPrice) - 1) * 100;
      const milestone = pct >= 500 ? 500 : pct >= 200 ? 200 : pct >= 100 ? 100 : 0;
      if (!milestone || milestone <= state.lastMilestone) continue;
      state.lastMilestone = milestone;
      await this.notify([
        `🚀 SUMMECA MOONSHOT +${milestone}%`,
        '',
        `$${market.symbol || state.symbol} • ARC`,
        `📈 منذ أول رصد للمحفظة ${state.wallet}: +${pct.toFixed(1)}%`,
        `💧 السيولة الآن: $${Math.round(market.liquidityUsd).toLocaleString('en-US')}`,
        `MC: $${Math.round(market.marketCapUsd).toLocaleString('en-US')}`,
        `5m: شراء ${market.buys5m} / بيع ${market.sells5m}`,
        '',
        '🧠 تم تسجيل هذه النتيجة ضمن نمط المحافظ المبكرة.',
        `CA: ${address}`
      ].join('\n'));
    }
  }

  prune() {
    const cutoff = Date.now() - this.ttlMs;
    for (const [address, meta] of this.contracts) if (meta.createdAt < cutoff) this.contracts.delete(address);
  }

  async cycle() {
    if (this.running) return;
    this.running = true;
    try {
      const latest = await this.rpc.blockNumber();
      if (!(latest > 0)) return;
      if (!this.lastBlock) {
        this.lastBlock = Math.max(0, latest - 1);
        console.log(`[prelaunch] synced latest=${latest} wallets=${this.wallets.length}`);
      }
      const from = this.lastBlock + 1;
      if (from <= latest) {
        const to = Math.min(latest, from + this.maxBlocks - 1);
        await this.scanCreations(from, to);
        await this.processIncomingTransfers(from, to);
        this.lastBlock = to;
      }
      this.prune();
      await this.trackMoonshots();
    } catch (error) {
      console.warn('[prelaunch]', error.message);
    } finally {
      this.running = false;
    }
  }

  async start() {
    if (!env.trenchesEnabled) return false;
    if (!this.wallets.length) {
      console.warn('[prelaunch] disabled — no TRENCHES_WALLETS configured');
      return false;
    }
    console.log(`SUMMECA PRELAUNCH: ARC contract-creation + smart-wallet mode poll=${this.pollMs}ms`);
    await this.cycle();
    setInterval(() => void this.cycle(), this.pollMs).unref?.();
    return true;
  }
}

let singleton = null;
export async function startPrelaunchWorker() {
  if (!singleton) singleton = new PrelaunchWorker();
  await singleton.start();
  return singleton;
}
