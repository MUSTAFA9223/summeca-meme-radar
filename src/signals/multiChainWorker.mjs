import { env } from '../config/env.mjs';
import { telegramApi } from '../notifiers/telegram.mjs';
import { AppSettings } from '../storage/appSettings.mjs';
import { PUMP_FUN_PROGRAM_ID, resolvePumpCreateMint } from '../feeds/heliusDirectCreate.mjs';

const TRANSFER_TOPIC = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';
const EVM = /^0x[0-9a-f]{40}$/;
const SOLANA = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
const ZERO = '0x0000000000000000000000000000000000000000';
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, Math.max(0, ms)));
const low = (value) => String(value ?? '').trim().toLowerCase();
const finite = (value, fallback = 0) => Number.isFinite(Number(value)) ? Number(value) : fallback;
const topicAddress = (topic) => topic && topic.length >= 42 ? `0x${topic.slice(-40)}`.toLowerCase() : '';
const padTopicAddress = (address) => `0x${'0'.repeat(24)}${low(address).slice(2)}`;
const short = (value) => {
  const text = String(value ?? '');
  return text.length > 14 ? `${text.slice(0, 7)}…${text.slice(-5)}` : text;
};
const money = (value) => {
  const n = finite(value);
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(2)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return n.toFixed(n >= 100 ? 0 : 2);
};

function boolEnv(name, fallback = true) {
  const value = String(process.env[name] ?? (fallback ? 'true' : 'false')).trim().toLowerCase();
  return value !== 'false' && value !== '0' && value !== 'off';
}

function parseEvmWallets(name) {
  const raw = String(process.env[name] || process.env.TRENCHES_WALLETS || '');
  return raw.split(',').map((entry) => entry.trim()).filter(Boolean).map((entry, index) => {
    const [a, b] = entry.includes('|') ? entry.split('|', 2) : entry.includes('=') ? entry.split('=', 2) : [entry, ''];
    const address = EVM.test(low(a)) ? low(a) : EVM.test(low(b)) ? low(b) : '';
    const label = address === low(a) ? String(b || `wallet-${index + 1}`).trim() : String(a || `wallet-${index + 1}`).trim();
    return address ? { address, label } : null;
  }).filter(Boolean);
}

class TelegramSink {
  constructor() {
    this.settings = new AppSettings(env.supabaseUrl, env.supabaseSecretKey);
    this.chatId = '';
  }
  async resolveChatId() {
    if (this.chatId) return this.chatId;
    if (env.telegramChatId) return (this.chatId = String(env.telegramChatId));
    if (!this.settings.enabled) return '';
    this.chatId = String(await this.settings.get('telegram_chat_id').catch(() => '') || '');
    return this.chatId;
  }
  keyboard(network, address, marketUrl = '') {
    const token = String(address ?? '');
    const rows = [[{ text: '📋 نسخ العقد / Copy CA', copy_text: { text: token } }]];
    if (network === 'solana') {
      rows.push([
        { text: '🟢 GMGN', url: `https://gmgn.ai/sol/token/${encodeURIComponent(token)}` },
        { text: '🔥 FOMO', url: `https://fomo.family/tokens/solana/${encodeURIComponent(token)}` }
      ]);
    } else if (network === 'bsc') {
      rows.push([{ text: '🟢 GMGN BSC', url: `https://gmgn.ai/bsc/token/${encodeURIComponent(token)}` }]);
    }
    if (marketUrl) rows.push([{ text: '📊 فتح السوق / Open market', url: marketUrl }]);
    return { inline_keyboard: rows };
  }
  async send(text, network, address, marketUrl = '') {
    if (!env.telegramBotToken) return null;
    const chatId = await this.resolveChatId();
    if (!chatId) return null;
    return telegramApi(env.telegramBotToken, 'sendMessage', {
      chat_id: chatId,
      text,
      reply_markup: this.keyboard(network, address, marketUrl)
    });
  }
}

const sink = new TelegramSink();

