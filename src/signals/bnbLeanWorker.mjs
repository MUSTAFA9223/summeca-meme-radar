import { env } from '../config/env.mjs';
import { telegramApi } from '../notifiers/telegram.mjs';
import { AppSettings } from '../storage/appSettings.mjs';

const RPC = process.env.BNB_RPC_URL || 'https://bsc-dataseed.bnbchain.org';
const TRANSFER_TOPIC = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';
const EVM = /^0x[0-9a-f]{40}$/;
const ZERO = '0x0000000000000000000000000000000000000000';
const low = (v) => String(v ?? '').trim().toLowerCase();
const finite = (v, f = 0) => Number.isFinite(Number(v)) ? Number(v) : f;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const topicAddress = (t) => t && t.length >= 42 ? `0x${t.slice(-40)}`.toLowerCase() : '';
const money = (n) => finite(n) >= 1e6 ? `${(finite(n) / 1e6).toFixed(2)}M` : finite(n) >= 1e3 ? `${(finite(n) / 1e3).toFixed(1)}K` : finite(n).toFixed(0);

function wallets() {
  return String(process.env.BNB_WALLETS || process.env.TRENCHES_WALLETS || '')
    .split(',').map((e) => e.trim()).filter(Boolean).map((entry, i) => {
      const [a, b] = entry.includes('|') ? entry.split('|', 2) : entry.includes('=') ? entry.split('=', 2) : [entry, ''];
      const address = EVM.test(low(a)) ? low(a) : EVM.test(low(b)) ? low(b) : '';
      const label = address === low(a) ? String(b || `wallet-${i + 1}`).trim() : String(a || `wallet-${i + 1}`).trim();
      return address ? { address, label } : null;
    }).filter(Boolean);
}

class Rpc {
  constructor() { this.id = 0; this.tail = Promise.resolve(); this.next = 0; }
  call(method, params = []) {
    const task = this.tail.then(async () => {
      for (let attempt = 0; attempt < 5; attempt += 1) {
        const waitMs = Math.max(0, this.next - Date.now());
        if (waitMs) await sleep(waitMs);
        this.next = Date.now() + 650;
        const r = await fetch(RPC, {
          method: 'POST',
          headers: { 'content-type': 'application/json', accept: 'application/json' },
          body: JSON.stringify({ jsonrpc: '2.0', id: ++this.id, method, params })
        });
        if (r.status === 429) {
          const delay = Math.min(30_000, 2_000 * (2 ** attempt));
          console.warn(`[bnb:rpc-429] method=${method} retry=${attempt + 1} delay=${delay}ms`);
          await sleep(delay);
          continue;
        }
        if (!r.ok) throw new Error(`BNB ${method} HTTP ${r.status}`);
        const b = await r.json();
        if (b?.error) throw new Error(`BNB ${method} ${b.error.code}: ${b.error.message}`);
        return b?.result;
      }
      throw new Error(`BNB ${method} retries exhausted`);
    });
    this.tail = task.catch(() => undefined);
    return task;
  }
}

class BnbLeanWorker {
  constructor() {
    this.enabled = String(process.env.BNB_LEAN_ENABLED ?? 'true') !== 'false';
    this.wallets = wallets();
    this.byAddress = new Map(this.wallets.map((w) => [w.address, w]));
    this.rpc = new Rpc();
    this.lastBlock = 0;
    this.running = false;
    this.seen = new Set();
    this.alerted = new Set();
    this.top = new Set();
    this.clusters = new Map();
    this.settings = new AppSettings(env.supabaseUrl, env.supabaseSecretKey);
    this.chatId = '';
  }

  async chat() {
    if (this.chatId) return this.chatId;
    if (env.telegramChatId) return (this.chatId = String(env.telegramChatId));
    this.chatId = String(await this.settings.get('telegram_chat_id').catch(() => '') || '');
    return this.chatId;
  }

  async market(token) {
    const r = await fetch(`https://api.dexscreener.com/tokens/v1/bsc/${token}`, { headers: { accept: 'application/json' } });
    if (!r.ok) return null;
    const rows = await r.json().catch(() => []);
    const p = (Array.isArray(rows) ? rows : []).sort((a, b) => finite(b?.liquidity?.usd) - finite(a?.liquidity?.usd))[0];
    if (!p) return null;
    const t = low(p?.baseToken?.address) === token ? p.baseToken : p.quoteToken;
    return {
      symbol: t?.symbol || 'TOKEN', liquidity: finite(p?.liquidity?.usd), mc: finite(p?.marketCap, finite(p?.fdv)),
      buys: finite(p?.txns?.m5?.buys), sells: finite(p?.txns?.m5?.sells), move: finite(p?.priceChange?.m5), url: p?.url || ''
    };
  }

