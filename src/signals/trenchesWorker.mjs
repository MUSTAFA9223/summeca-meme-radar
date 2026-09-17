import { env } from '../config/env.mjs';
import { telegramApi } from '../notifiers/telegram.mjs';

const TRANSFER_TOPIC = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';
const ARC_SYSTEM_EMITTER = '0xfffffffffffffffffffffffffffffffffffffffe';
const ARC_NATIVE_USDC = '0x3600000000000000000000000000000000000000';
const ZERO = '0x0000000000000000000000000000000000000000';
const EVM = /^0x[0-9a-f]{40}$/;
const DEX_API = 'https://api.dexscreener.com/latest/dex/tokens';
const GOPLUS = 'https://api.gopluslabs.io/api/v1/token_security/5042';

const finite = (value, fallback = 0) => Number.isFinite(Number(value)) ? Number(value) : fallback;
const low = (value) => String(value ?? '').trim().toLowerCase();
const clamp = (value, min, max) => Math.max(min, Math.min(max, value));
const money = (value) => {
  const n = finite(value);
  if (Math.abs(n) >= 1e6) return `${(n / 1e6).toFixed(2)}M`;
  if (Math.abs(n) >= 1e3) return `${(n / 1e3).toFixed(1)}K`;
  return n.toFixed(n >= 100 ? 0 : 2);
};
const padTopicAddress = (address) => `0x${'0'.repeat(24)}${low(address).slice(2)}`;
const topicAddress = (topic) => topic && topic.length >= 42 ? `0x${topic.slice(-40)}`.toLowerCase() : '';
const hexBigInt = (value) => {
  try { return BigInt(value || '0x0'); } catch { return 0n; }
};
const usd18 = (value) => Number(hexBigInt(value)) / 1e18;

function arcKeyboard(address, dexUrl = '') {
  const token = low(address);
  if (!token) return undefined;
  const encoded = encodeURIComponent(token);
  const rows = [
    [{ text: '📋 نسخ العقد / Copy CA', copy_text: { text: token } }],
    [
      { text: '🟢 GMGN', url: `https://gmgn.ai/arc/token/${encoded}` },
      { text: '🔥 FOMO', url: `https://fomo.family/tokens/arc/${encoded}` }
    ]
  ];
  if (dexUrl) rows.push([{ text: '📊 فتح DEX', url: dexUrl }]);
  return { inline_keyboard: rows };
}

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
  async blockNumber() { return Number.parseInt(String(await this.call('eth_blockNumber') ?? '0x0'), 16); }
  async logs(fromBlock, toBlock, walletTopics) {
    return this.call('eth_getLogs', [{
      fromBlock: `0x${fromBlock.toString(16)}`,
      toBlock: `0x${toBlock.toString(16)}`,
      topics: [TRANSFER_TOPIC, null, walletTopics]
    }]);
  }
  tx(hash) { return this.call('eth_getTransactionByHash', [hash]); }
  receipt(hash) { return this.call('eth_getTransactionReceipt', [hash]); }
}