async function dexSnapshot(chainId, address) {
  const response = await fetch(`https://api.dexscreener.com/tokens/v1/${encodeURIComponent(chainId)}/${encodeURIComponent(address)}`, {
    headers: { accept: 'application/json' }
  });
  if (!response.ok) return null;
  const rows = await response.json().catch(() => []);
  const pairs = (Array.isArray(rows) ? rows : []).filter((row) => low(row?.chainId) === low(chainId));
  const pair = pairs.sort((a, b) => finite(b?.liquidity?.usd) - finite(a?.liquidity?.usd))[0];
  if (!pair) return null;
  const token = low(pair?.baseToken?.address) === low(address) ? pair.baseToken : pair.quoteToken;
  return {
    address: String(address),
    symbol: token?.symbol || 'TOKEN',
    name: token?.name || token?.symbol || 'Token',
    priceUsd: finite(pair?.priceUsd),
    liquidityUsd: finite(pair?.liquidity?.usd),
    marketCapUsd: finite(pair?.marketCap, finite(pair?.fdv)),
    buys5m: finite(pair?.txns?.m5?.buys),
    sells5m: finite(pair?.txns?.m5?.sells),
    priceChange5mPct: finite(pair?.priceChange?.m5),
    volume5mUsd: finite(pair?.volume?.m5),
    pairCreatedAt: finite(pair?.pairCreatedAt),
    url: pair?.url || ''
  };
}

async function geckoNewPools(network) {
  const response = await fetch(`https://api.geckoterminal.com/api/v2/networks/${encodeURIComponent(network)}/new_pools?page=1`, {
    headers: { accept: 'application/json;version=20230203' }
  });
  if (!response.ok) throw new Error(`GeckoTerminal ${network} HTTP ${response.status}`);
  const body = await response.json();
  return Array.isArray(body?.data) ? body.data : [];
}

function geckoPool(row, network) {
  const a = row?.attributes ?? {};
  const rel = row?.relationships ?? {};
  const baseId = String(rel?.base_token?.data?.id ?? '');
  const tokenAddress = baseId.startsWith(`${network}_`) ? baseId.slice(network.length + 1) : baseId.split('_').slice(1).join('_');
  const tx = a?.transactions?.m5 ?? {};
  const priceChange = finite(a?.price_change_percentage?.m5);
  return {
    address: tokenAddress,
    symbol: String(a?.name ?? 'TOKEN').split('/')[0].trim() || 'TOKEN',
    liquidityUsd: finite(a?.reserve_in_usd),
    marketCapUsd: finite(a?.market_cap_usd, finite(a?.fdv_usd)),
    buys5m: finite(tx?.buys),
    sells5m: finite(tx?.sells),
    priceChange5mPct: priceChange,
    volume5mUsd: finite(a?.volume_usd?.m5),
    createdAt: Date.parse(a?.pool_created_at || '') || 0,
    poolAddress: String(a?.address ?? ''),
    url: a?.address ? `https://www.geckoterminal.com/${network}/pools/${a.address}` : ''
  };
}

function earlyMarketOk(market, { minLiquidity = 8_000, maxMarketCap = 3_000_000, minBuys = 5, minSells = 1, minRatio = 1.4, maxMove = 50 } = {}) {
  if (!market?.address) return false;
  const ratio = finite(market.buys5m) / Math.max(1, finite(market.sells5m));
  return finite(market.liquidityUsd) >= minLiquidity
    && finite(market.marketCapUsd) > 0
    && finite(market.marketCapUsd) <= maxMarketCap
    && finite(market.buys5m) >= minBuys
    && finite(market.sells5m) >= minSells
    && ratio >= minRatio
    && finite(market.priceChange5mPct) <= maxMove;
}

function topTierOk(market) {
  const ratio = finite(market?.buys5m) / Math.max(1, finite(market?.sells5m));
  return finite(market?.liquidityUsd) >= 15_000
    && finite(market?.marketCapUsd) > 0
    && finite(market?.marketCapUsd) <= 1_500_000
    && finite(market?.buys5m) >= 10
    && finite(market?.sells5m) >= 2
    && ratio >= 2
    && finite(market?.priceChange5mPct) <= 25;
}