  async notify(title, token, event, m) {
    const chatId = await this.chat();
    if (!chatId || !env.telegramBotToken) return;
    const rows = [
      [
        { text: '🔎 تحليل / Analyze', callback_data: `term:a:bsc:${token}` },
        { text: '📋 نسخ العقد / CA', copy_text: { text: token } }
      ],
      [
        { text: '🟢 Buy', callback_data: `term:b:bsc:${token}` },
        { text: '🔴 Sell', callback_data: `term:s:bsc:${token}` },
        { text: '📊 Positions', callback_data: 'term:p' }
      ],
      [{ text: '🟢 GMGN BSC', url: `https://gmgn.ai/bsc/token/${encodeURIComponent(token)}` }]
    ];
    if (m?.url) rows.push([{ text: '📊 فتح DEX', url: m.url }]);
    await telegramApi(env.telegramBotToken, 'sendMessage', {
      chat_id: chatId,
      text: [
        title, '', `$${m?.symbol || 'TOKEN'} • BNB CHAIN`, `🧠 المحفظة: ${event.label}`,
        '✅ Anti-spoof: المعاملة صادرة من المحفظة المتتبعة وتم التحقق من التوكن المستلم.',
        m ? `💧 السيولة: $${money(m.liquidity)} | MC: $${money(m.mc)}` : '🟡 PRE-DEX — السوق لم يظهر بعد',
        m ? `5m: شراء ${m.buys} / بيع ${m.sells} | حركة ${m.move.toFixed(1)}%` : '', '', `CA: ${token}`
      ].filter(Boolean).join('\n'),
      reply_markup: { inline_keyboard: rows }
    });
  }

  cluster(token, event) {
    const cutoff = Date.now() - 90_000;
    const a = (this.clusters.get(token) || []).filter((x) => x.at >= cutoff && x.wallet !== event.wallet);
    a.push(event);
    this.clusters.set(token, a);
    return a;
  }

  incomingTokens(receipt, wallet) {
    const tokens = [];
    for (const log of receipt?.logs ?? []) {
      if (low(log?.topics?.[0]) !== TRANSFER_TOPIC) continue;
      if (topicAddress(log?.topics?.[2]) !== wallet) continue;
      const token = low(log?.address);
      if (!EVM.test(token) || token === ZERO) continue;
      tokens.push(token);
    }
    return [...new Set(tokens)];
  }

  async processWalletTx(tx) {
    const wallet = low(tx?.from);
    const info = this.byAddress.get(wallet);
    if (!info || !tx?.hash) return;
    const txKey = low(tx.hash);
    if (this.seen.has(txKey)) return;
    this.seen.add(txKey);
    if (this.seen.size > 5000) this.seen.clear();

    const receipt = await this.rpc.call('eth_getTransactionReceipt', [tx.hash]);
    if (!receipt || String(receipt.status).toLowerCase() === '0x0') return;
    for (const token of this.incomingTokens(receipt, wallet)) {
      const event = { wallet, label: info.label, at: Date.now(), txHash: tx.hash };
      const c = this.cluster(token, event);
      const m = await this.market(token).catch(() => null);
      if (!this.alerted.has(token)) {
        this.alerted.add(token);
        await this.notify('👀⚡ SUMMECA EARLY WATCH — BNB CHAIN', token, event, m);
      }
      const unique = [...new Map(c.map((x) => [x.wallet, x])).values()];
      const ratio = m ? m.buys / Math.max(1, m.sells) : 0;
      if (!this.top.has(token) && unique.length >= 2 && m && m.liquidity >= 15_000 && m.mc > 0 && m.mc <= 1_500_000 && m.buys >= 10 && m.sells >= 2 && ratio >= 2 && m.move <= 25) {
        this.top.add(token);
        await this.notify('💎🔥 SUMMECA TOP-TIER — BNB CHAIN', token, event, m);
      }
    }
  }

  async cycle() {
    if (this.running || !this.wallets.length) return;
    this.running = true;
    try {
      const latest = Number.parseInt(String(await this.rpc.call('eth_blockNumber') || '0x0'), 16);
      if (!(latest > 0)) return;
      if (!this.lastBlock) {
        this.lastBlock = Math.max(0, latest - 1);
        console.log(`[bnb-lean] synced latest=${latest} wallets=${this.wallets.length} mode=wallet-tx-block-scan`);
      }
      const from = this.lastBlock + 1;
      if (from > latest) return;
      const to = Math.min(latest, from + 2);
      for (let number = from; number <= to; number += 1) {
        const block = await this.rpc.call('eth_getBlockByNumber', [`0x${number.toString(16)}`, true]);
        const matched = (block?.transactions ?? []).filter((tx) => this.byAddress.has(low(tx?.from)));
        if (matched.length) console.log(`[bnb-lean] block=${number} trackedWalletTxs=${matched.length}`);
        for (const tx of matched.slice(0, 25)) await this.processWalletTx(tx);
        this.lastBlock = number;
      }
    } catch (e) {
      console.warn('[bnb-lean]', e.message);
    } finally {
      this.running = false;
    }
  }

  async start() {
    if (!this.enabled) return false;
    if (!this.wallets.length) {
      console.warn('[bnb-lean] no wallets configured');
      return false;
    }
    console.log(`SUMMECA BNB CHAIN: wallet transaction scanner wallets=${this.wallets.length}`);
    await this.cycle();
    setInterval(() => void this.cycle(), 4_000).unref?.();
    return true;
  }
}

let singleton = null;
export async function startBnbLeanWorker() {
  if (!singleton) singleton = new BnbLeanWorker();
  await singleton.start();
  return singleton;
}