class Store {
  constructor(url, key) { this.url = String(url ?? '').replace(/\/$/, ''); this.key = String(key ?? ''); }
  get enabled() { return Boolean(this.url && this.key); }
  async request(path, { method = 'GET', body, prefer } = {}) {
    if (!this.enabled) return null;
    const response = await fetch(`${this.url}/rest/v1/${path}`, {
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
  async chatId() {
    if (env.telegramChatId) return String(env.telegramChatId);
    const rows = await this.request('app_settings?select=value&key=eq.telegram_chat_id&limit=1');
    return String(Array.isArray(rows) ? rows[0]?.value ?? '' : '');
  }
  async language() {
    const rows = await this.request('app_settings?select=value&key=eq.telegram_language&limit=1');
    const value = String(Array.isArray(rows) ? rows[0]?.value ?? '' : '').toLowerCase();
    return ['ar', 'en', 'bilingual'].includes(value) ? value : env.telegramLanguage;
  }
  async save(candidate, score, safety) {
    if (!this.enabled) return null;
    const tokenRows = await this.request('tokens?on_conflict=address', {
      method: 'POST', prefer: 'resolution=merge-duplicates,return=representation',
      body: {
        chain: 'arc', address: candidate.address, symbol: candidate.symbol ?? null,
        name: candidate.name ?? candidate.symbol ?? null, source: 'arc-onchain-trenches',
        last_seen_at: new Date().toISOString(), initial_price_usd: candidate.priceUsd || null,
        initial_liquidity_usd: candidate.liquidityUsd || null, highest_price_usd: candidate.priceUsd || null,
        status: 'tracking'
      }
    });
    const token = Array.isArray(tokenRows) ? tokenRows[0] : null;
    if (!token?.id) return null;
    return this.request('signals', {
      method: 'POST', prefer: 'return=representation',
      body: {
        token_id: token.id, signal_type: 'entry', entry_score: score,
        moon_score: Math.min(100, score + 5), risk_score: safety.risk,
        reason: {
          trigger: 'trenches-onchain-cluster', origin: 'arc-public-onchain',
          wallets: candidate.events.map((event) => ({ address: event.wallet, label: event.label, tx: event.txHash, paid_usd: event.paidUsd })),
          confirming_wallets: candidate.wallets, observed_paid_usd: candidate.paidUsd,
          market_cap_usd: candidate.marketCapUsd, liquidity_usd: candidate.liquidityUsd,
          buys_5m: candidate.buys5m, sells_5m: candidate.sells5m,
          payer_verified: true, safety_reasons: safety.reasons
        }
      }
    });
  }
}

async function dexSnapshot(address) {
  const response = await fetch(`${DEX_API}/${address}`, { headers: { accept: 'application/json' } });
  if (!response.ok) throw new Error(`DexScreener HTTP ${response.status}`);
  const payload = await response.json();
  const pairs = (Array.isArray(payload?.pairs) ? payload.pairs : [])
    .filter((pair) => low(pair?.chainId) === 'arc')
    .sort((a, b) => finite(b?.liquidity?.usd) - finite(a?.liquidity?.usd));
  const pair = pairs[0];
  if (!pair) return null;
  const token = low(pair?.baseToken?.address) === low(address) ? pair.baseToken : pair.quoteToken;
  return {
    address: low(address), symbol: token?.symbol || 'TOKEN', name: token?.name || token?.symbol || 'Arc token',
    priceUsd: finite(pair?.priceUsd), liquidityUsd: finite(pair?.liquidity?.usd),
    marketCapUsd: finite(pair?.marketCap, finite(pair?.fdv)), volume5mUsd: finite(pair?.volume?.m5),
    buys5m: finite(pair?.txns?.m5?.buys), sells5m: finite(pair?.txns?.m5?.sells),
    priceChange5mPct: finite(pair?.priceChange?.m5), price24hPct: finite(pair?.priceChange?.h24),
    dexUrl: pair?.url || `https://dexscreener.com/arc/${pair?.pairAddress || ''}`
  };
}

async function contractSafety(candidate) {
  const reasons = [];
  if (candidate.liquidityUsd < env.trenchesMinLiquidityUsd) reasons.push('low-liquidity');
  if (candidate.sells5m < 1) reasons.push('no-real-sells');
  if (candidate.buys5m > 15 && candidate.sells5m === 0) reasons.push('honeypot-pattern');
  if (candidate.priceChange5mPct > env.trenchesMaxPriceSinceFirstBuyPct) reasons.push('entry-too-late');
  if (env.trenchesMaxMarketCapUsd > 0 && candidate.marketCapUsd > env.trenchesMaxMarketCapUsd) reasons.push('market-cap-too-high');

  let providerVerified = false;
  try {
    const qs = new URLSearchParams({ contract_addresses: candidate.address });
    const response = await fetch(`${GOPLUS}?${qs}`, { headers: { accept: 'application/json' } });
    if (response.ok) {
      const body = await response.json();
      const row = body?.result?.[candidate.address] ?? body?.result?.[low(candidate.address)];
      if (row) {
        providerVerified = true;
        const flag = (key) => String(row?.[key] ?? '') === '1';
        if (flag('is_honeypot')) reasons.push('honeypot');
        if (flag('cannot_sell_all')) reasons.push('cannot-sell-all');
        if (flag('is_blacklisted')) reasons.push('blacklist-risk');
        if (flag('hidden_owner')) reasons.push('hidden-owner');
      }
    }
  } catch {}
  return { ok: reasons.length === 0, risk: reasons.length ? 80 : providerVerified ? 15 : 25, reasons, providerVerified };
}

function scoreCandidate(candidate) {
  const walletScore = Math.min(35, candidate.wallets * 12);
  const flowScore = candidate.paidUsd > 0 ? Math.min(25, Math.log10(1 + candidate.paidUsd) * 6) : 8;
  const liquidityScore = Math.min(20, Math.log10(1 + candidate.liquidityUsd) * 3.5);
  const activityScore = Math.min(12, candidate.buys5m * 0.8) + Math.min(8, candidate.sells5m * 1.2);
  const early = candidate.priceChange5mPct <= 5 ? 10 : candidate.priceChange5mPct <= 20 ? 7 : 3;
  return clamp(Math.round(walletScore + flowScore + liquidityScore + activityScore + early), 0, 100);
}

export class TrenchesWorker {
  constructor() {
    this.wallets = parseWallets();
    this.walletByAddress = new Map(this.wallets.map((wallet) => [wallet.address, wallet]));
    this.walletTopics = this.wallets.map((wallet) => padTopicAddress(wallet.address));
    this.rpc = new RpcClient(process.env.TRENCHES_RPC_URL || 'https://rpc.mainnet.arc.io');
    this.store = new Store(env.supabaseUrl, env.supabaseSecretKey);
    this.pollMs = Math.max(1_500, finite(process.env.TRENCHES_RPC_POLL_MS, 2_500));
    this.maxBlocks = Math.max(1, Math.min(50, Math.floor(finite(process.env.TRENCHES_MAX_BLOCKS_PER_CYCLE, 12))));
    this.clusterMs = Math.max(30_000, finite(process.env.TRENCHES_CLUSTER_WINDOW_MS, 120_000));
    this.eliteSingleUsd = Math.max(0, finite(process.env.TRENCHES_ELITE_SINGLE_USD, 5_000));
    this.lastBlock = 0;
    this.running = false;
    this.clusters = new Map();
    this.seen = new Map();
    this.emitted = new Map();
    this.chatId = '';
    this.language = env.telegramLanguage;
  }

  remember(key) {
    if (this.seen.has(key)) return true;
    this.seen.set(key, Date.now());
    if (this.seen.size > 5000) {
      const cutoff = Date.now() - 6 * 60 * 60 * 1000;
      for (const [id, at] of this.seen) if (at < cutoff) this.seen.delete(id);
    }
    return false;
  }

  payerEvidence(wallet, tx, receipt, boughtToken) {
    if (low(tx?.from) === wallet) {
      return { verified: true, paidUsd: usd18(tx?.value), mode: 'tx-from' };
    }
    let paidUsd = 0;
    let verified = false;
    for (const log of receipt?.logs ?? []) {
      if (low(log?.topics?.[0]) !== TRANSFER_TOPIC || topicAddress(log?.topics?.[1]) !== wallet) continue;
      const to = topicAddress(log?.topics?.[2]);
      if (!to || to === ZERO) continue;
      if (low(log?.address) === low(boughtToken)) continue;
      verified = true;
      if (low(log?.address) === ARC_SYSTEM_EMITTER || low(log?.address) === ARC_NATIVE_USDC) {
        paidUsd = Math.max(paidUsd, usd18(log?.data));
      }
    }
    return { verified, paidUsd, mode: verified ? 'outflow-proof' : 'none' };
  }

  addEvent(token, event) {
    const cutoff = Date.now() - this.clusterMs;
    const fresh = (this.clusters.get(token) ?? []).filter((item) => item.observedAt >= cutoff && item.wallet !== event.wallet);
    fresh.push(event);
    this.clusters.set(token, fresh);
    return fresh;
  }

  async notify(candidate, score, safety) {
    if (!env.telegramBotToken) return;
    if (!this.chatId) this.chatId = await this.store.chatId().catch(() => '');
    if (!this.chatId) return;
    this.language = await this.store.language().catch(() => env.telegramLanguage);
    const walletLines = candidate.events.slice(0, 6).map((event) => `• ${event.label}: ${event.paidUsd > 0 ? `$${money(event.paidUsd)}` : 'verified buy'}`);
    const ar = [
      '🧠🔥 SUMMECA ON-CHAIN TRENCHES', '',
      `$${candidate.symbol} • ARC`,
      `👥 شراء مؤكد من ${candidate.wallets} محافظ متتبعة`,
      `💵 دفع مرصود: ${candidate.paidUsd > 0 ? `$${money(candidate.paidUsd)}` : 'تم إثبات الدفع بدون قيمة دقيقة'}`,
      ...walletLines,
      '',
      `MC: $${money(candidate.marketCapUsd)} | 💧 السيولة: $${money(candidate.liquidityUsd)}`,
      `5m: شراء ${candidate.buys5m} / بيع ${candidate.sells5m} | حركة ${candidate.priceChange5mPct.toFixed(1)}%`,
      `🎯 Smart Wallet Score: ${score}/100 | 🛡️ Risk: ${safety.risk}/100`,
      safety.providerVerified ? '✅ فحص العقد + نشاط البيع مؤكد' : '✅ تحقق on-chain + سيولة وبيع فعليان',
      '',
      '🛡️ Anti-spoof: لم تُقبل الإشارة إلا بعد إثبات خروج قيمة من نفس المحفظة أو كونها مرسل المعاملة.',
      '🧪 وضع مراقبة/اختبار فقط؛ الشراء الحقيقي غير مفعّل.',
      `CA: ${candidate.address}`,
      candidate.dexUrl ? `DEX: ${candidate.dexUrl}` : ''
    ].filter(Boolean).join('\n');
    const en = [
      '🧠🔥 SUMMECA ON-CHAIN TRENCHES', '',
      `$${candidate.symbol} • ARC`,
      `👥 ${candidate.wallets} tracked wallets confirmed buying`,
      `💵 Observed payment: ${candidate.paidUsd > 0 ? `$${money(candidate.paidUsd)}` : 'payer verified; exact value unavailable'}`,
      ...walletLines,
      '',
      `MC: $${money(candidate.marketCapUsd)} | 💧 Liquidity: $${money(candidate.liquidityUsd)}`,
      `5m: ${candidate.buys5m} buys / ${candidate.sells5m} sells | move ${candidate.priceChange5mPct.toFixed(1)}%`,
      `🎯 Smart Wallet Score: ${score}/100 | 🛡️ Risk: ${safety.risk}/100`,
      safety.providerVerified ? '✅ Contract + sell activity checked' : '✅ On-chain payer proof + real liquidity/sells checked',
      '',
      '🛡️ Anti-spoof: signal requires payment evidence from the tracked wallet or the wallet as transaction sender.',
      '🧪 Monitoring/testing only; live buying is disabled.',
      `CA: ${candidate.address}`,
      candidate.dexUrl ? `DEX: ${candidate.dexUrl}` : ''
    ].filter(Boolean).join('\n');
    const text = this.language === 'en' ? en : this.language === 'bilingual' ? `${ar}\n\n────────────\n\n${en}` : ar;
    await telegramApi(env.telegramBotToken, 'sendMessage', {
      chat_id: this.chatId,
      text,
      reply_markup: arcKeyboard(candidate.address, candidate.dexUrl)
    });
  }

  async evaluate(token, events) {
    const unique = [...new Map(events.map((event) => [event.wallet, event])).values()];
    const paidUsd = unique.reduce((sum, event) => sum + finite(event.paidUsd), 0);
    const confirmed = unique.length >= env.trenchesMinWallets || paidUsd >= this.eliteSingleUsd;
    if (!confirmed) return;
    const last = this.emitted.get(token) ?? 0;
    if (Date.now() - last < env.trenchesSignalCooldownMs) return;

    const market = await dexSnapshot(token).catch((error) => {
      console.warn('[trenches:dex]', token, error.message);
      return null;
    });
    if (!market) return;
    const candidate = { ...market, events: unique, wallets: unique.length, paidUsd };
    const safety = await contractSafety(candidate);
    if (!safety.ok) {
      console.warn(`[trenches:blocked] ${candidate.symbol} ${candidate.address} ${safety.reasons.join(',')}`);
      return;
    }
    const score = scoreCandidate(candidate);
    if (score < 60) return;
    this.emitted.set(token, Date.now());
    await this.store.save(candidate, score, safety).catch((error) => console.warn('[trenches:store]', error.message));
    await this.notify(candidate, score, safety).catch((error) => console.warn('[trenches:telegram]', error.message));
    console.log(`[trenches:signal] ARC ${candidate.symbol} wallets=${candidate.wallets} paid=$${Math.round(candidate.paidUsd)} liq=$${Math.round(candidate.liquidityUsd)} score=${score}`);
  }

  async processLog(log) {
    const token = low(log?.address);
    const wallet = topicAddress(log?.topics?.[2]);
    if (!EVM.test(token) || !this.walletByAddress.has(wallet)) return;
    if ([ARC_SYSTEM_EMITTER, ARC_NATIVE_USDC].includes(token)) return;
    const key = `${low(log?.transactionHash)}:${String(log?.logIndex)}`;
    if (this.remember(key)) return;
    const [tx, receipt] = await Promise.all([this.rpc.tx(log.transactionHash), this.rpc.receipt(log.transactionHash)]);
    const evidence = this.payerEvidence(wallet, tx, receipt, token);
    if (!evidence.verified) {
      console.log(`[trenches:spoof-drop] wallet=${wallet.slice(0, 8)}… token=${token.slice(0, 8)}… tx=${String(log.transactionHash).slice(0, 10)}…`);
      return;
    }
    const info = this.walletByAddress.get(wallet);
    const event = {
      wallet, label: info?.label || wallet.slice(0, 8), txHash: log.transactionHash,
      paidUsd: evidence.paidUsd, proof: evidence.mode, observedAt: Date.now()
    };
    const cluster = this.addEvent(token, event);
    await this.evaluate(token, cluster);
  }

  async cycle() {
    if (this.running || !this.walletTopics.length) return;
    this.running = true;
    try {
      const latest = await this.rpc.blockNumber();
      if (!(latest > 0)) return;
      if (!this.lastBlock) {
        this.lastBlock = Math.max(0, latest - 2);
        console.log(`[trenches:onchain] synced latest=${latest} wallets=${this.wallets.length}`);
      }
      const from = this.lastBlock + 1;
      if (from > latest) return;
      const to = Math.min(latest, from + this.maxBlocks - 1);
      const logs = await this.rpc.logs(from, to, this.walletTopics);
      this.lastBlock = to;
      if (Array.isArray(logs) && logs.length) {
        console.log(`[trenches:onchain] blocks=${from}-${to} incomingTransfers=${logs.length}`);
        for (const log of logs.slice(0, 100)) await this.processLog(log);
      }
    } catch (error) {
      console.error('[trenches:onchain]', error.message);
    } finally {
      this.running = false;
    }
  }

  async start() {
    if (!env.trenchesEnabled) {
      console.log('SUMMECA TRENCHES: disabled');
      return false;
    }
    if (!this.wallets.length) {
      console.error('SUMMECA TRENCHES: no TRENCHES_WALLETS configured');
      return false;
    }
    console.log(`SUMMECA TRENCHES: ON-CHAIN ARC wallet-driven mode wallets=${this.wallets.length} poll=${this.pollMs}ms`);
    await this.cycle();
    setInterval(() => void this.cycle(), this.pollMs);
    return true;
  }
}

let singleton = null;
export async function startTrenchesWorker() {
  if (!singleton) singleton = new TrenchesWorker();
  await singleton.start();
  return singleton;
}