class JsonRpcLane {
  constructor(url, label, minGapMs = 850) {
    this.url = url;
    this.label = label;
    this.minGapMs = minGapMs;
    this.id = 0;
    this.tail = Promise.resolve();
    this.nextAt = 0;
  }
  call(method, params = []) {
    const job = this.tail.then(async () => {
      for (let attempt = 0; attempt < 5; attempt += 1) {
        const waitMs = Math.max(0, this.nextAt - Date.now());
        if (waitMs) await sleep(waitMs);
        this.nextAt = Date.now() + this.minGapMs;
        const response = await fetch(this.url, {
          method: 'POST',
          headers: { 'content-type': 'application/json', accept: 'application/json' },
          body: JSON.stringify({ jsonrpc: '2.0', id: ++this.id, method, params })
        });
        if (response.status === 429) {
          const retry = Math.min(30_000, 2_000 * (2 ** attempt));
          console.warn(`[${this.label}:rpc-429] method=${method} retry=${attempt + 1} delay=${retry}ms`);
          await sleep(retry);
          continue;
        }
        if (!response.ok) throw new Error(`${this.label} ${method} HTTP ${response.status}`);
        const body = await response.json();
        if (body?.error) throw new Error(`${this.label} ${method} ${body.error.code}: ${body.error.message}`);
        return body?.result;
      }
      throw new Error(`${this.label} ${method} rate limited after retries`);
    });
    this.tail = job.catch(() => undefined);
    return job;
  }
}

