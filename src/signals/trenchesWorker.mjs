import { env } from '../config/env.mjs';
import { telegramApi } from '../notifiers/telegram.mjs';

const EVM_ADDRESS = /^0x[0-9a-fA-F]{40}$/;
const DEX_API = 'https://api.dexscreener.com/latest/dex/tokens';
const GOPLUS = 'https://api.gopluslabs.io/api/v1/token_security';
const CHAIN_IDS = new Map([
  ['ethereum', '1'],
  ['eth', '1'],
  ['bsc', '56'],
  ['bnb', '56'],
  ['base', '8453'],
  ['monad', '143'],
  ['robinhood', '4663'],
  ['robinhoodchain', '4663'],
  ['arc', '5042']
]);

const finite = (value, fallback = 0) => {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
};

const clamp = (value, min, max) => Math.max(min, Math.min(max, value));
const lower = (value) => String(value ?? '').trim().toLowerCase();

function decodeHtml(value) {
  return String(value ?? '')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/&#x2F;/gi, '/')
    .replace(/&#x3D;/gi, '=')
    .replace(/&#x27;/gi, "'")
    .replace(/&#(\d+);/g, (_, code) => String.fromCharCode(Number(code)));
}

function textOnly(html) {
  return decodeHtml(String(html ?? ''))
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function parseCompactNumber(value) {
  const raw = String(value ?? '').trim().replace(/[,~$]/g, '').replace(/^\+/, '');
  if (!raw || raw === '—' || raw === '-') return 0;
  const match = raw.match(/(-?\d+(?:\.\d+)?)\s*([KMBT])?/i);
  if (!match) return 0;
  const n = Number(match[1]);
  const suffix = String(match[2] ?? '').toUpperCase();
  const multiplier = suffix === 'T' ? 1e12 : suffix === 'B' ? 1e9 : suffix === 'M' ? 1e6 : suffix === 'K' ? 1e3 : 1;
  return Number.isFinite(n) ? n * multiplier : 0;
}

function parsePercent(value) {
  const match = String(value ?? '').replace(/,/g, '').match(/[-+]?\d+(?:\.\d+)?/);
  return match ? Number(match[0]) : 0;
}

function extractCells(rowHtml) {
  return [...String(rowHtml ?? '').matchAll(/<t[dh]\b[^>]*>([\s\S]*?)<\/t[dh]>/gi)]
    .map((match) => textOnly(match[1]));
}

function extractDexReference(rowHtml) {
  const html = decodeHtml(rowHtml);
  const match = html.match(/https?:\/\/dexscreener\.com\/([^/"'\s?#]+)\/(0x[0-9a-fA-F]{40})/i);
  if (!match) return null;
  return {
    chain: lower(match[1]),
    address: match[2].toLowerCase(),
    url: `https://dexscreener.com/${match[1]}/${match[2]}`
  };
}

function addressFromCells(cells) {
  for (const value of [...cells].reverse()) {
    const match = String(value ?? '').match(/0x[0-9a-fA-F]{40}/);
    if (match) return match[0].toLowerCase();
  }
  return '';
}

function normalizeTableCluster(rowHtml, sourceUrl) {
  const cells = extractCells(rowHtml);
  if (cells.length < 10) return null;
  const dex = extractDexReference(rowHtml);
  const address = dex?.address || addressFromCells(cells);
  if (!EVM_ADDRESS.test(address)) return null;

  // CircleTrenches-style aggregate table:
  // TOKEN | WALLETS THAT BOUGHT | STILL HOLDING | SPENT | TOOK OUT |
  // NET INTO IT | FIRST IN | PRICE SINCE FIRST BUY | 24H | MCAP |
  // POOL LIQUIDITY | DEX | CA
  const walletsBought = Math.max(0, Math.round(parseCompactNumber(cells[1])));
  const stillHolding = Math.max(0, Math.round(parseCompactNumber(cells[2])));
  const netInflowUsd = parseCompactNumber(cells[5]);
  if (walletsBought <= 0 || !Number.isFinite(netInflowUsd)) return null;

  return {
    sourceUrl,
    source: 'circletrenches',
    chain: dex?.chain || 'unknown',
    address,
    symbol: cells[0] || 'TOKEN',
    walletsBought,
    stillHolding,
    spentUsd: parseCompactNumber(cells[3]),
    tookOutUsd: parseCompactNumber(cells[4]),
    netInflowUsd,
    firstIn: cells[6] || '',
    priceSinceFirstBuyPct: parsePercent(cells[7]),
    price24hPct: parsePercent(cells[8]),
    marketCapUsd: parseCompactNumber(cells[9]),
    liquidityUsd: parseCompactNumber(cells[10]),
    dexUrl: dex?.url || '',
    observedAt: Date.now()
  };
}

function firstField(object, names, fallback = undefined) {
  for (const name of names) {
    const value = object?.[name];
    if (value !== undefined && value !== null) return value;
  }
  return fallback;
}

function normalizeEmbeddedObject(object, sourceUrl) {
  if (!object || typeof object !== 'object' || Array.isArray(object)) return null;
  const address = String(firstField(object, ['address', 'tokenAddress', 'token_address', 'contractAddress', 'contract_address', 'ca'], '')).trim().toLowerCase();
  if (!EVM_ADDRESS.test(address)) return null;

  const walletsBought = Math.round(parseCompactNumber(firstField(object, ['walletsBought', 'wallets_bought', 'walletCount', 'wallet_count', 'buyers', 'smartWallets'], 0)));
  const stillHolding = Math.round(parseCompactNumber(firstField(object, ['stillHolding', 'still_holding', 'holders', 'holdingWallets', 'holding_wallets'], 0)));
  const netInflowUsd = parseCompactNumber(firstField(object, ['netInflowUsd', 'net_inflow_usd', 'netIntoIt', 'net_into_it', 'netFlowUsd', 'net_flow_usd'], 0));
  if (walletsBought <= 0 || netInflowUsd === 0) return null;

  const chain = lower(firstField(object, ['chain', 'network', 'chainId', 'networkId'], 'unknown'));
  return {
    sourceUrl,
    source: 'circletrenches-embedded',
    chain,
    address,
    symbol: String(firstField(object, ['symbol', 'ticker', 'tokenSymbol', 'token_symbol', 'name'], 'TOKEN')).trim() || 'TOKEN',
    walletsBought,
    stillHolding,
    spentUsd: parseCompactNumber(firstField(object, ['spentUsd', 'spent_usd', 'spent'], 0)),
    tookOutUsd: parseCompactNumber(firstField(object, ['tookOutUsd', 'took_out_usd', 'tookOut', 'took_out'], 0)),
    netInflowUsd,
    firstIn: String(firstField(object, ['firstIn', 'first_in', 'firstBuyer', 'first_buyer'], '')),
    priceSinceFirstBuyPct: parsePercent(firstField(object, ['priceSinceFirstBuyPct', 'price_since_first_buy_pct', 'priceSinceFirstBuy', 'price_since_first_buy'], 0)),
    price24hPct: parsePercent(firstField(object, ['price24hPct', 'price_24h_pct', 'change24h', 'change_24h'], 0)),
    marketCapUsd: parseCompactNumber(firstField(object, ['marketCapUsd', 'market_cap_usd', 'marketCap', 'market_cap', 'mcap'], 0)),
    liquidityUsd: parseCompactNumber(firstField(object, ['liquidityUsd', 'liquidity_usd', 'liquidity', 'poolLiquidity'], 0)),
    dexUrl: String(firstField(object, ['dexUrl', 'dex_url', 'dexscreener'], '')),
    observedAt: Date.now()
  };
}

function embeddedJsonClusters(html, sourceUrl) {
  const out = [];
  const scripts = [...String(html ?? '').matchAll(/<script\b[^>]*type=["']application\/json["'][^>]*>([\s\S]*?)<\/script>/gi)];
  const seenObjects = new Set();
  const visit = (value, depth = 0) => {
    if (depth > 14 || value == null) return;
    if (Array.isArray(value)) {
      for (const item of value.slice(0, 500)) visit(item, depth + 1);
      return;
    }
    if (typeof value !== 'object') return;
    if (seenObjects.has(value)) return;
    seenObjects.add(value);
    const normalized = normalizeEmbeddedObject(value, sourceUrl);
    if (normalized) out.push(normalized);
    for (const child of Object.values(value).slice(0, 200)) visit(child, depth + 1);
  };

  for (const script of scripts) {
    try { visit(JSON.parse(decodeHtml(script[1]))); } catch {}
  }
  return out;
}

export function parseTrenchesHtml(html, sourceUrl = 'https://circletrenches.com/') {
  const clusters = [];
  for (const match of String(html ?? '').matchAll(/<tr\b[^>]*>([\s\S]*?)<\/tr>/gi)) {
    const normalized = normalizeTableCluster(match[0], sourceUrl);
    if (normalized) clusters.push(normalized);
  }
  clusters.push(...embeddedJsonClusters(html, sourceUrl));

  const deduped = new Map();
  for (const cluster of clusters) {
    const key = `${lower(cluster.chain)}:${lower(cluster.address)}`;
    const existing = deduped.get(key);
    if (!existing || cluster.walletsBought > existing.walletsBought || cluster.netInflowUsd > existing.netInflowUsd) {
      deduped.set(key, cluster);
    }
  }
  return [...deduped.values()];
}

async function fetchText(url, timeoutMs = 8_000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, {
      signal: controller.signal,
      headers: {
        accept: 'text/html,application/xhtml+xml',
        'user-agent': 'SUMMECA-Trenches-Radar/1.0 (+https://summeca.com)'
      }
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return await response.text();
  } finally {
    clearTimeout(timer);
  }
}

async function fetchDexSnapshot(cluster) {
  const response = await fetch(`${DEX_API}/${encodeURIComponent(cluster.address)}`, {
    headers: { accept: 'application/json' }
  });
  if (!response.ok) throw new Error(`DexScreener HTTP ${response.status}`);
  const payload = await response.json();
  const pairs = Array.isArray(payload?.pairs) ? payload.pairs : [];
  const chain = lower(cluster.chain);
  const candidates = pairs.filter((pair) => {
    if (!chain || chain === 'unknown') return true;
    const pairChain = lower(pair?.chainId);
    return pairChain === chain || pairChain.includes(chain) || chain.includes(pairChain);
  });
  const pair = (candidates.length ? candidates : pairs)
    .sort((a, b) => finite(b?.liquidity?.usd) - finite(a?.liquidity?.usd))[0];
  if (!pair) return cluster;
  const token = lower(pair?.baseToken?.address) === lower(cluster.address) ? pair.baseToken : pair.quoteToken;
  return {
    ...cluster,
    chain: lower(pair.chainId) || cluster.chain,
    symbol: token?.symbol || cluster.symbol,
    name: token?.name || cluster.symbol,
    priceUsd: finite(pair?.priceUsd),
    marketCapUsd: finite(pair?.marketCap, finite(pair?.fdv, cluster.marketCapUsd)),
    liquidityUsd: finite(pair?.liquidity?.usd, cluster.liquidityUsd),
    volume5mUsd: finite(pair?.volume?.m5),
    buys5m: finite(pair?.txns?.m5?.buys),
    sells5m: finite(pair?.txns?.m5?.sells),
    priceChange5mPct: finite(pair?.priceChange?.m5),
    price24hPct: finite(pair?.priceChange?.h24, cluster.price24hPct),
    dexUrl: pair?.url || cluster.dexUrl,
    dexPairAddress: pair?.pairAddress || '',
    observedAt: Date.now()
  };
}

async function goPlusSafety(cluster) {
  const chainId = CHAIN_IDS.get(lower(cluster.chain));
  if (!chainId) return { verified: false, blocked: false, reasons: ['security-provider-chain-unsupported'] };
  const params = new URLSearchParams({ contract_addresses: cluster.address });
  const response = await fetch(`${GOPLUS}/${chainId}?${params}`, { headers: { accept: 'application/json' } });
  if (!response.ok) throw new Error(`GoPlus HTTP ${response.status}`);
  const payload = await response.json();
  const data = payload?.result?.[lower(cluster.address)] ?? payload?.result?.[cluster.address] ?? null;
  if (!data) return { verified: false, blocked: false, reasons: ['security-data-unavailable'] };

  const reasons = [];
  const flag = (name) => String(data?.[name] ?? '') === '1';
  if (flag('is_honeypot')) reasons.push('honeypot');
  if (flag('cannot_sell_all')) reasons.push('cannot-sell-all');
  if (flag('is_blacklisted')) reasons.push('blacklist-risk');
  if (flag('hidden_owner')) reasons.push('hidden-owner');
  if (flag('selfdestruct')) reasons.push('selfdestruct-enabled');
  const buyTax = finite(data?.buy_tax);
  const sellTax = finite(data?.sell_tax);
  if (buyTax > 0.2) reasons.push(`buy-tax-${Math.round(buyTax * 100)}pct`);
  if (sellTax > 0.2) reasons.push(`sell-tax-${Math.round(sellTax * 100)}pct`);
  return { verified: true, blocked: reasons.length > 0, reasons, buyTax, sellTax };
}

function trenchesScore(cluster, safety) {
  const holdingRatio = cluster.walletsBought > 0 ? clamp(cluster.stillHolding / cluster.walletsBought, 0, 1.5) : 0;
  const walletScore = Math.min(28, cluster.walletsBought * 4);
  const holdingScore = Math.min(22, holdingRatio * 22);
  const flowScore = Math.min(24, Math.log10(Math.max(1, cluster.netInflowUsd)) * 5);
  const liquidityScore = Math.min(14, Math.log10(Math.max(1, cluster.liquidityUsd)) * 2.8);
  const earlyScore = cluster.priceSinceFirstBuyPct <= 10 ? 12 : cluster.priceSinceFirstBuyPct <= 25 ? 8 : 4;
  const safetyPenalty = safety.blocked ? 100 : safety.verified ? 0 : 5;
  return clamp(Math.round(walletScore + holdingScore + flowScore + liquidityScore + earlyScore - safetyPenalty), 0, 100);
}

function eligible(cluster) {
  if (!EVM_ADDRESS.test(cluster.address)) return false;
  if (cluster.walletsBought < env.trenchesMinWallets) return false;
  if (cluster.stillHolding < env.trenchesMinStillHolding) return false;
  if (cluster.netInflowUsd < env.trenchesMinNetInflowUsd) return false;
  if (env.trenchesMaxMarketCapUsd > 0 && cluster.marketCapUsd > env.trenchesMaxMarketCapUsd) return false;
  if (cluster.liquidityUsd < env.trenchesMinLiquidityUsd) return false;
  if (cluster.priceSinceFirstBuyPct > env.trenchesMaxPriceSinceFirstBuyPct) return false;
  return true;
}

class TrenchesStore {
  constructor(url, key) {
    this.url = String(url ?? '').replace(/\/$/, '');
    this.key = String(key ?? '');
  }

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

  async save(cluster, score, safety) {
    if (!this.enabled) return null;
    const tokenRows = await this.request('tokens?on_conflict=address', {
      method: 'POST',
      prefer: 'resolution=merge-duplicates,return=representation',
      body: {
        chain: cluster.chain || 'evm',
        address: cluster.address,
        symbol: cluster.symbol ?? null,
        name: cluster.name ?? cluster.symbol ?? null,
        source: 'circletrenches',
        listed_at: null,
        last_seen_at: new Date().toISOString(),
        initial_price_usd: finite(cluster.priceUsd) || null,
        initial_liquidity_usd: finite(cluster.liquidityUsd) || null,
        highest_price_usd: finite(cluster.priceUsd) || null,
        status: 'tracking'
      }
    });
    const token = Array.isArray(tokenRows) ? tokenRows[0] : null;
    if (!token?.id) return null;

    const signalRows = await this.request('signals', {
      method: 'POST',
      prefer: 'return=representation',
      body: {
        token_id: token.id,
        signal_type: 'entry',
        entry_score: score,
        moon_score: Math.min(100, score + Math.min(10, Math.max(0, cluster.walletsBought - 2) * 2)),
        risk_score: safety.verified ? 20 : 30,
        reason: {
          trigger: 'trenches-cluster',
          origin: 'circletrenches-primary',
          source_url: cluster.sourceUrl,
          chain: cluster.chain,
          wallets_bought: cluster.walletsBought,
          still_holding: cluster.stillHolding,
          spent_usd: cluster.spentUsd,
          took_out_usd: cluster.tookOutUsd,
          net_inflow_usd: cluster.netInflowUsd,
          first_in: cluster.firstIn,
          price_since_first_buy_pct: cluster.priceSinceFirstBuyPct,
          market_cap_usd: cluster.marketCapUsd,
          liquidity_usd: cluster.liquidityUsd,
          security_verified: safety.verified,
          security_reasons: safety.reasons
        }
      }
    });
    return Array.isArray(signalRows) ? signalRows[0] ?? null : null;
  }
}

function money(value) {
  const n = finite(value);
  if (Math.abs(n) >= 1e9) return `${(n / 1e9).toFixed(2)}B`;
  if (Math.abs(n) >= 1e6) return `${(n / 1e6).toFixed(2)}M`;
  if (Math.abs(n) >= 1e3) return `${(n / 1e3).toFixed(1)}K`;
  return n.toFixed(n >= 100 ? 0 : 2);
}

export class TrenchesWorker {
  constructor() {
    this.store = new TrenchesStore(env.supabaseUrl, env.supabaseSecretKey);
    this.running = false;
    this.timer = null;
    this.emitted = new Map();
    this.chatId = '';
    this.language = env.telegramLanguage;
    this.emptyCycles = 0;
  }

  async notify(cluster, score, safety) {
    if (!env.telegramBotToken) return;
    if (!this.chatId) this.chatId = await this.store.chatId().catch(() => '');
    if (!this.chatId) return;
    this.language = await this.store.language().catch(() => env.telegramLanguage);

    const securityAr = safety.verified ? '✅ فحص العقد: ناجح' : '⚠️ فحص العقد غير متاح لهذه الشبكة — تنبيه فقط';
    const securityEn = safety.verified ? '✅ Contract safety: passed' : '⚠️ Contract safety unavailable on this chain — alert only';
    const ar = [
      '🧠🔥 SUMMECA TRENCHES — SMART MONEY',
      '',
      `$${cluster.symbol ?? 'TOKEN'} • ${String(cluster.chain || 'EVM').toUpperCase()}`,
      `👥 محافظ اشترت: ${cluster.walletsBought} | ما زالت محتفظة: ${cluster.stillHolding}`,
      `💰 صافي التدفق: +$${money(cluster.netInflowUsd)} | إجمالي الشراء: $${money(cluster.spentUsd)}`,
      cluster.firstIn ? `🥇 أول دخول: ${cluster.firstIn}` : '',
      `📈 منذ أول شراء: ${cluster.priceSinceFirstBuyPct >= 0 ? '+' : ''}${cluster.priceSinceFirstBuyPct.toFixed(1)}%`,
      `MC: $${money(cluster.marketCapUsd)} | 💧 السيولة: $${money(cluster.liquidityUsd)}`,
      finite(cluster.priceUsd) > 0 ? `السعر: $${cluster.priceUsd}` : '',
      `🎯 Trenches Score: ${score}/100`,
      securityAr,
      '',
      '🔒 المصدر الوحيد للإشارة: CircleTrenches / بيانات المحافظ العامة.',
      '🧪 التداول الحقيقي متوقف؛ الإشارة للمراقبة والاختبار.',
      `CA: ${cluster.address}`,
      cluster.dexUrl ? `DEX: ${cluster.dexUrl}` : ''
    ].filter(Boolean).join('\n');
    const en = [
      '🧠🔥 SUMMECA TRENCHES — SMART MONEY',
      '',
      `$${cluster.symbol ?? 'TOKEN'} • ${String(cluster.chain || 'EVM').toUpperCase()}`,
      `👥 Wallets bought: ${cluster.walletsBought} | Still holding: ${cluster.stillHolding}`,
      `💰 Net inflow: +$${money(cluster.netInflowUsd)} | Total spent: $${money(cluster.spentUsd)}`,
      cluster.firstIn ? `🥇 First in: ${cluster.firstIn}` : '',
      `📈 Since first buy: ${cluster.priceSinceFirstBuyPct >= 0 ? '+' : ''}${cluster.priceSinceFirstBuyPct.toFixed(1)}%`,
      `MC: $${money(cluster.marketCapUsd)} | 💧 Liquidity: $${money(cluster.liquidityUsd)}`,
      finite(cluster.priceUsd) > 0 ? `Price: $${cluster.priceUsd}` : '',
      `🎯 Trenches Score: ${score}/100`,
      securityEn,
      '',
      '🔒 Sole signal source: CircleTrenches / public wallet activity.',
      '🧪 Live trading is disabled; monitoring/testing only.',
      `CA: ${cluster.address}`,
      cluster.dexUrl ? `DEX: ${cluster.dexUrl}` : ''
    ].filter(Boolean).join('\n');
    const text = this.language === 'en' ? en : this.language === 'bilingual' ? `${ar}\n\n────────────\n\n${en}` : ar;
    await telegramApi(env.telegramBotToken, 'sendMessage', { chat_id: this.chatId, text });
  }

  async process(cluster) {
    let enriched = cluster;
    try { enriched = await fetchDexSnapshot(cluster); }
    catch (error) { console.warn('[trenches:dex]', cluster.address, error.message); }
    if (!eligible(enriched)) return;

    let safety = { verified: false, blocked: false, reasons: ['security-not-checked'] };
    try { safety = await goPlusSafety(enriched); }
    catch (error) { console.warn('[trenches:safety]', enriched.address, error.message); }
    if (safety.blocked) {
      console.warn(`[trenches:blocked] ${enriched.address} ${safety.reasons.join(',')}`);
      return;
    }

    const key = `${lower(enriched.chain)}:${lower(enriched.address)}`;
    const last = this.emitted.get(key) ?? 0;
    if (Date.now() - last < env.trenchesSignalCooldownMs) return;

    const score = trenchesScore(enriched, safety);
    if (score < 60) return;
    this.emitted.set(key, Date.now());

    await this.store.save(enriched, score, safety).catch((error) => console.error('[trenches:supabase]', error.message));
    await this.notify(enriched, score, safety).catch((error) => console.error('[trenches:telegram]', error.message));
    console.log(`[trenches:signal] chain=${enriched.chain} token=${enriched.symbol} wallets=${enriched.walletsBought} holding=${enriched.stillHolding} net=$${Math.round(enriched.netInflowUsd)} score=${score}`);
  }

  async cycle() {
    if (this.running) return;
    this.running = true;
    try {
      const html = await fetchText(env.trenchesPrimaryUrl);
      const clusters = parseTrenchesHtml(html, env.trenchesPrimaryUrl);
      if (!clusters.length) {
        this.emptyCycles += 1;
        if (this.emptyCycles === 1 || this.emptyCycles % 30 === 0) {
          console.warn(`[trenches] source connected but no aggregate token rows were present in the server response (emptyCycles=${this.emptyCycles})`);
        }
        return;
      }
      this.emptyCycles = 0;
      const ordered = clusters
        .filter((item) => item.netInflowUsd > 0)
        .sort((a, b) => (b.walletsBought - a.walletsBought) || (b.netInflowUsd - a.netInflowUsd))
        .slice(0, 25);
      console.log(`[trenches] parsed=${clusters.length} candidates=${ordered.length} source=${env.trenchesPrimaryUrl}`);
      for (const cluster of ordered) await this.process(cluster);
    } catch (error) {
      console.error('[trenches:cycle]', error.message);
    } finally {
      this.running = false;
    }
  }

  async start() {
    if (!env.trenchesEnabled) {
      console.log('SUMMECA TRENCHES: disabled');
      return false;
    }
    if (!env.telegramBotToken || !this.store.enabled) {
      console.log('SUMMECA TRENCHES: skipped — Telegram or Supabase configuration missing');
      return false;
    }
    this.chatId = await this.store.chatId().catch(() => '');
    this.language = await this.store.language().catch(() => env.telegramLanguage);
    console.log(`SUMMECA TRENCHES: PRIMARY source=${env.trenchesPrimaryUrl} wallets>=${env.trenchesMinWallets} holding>=${env.trenchesMinStillHolding} net>=${env.trenchesMinNetInflowUsd}`);
    await this.cycle();
    this.timer = setInterval(() => void this.cycle(), env.trenchesPollMs);
    this.timer.unref?.();
    return true;
  }
}

let singleton = null;
export async function startTrenchesWorker() {
  if (!singleton) singleton = new TrenchesWorker();
  await singleton.start();
  return singleton;
}
