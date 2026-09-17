import { env } from '../config/env.mjs';

const EVM = /^0x[0-9a-fA-F]{40}$/;
const finite = (value, fallback = 0) => Number.isFinite(Number(value)) ? Number(value) : fallback;
const low = (value) => String(value ?? '').trim().toLowerCase();

function walletsByLabel() {
  const map = new Map();
  for (const [index, entry] of String(process.env.TRENCHES_WALLETS || '').split(',').map((x) => x.trim()).filter(Boolean).entries()) {
    const [a, b] = entry.includes('|') ? entry.split('|', 2) : entry.includes('=') ? entry.split('=', 2) : [entry, ''];
    const address = EVM.test(a) ? low(a) : EVM.test(b) ? low(b) : '';
    const label = address === low(a) ? String(b || `wallet-${index + 1}`).trim() : String(a || `wallet-${index + 1}`).trim();
    if (address) map.set(label.toLowerCase(), { address, label });
  }
  return map;
}

const walletMap = walletsByLabel();

function detect(text) {
  const value = String(text || '');
  if (!/SUMMECA EARLY WATCH/i.test(value) || !/محفظة متتبعة:|tracked wallet:/i.test(value)) return null;
  const network = /BNB CHAIN/i.test(value) ? 'bsc' : /ROBINHOOD CHAIN/i.test(value) ? 'robinhood' : '';
  if (!network) return null;
  const ca = String(value.match(/(?:^|\n)CA:\s*(0x[0-9a-fA-F]{40})/i)?.[1] || '').toLowerCase();
  const label = String(value.match(/(?:محفظة متتبعة|tracked wallet):\s*([^\n]+)/i)?.[1] || '').trim();
  const wallet = walletMap.get(label.toLowerCase());
  if (!ca || !wallet) return null;
  return { network, ca, wallet };
}

async function market(network, address) {
  try {
    const response = await fetch(`https://api.dexscreener.com/tokens/v1/${encodeURIComponent(network)}/${encodeURIComponent(address)}`, { headers: { accept: 'application/json' } });
    if (!response.ok) return null;
    const rows = await response.json().catch(() => []);
    const pairs = (Array.isArray(rows) ? rows : []).filter((r) => low(r?.chainId) === network);
    const pair = pairs.sort((a, b) => finite(b?.liquidity?.usd) - finite(a?.liquidity?.usd))[0] || rows?.[0];
    if (!pair) return null;
    const base = low(pair?.baseToken?.address);
    const token = base === low(address) ? pair.baseToken : pair.quoteToken;
    return {
      symbol: token?.symbol || 'TOKEN', name: token?.name || token?.symbol || 'TOKEN',
      priceUsd: finite(pair?.priceUsd), liquidityUsd: finite(pair?.liquidity?.usd),
      marketCapUsd: finite(pair?.marketCap, finite(pair?.fdv)), buys5m: finite(pair?.txns?.m5?.buys),
      sells5m: finite(pair?.txns?.m5?.sells), priceChange5mPct: finite(pair?.priceChange?.m5)
    };
  } catch { return null; }
}

async function rest(path, { method = 'GET', body, prefer } = {}) {
  if (!env.supabaseUrl || !env.supabaseSecretKey) return null;
  const base = String(env.supabaseUrl).replace(/\/$/, '');
  const response = await fetch(`${base}/rest/v1/${path}`, {
    method,
    headers: {
      apikey: env.supabaseSecretKey, Authorization: `Bearer ${env.supabaseSecretKey}`, accept: 'application/json',
      ...(body !== undefined ? { 'content-type': 'application/json' } : {}), ...(prefer ? { Prefer: prefer } : {})
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {})
  });
  if (!response.ok) throw new Error(`Supabase ${method} ${path} HTTP ${response.status}`);
  const text = await response.text().catch(() => '');
  return text ? JSON.parse(text) : null;
}

async function persist(info) {
  try {
    const snap = await market(info.network, info.ca);
    if (!snap?.priceUsd) return;
    const tokenRows = await rest('tokens?on_conflict=address', {
      method: 'POST', prefer: 'resolution=merge-duplicates,return=representation',
      body: {
        chain: info.network, address: info.ca, symbol: snap.symbol, name: snap.name,
        source: `${info.network}-wallet-alert-recorder`, last_seen_at: new Date().toISOString(),
        initial_price_usd: snap.priceUsd, initial_liquidity_usd: snap.liquidityUsd,
        highest_price_usd: snap.priceUsd, status: 'tracking'
      }
    });
    const token = Array.isArray(tokenRows) ? tokenRows[0] : null;
    if (!token?.id) return;
    const ratio = snap.buys5m / Math.max(1, snap.sells5m);
    const entryScore = Math.max(0, Math.min(100, Math.round(45 + Math.min(20, ratio * 5) + Math.min(20, snap.liquidityUsd / 5000) - Math.max(0, snap.priceChange5mPct - 20) * 0.3)));
    await rest('signals', {
      method: 'POST', prefer: 'return=minimal',
      body: {
        token_id: token.id, signal_type: 'entry', entry_score: entryScore, risk_score: 25,
        reason: {
          trigger: `${info.network}-tracked-wallet-early-watch`, origin: 'telegram-smart-wallet-recorder',
          wallets: [{ address: info.wallet.address, label: info.wallet.label, paid_usd: 0 }],
          confirming_wallets: 1, market_cap_usd: snap.marketCapUsd, liquidity_usd: snap.liquidityUsd,
          buys_5m: snap.buys5m, sells_5m: snap.sells5m, payer_verified: true
        }
      }
    });
    console.log(`[wallet-signal-recorder] ${info.network} wallet=${info.wallet.label} token=${info.ca.slice(0, 8)}… saved`);
  } catch (error) {
    console.warn('[wallet-signal-recorder]', String(error?.message ?? error));
  }
}

let installed = false;
export function installSmartWalletSignalRecorder() {
  if (installed) return;
  installed = true;
  const previousFetch = globalThis.fetch.bind(globalThis);
  globalThis.fetch = async (input, init = {}) => {
    const url = typeof input === 'string' ? input : String(input?.url ?? input ?? '');
    const isTelegramSend = /https:\/\/api\.telegram\.org\/bot[^/]+\/sendMessage$/i.test(url);
    let info = null;
    if (isTelegramSend && typeof init?.body === 'string') {
      try { info = detect(JSON.parse(init.body)?.text); } catch {}
    }
    const response = await previousFetch(input, init);
    if (response.ok && info) setTimeout(() => void persist(info), 0).unref?.();
    return response;
  };
  console.log('SMART WALLET SIGNAL RECORDER: BNB + Robinhood wallet evidence persistence active');
}