class EvmNetworkWorker {
  constructor(config) {
    this.config = config;
    this.wallets = parseEvmWallets(config.walletEnv);
    this.walletByAddress = new Map(this.wallets.map((wallet) => [wallet.address, wallet]));
    this.walletTopics = this.wallets.map((wallet) => padTopicAddress(wallet.address));
    this.rpc = new JsonRpcLane(config.rpc, config.key, config.minGapMs);
    this.lastBlock = 0;
    this.running = false;
    this.seen = new Set();
    this.clusters = new Map();
    this.earlyAlerted = new Set();
    this.topAlerted = new Set();
  }
  async payerEvidence(wallet, tx, receipt, boughtToken) {
    if (low(tx?.from) === wallet) return true;
    for (const log of receipt?.logs ?? []) {
      if (low(log?.topics?.[0]) !== TRANSFER_TOPIC) continue;
      if (topicAddress(log?.topics?.[1]) !== wallet) continue;
      const to = topicAddress(log?.topics?.[2]);
      if (!to || to === ZERO || low(log?.address) === low(boughtToken)) continue;
      return true;
    }
    return false;
  }
  addCluster(token, event) {
    const cutoff = Date.now() - 90_000;
    const prior = (this.clusters.get(token) ?? []).filter((item) => item.at >= cutoff && item.wallet !== event.wallet);
    prior.push(event);
    this.clusters.set(token, prior);
    return prior;
  }
  async sendEarly(token, event, market) {
    if (this.earlyAlerted.has(token)) return;
    this.earlyAlerted.add(token);
    const lines = [
      `👀⚡ SUMMECA EARLY WATCH — ${this.config.label}`,
      '',
      `$${market?.symbol || 'TOKEN'} • ${this.config.label}`,
      `🧠 محفظة متتبعة: ${event.label}`,
      '✅ تم إثبات أن المحفظة شاركت فعليًا في المعاملة، وليس مجرد تحويل توكن إليها.',
      market ? `💧 السيولة: $${money(market.liquidityUsd)} | MC: $${money(market.marketCapUsd)}` : '🟡 لم يظهر سوق DEX مؤكد بعد — PRE-DEX watch',
      market ? `5m: شراء ${market.buys5m} / بيع ${market.sells5m} | حركة ${finite(market.priceChange5mPct).toFixed(1)}%` : '',
      '',
      '⚠️ EARLY WATCH وليست ضمانًا للصعود.',
      `CA: ${token}`
    ].filter(Boolean).join('\n');
    await sink.send(lines, this.config.dexChain, token, market?.url || '');
  }
  async maybeTopTier(token, events, market) {
    if (this.topAlerted.has(token) || events.length < 2 || !topTierOk(market)) return;
    const unique = [...new Map(events.map((event) => [event.wallet, event])).values()];
    if (unique.length < 2) return;
    this.topAlerted.add(token);
    await sink.send([
      `💎🔥 SUMMECA TOP-TIER — ${this.config.label}`,
      '',
      `$${market.symbol || 'TOKEN'} • ${this.config.label}`,
      `👥 ${unique.length} محافظ متتبعة دخلت خلال نافذة قصيرة`,
      `💧 السيولة: $${money(market.liquidityUsd)} | MC: $${money(market.marketCapUsd)}`,
      `5m: شراء ${market.buys5m} / بيع ${market.sells5m}`,
      `📈 الحركة: ${finite(market.priceChange5mPct).toFixed(1)}%`,
      '🛡️ Anti-spoof payer evidence: PASSED',
      '',
      '⚠️ فرصة عالية الإشارة وليست ضمانًا للربح.',
      `CA: ${token}`
    ].join('\n'), this.config.dexChain, token, market.url || '');
  }
  async processLog(log) {
    const token = low(log?.address);
    const wallet = topicAddress(log?.topics?.[2]);
    if (!EVM.test(token) || !this.walletByAddress.has(wallet)) return;
    const key = `${String(log?.transactionHash)}:${String(log?.logIndex)}`;
    if (this.seen.has(key)) return;
    this.seen.add(key);
    if (this.seen.size > 6000) this.seen.clear();
    const [tx, receipt] = await Promise.all([
      this.rpc.call('eth_getTransactionByHash', [log.transactionHash]),
      this.rpc.call('eth_getTransactionReceipt', [log.transactionHash])
    ]);
    if (!await this.payerEvidence(wallet, tx, receipt, token)) return;
    const info = this.walletByAddress.get(wallet);
    const event = { wallet, label: info?.label || short(wallet), at: Date.now(), txHash: log.transactionHash };
    const cluster = this.addCluster(token, event);
    const market = await dexSnapshot(this.config.dexChain, token).catch(() => null);
    await this.sendEarly(token, event, market);
    if (market) await this.maybeTopTier(token, cluster, market);
  }
  async cycle() {
    if (this.running || !this.walletTopics.length) return;
    this.running = true;
    try {
      const latestHex = await this.rpc.call('eth_blockNumber');
      const latest = Number.parseInt(String(latestHex || '0x0'), 16);
      if (!(latest > 0)) return;
      if (!this.lastBlock) {
        this.lastBlock = Math.max(0, latest - 2);
        console.log(`[${this.config.key}] synced latest=${latest} wallets=${this.wallets.length}`);
      }
      const from = this.lastBlock + 1;
      if (from > latest) return;
      const to = Math.min(latest, from + this.config.maxBlocks - 1);
      const logs = await this.rpc.call('eth_getLogs', [{
        fromBlock: `0x${from.toString(16)}`,
        toBlock: `0x${to.toString(16)}`,
        topics: [TRANSFER_TOPIC, null, this.walletTopics]
      }]);
      this.lastBlock = to;
      for (const log of Array.isArray(logs) ? logs.slice(0, 100) : []) await this.processLog(log);
    } catch (error) {
      console.warn(`[${this.config.key}]`, error.message);
    } finally {
      this.running = false;
    }
  }
  async start() {
    if (!this.config.enabled) return false;
    if (!this.wallets.length) {
      console.warn(`[${this.config.key}] wallet-driven mode unavailable — no wallets configured; market discovery still runs`);
      return false;
    }
    console.log(`SUMMECA ${this.config.label}: wallet-driven EVM radar wallets=${this.wallets.length}`);
    await this.cycle();
    setInterval(() => void this.cycle(), this.config.pollMs).unref?.();
    return true;
  }
}

class NewPoolDiscovery {
  constructor(configs) {
    this.configs = configs;
    this.seen = new Map();
    this.running = false;
  }
  remember(key) {
    if (this.seen.has(key)) return true;
    this.seen.set(key, Date.now());
    if (this.seen.size > 3000) {
      const cutoff = Date.now() - 6 * 60 * 60 * 1000;
      for (const [id, at] of this.seen) if (at < cutoff) this.seen.delete(id);
    }
    return false;
  }
  async scan(config) {
    if (!config.enabled) return;
    const rows = await geckoNewPools(config.geckoNetwork);
    for (const row of rows) {
      const market = geckoPool(row, config.geckoNetwork);
      if (!market.address || this.remember(`${config.key}:${market.poolAddress || market.address}`)) continue;
      const ageMs = market.createdAt ? Date.now() - market.createdAt : Infinity;
      if (ageMs < 0 || ageMs > 15 * 60_000) continue;
      if (!earlyMarketOk(market)) continue;
      await sink.send([
        `🚨📈 SUMMECA EARLY MARKET — ${config.label}`,
        '',
        `$${market.symbol} • ${config.label}`,
        `⏱️ عمر السوق: ${Math.max(0, Math.round(ageMs / 1000))}s`,
        `💧 السيولة: $${money(market.liquidityUsd)} | MC: $${money(market.marketCapUsd)}`,
        `5m: شراء ${market.buys5m} / بيع ${market.sells5m} | Vol $${money(market.volume5mUsd)}`,
        `📈 الحركة: ${finite(market.priceChange5mPct).toFixed(1)}%`,
        '',
        '🟡 رصد سوق مبكر؛ يرتفع إلى TOP-TIER إذا تأكد نشاط المحافظ/الشروط الأقوى.',
        `CA: ${market.address}`
      ].join('\n'), config.dexChain, market.address, market.url || '');
    }
  }
  async cycle() {
    if (this.running) return;
    this.running = true;
    try {
      for (const config of this.configs) {
        try { await this.scan(config); } catch (error) { console.warn(`[${config.key}:new-pools]`, error.message); }
        await sleep(2_500);
      }
    } finally {
      this.running = false;
    }
  }
  async start() {
    await this.cycle();
    setInterval(() => void this.cycle(), 60_000).unref?.();
  }
}

class SolanaLaunchWorker {
  constructor() {
    this.enabled = boolEnv('SOLANA_RADAR_ENABLED', true);
    this.ws = null;
    this.active = false;
    this.reconnectAttempt = 0;
    this.subscriptionId = null;
    this.seenSignatures = new Set();
    this.pending = new Map();
    this.earlyAlerted = new Set();
    this.topAlerted = new Set();
    this.batchRunning = false;
  }
  isCreate(logs) {
    const text = (Array.isArray(logs) ? logs : []).join('\n').toLowerCase();
    return /instruction:\s*create(?:v2)?\b/.test(text);
  }
  queueMint(mint) {
    if (!SOLANA.test(mint)) return;
    const prior = this.pending.get(mint);
    this.pending.set(mint, prior || { createdAt: Date.now(), lastMarketAt: 0 });
    if (this.pending.size > 500) {
      const oldest = [...this.pending.entries()].sort((a, b) => a[1].createdAt - b[1].createdAt).slice(0, 50);
      for (const [key] of oldest) this.pending.delete(key);
    }
  }
  async resolveCreate(signature) {
    if (!signature || this.seenSignatures.has(signature)) return;
    this.seenSignatures.add(signature);
    if (this.seenSignatures.size > 5000) this.seenSignatures.clear();
    try {
      const mint = await resolvePumpCreateMint(env.heliusApiKey, signature, { retries: 2, retryDelayMs: 300 });
      if (mint) {
        this.queueMint(mint);
        console.log(`[solana:new-token] mint=${short(mint)} sig=${short(signature)}`);
      }
    } catch (error) {
      console.warn('[solana:resolve-create]', error.message);
    }
  }
  connect() {
    if (!this.enabled || !this.active || typeof WebSocket === 'undefined') return;
    const ws = new WebSocket('wss://api.mainnet-beta.solana.com');
    this.ws = ws;
    ws.addEventListener('open', () => {
      this.reconnectAttempt = 0;
      ws.send(JSON.stringify({
        jsonrpc: '2.0', id: 501, method: 'logsSubscribe',
        params: [{ mentions: [PUMP_FUN_PROGRAM_ID] }, { commitment: 'processed' }]
      }));
      console.log('SUMMECA SOLANA: Pump.fun launch stream connected');
    });
    ws.addEventListener('message', (event) => {
      let message;
      try { message = JSON.parse(String(event.data)); } catch { return; }
      if (message?.id === 501 && typeof message?.result === 'number') {
        this.subscriptionId = message.result;
        return;
      }
      if (message?.method !== 'logsNotification') return;
      const value = message?.params?.result?.value ?? {};
      if (value?.err || !this.isCreate(value?.logs)) return;
      void this.resolveCreate(String(value?.signature ?? ''));
    });
    ws.addEventListener('error', () => { try { ws.close(); } catch {} });
    ws.addEventListener('close', () => {
      if (!this.active || this.ws !== ws) return;
      this.ws = null;
      const delay = Math.min(30_000, 1_000 * (2 ** this.reconnectAttempt++));
      console.warn(`[solana:ws] reconnect in ${delay}ms`);
      setTimeout(() => this.connect(), delay).unref?.();
    });
  }
  async marketBatch() {
    if (this.batchRunning || !this.pending.size) return;
    this.batchRunning = true;
    try {
      const now = Date.now();
      for (const [mint, state] of this.pending) {
        if (now - state.createdAt > 30 * 60_000) this.pending.delete(mint);
      }
      const mints = [...this.pending.entries()]
        .filter(([, state]) => now - state.lastMarketAt >= 10_000)
        .slice(0, 30)
        .map(([mint, state]) => { state.lastMarketAt = now; return mint; });
      if (!mints.length) return;
      const response = await fetch(`https://api.dexscreener.com/tokens/v1/solana/${mints.map(encodeURIComponent).join(',')}`, {
        headers: { accept: 'application/json' }
      });
      if (!response.ok) throw new Error(`DexScreener Solana HTTP ${response.status}`);
      const rows = await response.json().catch(() => []);
      const grouped = new Map();
      for (const row of Array.isArray(rows) ? rows : []) {
        const addresses = [String(row?.baseToken?.address ?? ''), String(row?.quoteToken?.address ?? '')];
        const mint = addresses.find((address) => this.pending.has(address));
        if (!mint) continue;
        const prior = grouped.get(mint);
        if (!prior || finite(row?.liquidity?.usd) > finite(prior?.liquidity?.usd)) grouped.set(mint, row);
      }
      for (const mint of mints) {
        const pair = grouped.get(mint);
        if (!pair) continue;
        const token = String(pair?.baseToken?.address) === mint ? pair.baseToken : pair.quoteToken;
        const market = {
          address: mint, symbol: token?.symbol || 'TOKEN',
          liquidityUsd: finite(pair?.liquidity?.usd), marketCapUsd: finite(pair?.marketCap, finite(pair?.fdv)),
          buys5m: finite(pair?.txns?.m5?.buys), sells5m: finite(pair?.txns?.m5?.sells),
          priceChange5mPct: finite(pair?.priceChange?.m5), volume5mUsd: finite(pair?.volume?.m5),
          url: pair?.url || ''
        };
        if (!this.earlyAlerted.has(mint) && earlyMarketOk(market, { minLiquidity: 5_000, minBuys: 4, minSells: 1, minRatio: 1.5, maxMove: 50 })) {
          this.earlyAlerted.add(mint);
          await sink.send([
            '👀⚡ SUMMECA EARLY WATCH — SOLANA', '',
            `$${market.symbol} • SOLANA • Pump.fun`,
            `⏱️ تم التقاط الإنشاء مباشرة ثم تأكيد أول سوق`,
            `💧 السيولة: $${money(market.liquidityUsd)} | MC: $${money(market.marketCapUsd)}`,
            `5m: شراء ${market.buys5m} / بيع ${market.sells5m} | Vol $${money(market.volume5mUsd)}`,
            `📈 الحركة: ${finite(market.priceChange5mPct).toFixed(1)}%`, '',
            '⚠️ رصد مبكر وليس ضمانًا للصعود.',
            `CA: ${mint}`
          ].join('\n'), 'solana', mint, market.url);
        }
        if (!this.topAlerted.has(mint) && topTierOk(market)) {
          this.topAlerted.add(mint);
          await sink.send([
            '💎🔥 SUMMECA TOP-TIER — SOLANA', '',
            `$${market.symbol} • SOLANA`,
            `💧 السيولة: $${money(market.liquidityUsd)} | MC: $${money(market.marketCapUsd)}`,
            `5m: شراء ${market.buys5m} / بيع ${market.sells5m} | Vol $${money(market.volume5mUsd)}`,
            `📈 الحركة: ${finite(market.priceChange5mPct).toFixed(1)}%`,
            '✅ عقد جديد + نشاط شراء/بيع + سيولة + فلاتر دخول مبكر', '',
            '⚠️ TOP-TIER تعني تحقق شروط الرادار وليست ضمان ربح.',
            `CA: ${mint}`
          ].join('\n'), 'solana', mint, market.url);
        }
      }
    } catch (error) {
      console.warn('[solana:market-batch]', error.message);
    } finally {
      this.batchRunning = false;
    }
  }
  start() {
    if (!this.enabled) return false;
    if (typeof WebSocket === 'undefined') {
      console.warn('[solana] disabled — WebSocket unavailable');
      return false;
    }
    this.active = true;
    this.connect();
    setInterval(() => void this.marketBatch(), 5_000).unref?.();
    return true;
  }
}

const evmConfigs = [
  {
    key: 'bnb', label: 'BNB CHAIN', dexChain: 'bsc', geckoNetwork: 'bsc',
    rpc: process.env.BNB_RPC_URL || 'https://bsc-dataseed.bnbchain.org',
    walletEnv: 'BNB_WALLETS', enabled: boolEnv('BNB_RADAR_ENABLED', true),
    pollMs: 3_500, maxBlocks: 8, minGapMs: 700
  },
  {
    key: 'robinhood', label: 'ROBINHOOD CHAIN', dexChain: 'robinhood', geckoNetwork: 'robinhood',
    rpc: process.env.ROBINHOOD_RPC_URL || 'https://rpc.mainnet.chain.robinhood.com',
    walletEnv: 'ROBINHOOD_WALLETS', enabled: boolEnv('ROBINHOOD_RADAR_ENABLED', true),
    pollMs: 3_500, maxBlocks: 20, minGapMs: 800
  }
];

let singleton = null;
export class MultiChainWorker {
  constructor() {
    this.enabled = boolEnv('MULTICHAIN_ENABLED', true);
    this.evmWorkers = evmConfigs.map((config) => new EvmNetworkWorker(config));
    this.discovery = new NewPoolDiscovery(evmConfigs);
    this.solana = new SolanaLaunchWorker();
  }
  async start() {
    if (!this.enabled) {
      console.log('SUMMECA MULTICHAIN: disabled');
      return false;
    }
    console.log('SUMMECA MULTICHAIN: Arc + Solana + BNB Chain + Robinhood Chain');
    await Promise.all(this.evmWorkers.map((worker) => worker.start().catch((error) => console.warn('[multichain:evm-start]', error.message))));
    await this.discovery.start();
    this.solana.start();
    return true;
  }
}

export async function startMultiChainWorker() {
  if (!singleton) singleton = new MultiChainWorker();
  await singleton.start();
  return singleton;
}
