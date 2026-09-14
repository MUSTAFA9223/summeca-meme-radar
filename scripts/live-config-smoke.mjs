import crypto from 'node:crypto';

const required = [
  'PRIVY_APP_ID',
  'PRIVY_APP_SECRET',
  'PRIVY_WALLET_ID',
  'PRIVY_WALLET_ADDRESS',
  'PRIVY_AUTHORIZATION_PRIVATE_KEY',
  'JUPITER_API_KEY',
  'HELIUS_API_KEY'
];

const missing = required.filter((name) => !String(process.env[name] ?? '').trim());
if (missing.length) {
  console.error(`Missing required variables: ${missing.join(', ')}`);
  process.exit(1);
}

if (String(process.env.LIVE_TRADING_ENABLED ?? 'false').toLowerCase() === 'true') {
  console.error('Safety stop: set LIVE_TRADING_ENABLED=false before running this read-only smoke test.');
  process.exit(1);
}

const appId = String(process.env.PRIVY_APP_ID).trim();
const appSecret = String(process.env.PRIVY_APP_SECRET).trim();
const walletId = String(process.env.PRIVY_WALLET_ID).trim();
const walletAddress = String(process.env.PRIVY_WALLET_ADDRESS).trim();
const authorizationPrivateKey = String(process.env.PRIVY_AUTHORIZATION_PRIVATE_KEY).trim();
const jupiterApiKey = String(process.env.JUPITER_API_KEY).trim();
const heliusApiKey = String(process.env.HELIUS_API_KEY).trim();

const SOL_MINT = 'So11111111111111111111111111111111111111112';
const USDC_MINT = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';

const mask = (value, left = 6, right = 4) => {
  const text = String(value ?? '');
  if (text.length <= left + right) return '***';
  return `${text.slice(0, left)}…${text.slice(-right)}`;
};

function parseAuthorizationKey(value) {
  let key = String(value ?? '').trim();
  if (key.startsWith('wallet-auth:')) key = key.slice('wallet-auth:'.length);
  if (key.startsWith('wallet-api:')) key = key.slice('wallet-api:'.length);
  if (key.includes('BEGIN PRIVATE KEY')) return crypto.createPrivateKey(key);
  const der = Buffer.from(key, 'base64');
  if (!der.length) throw new Error('authorization key is not valid base64/PKCS8');
  return crypto.createPrivateKey({ key: der, format: 'der', type: 'pkcs8' });
}

async function fetchJson(url, options = {}, timeoutMs = 12_000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, { ...options, signal: controller.signal });
    const text = await response.text().catch(() => '');
    let body = null;
    try { body = text ? JSON.parse(text) : null; } catch { body = text; }
    return { response, body };
  } finally {
    clearTimeout(timer);
  }
}

async function checkPrivyWallet() {
  const auth = Buffer.from(`${appId}:${appSecret}`).toString('base64');
  const { response, body } = await fetchJson(`https://api.privy.io/v1/wallets/${encodeURIComponent(walletId)}`, {
    headers: {
      Authorization: `Basic ${auth}`,
      'privy-app-id': appId,
      accept: 'application/json'
    }
  });
  if (!response.ok) throw new Error(`Privy GET wallet HTTP ${response.status}`);
  if (!body?.id || !body?.address) throw new Error('Privy wallet response missing id/address');
  if (String(body.id) !== walletId) throw new Error('Privy wallet ID does not match PRIVY_WALLET_ID');
  if (String(body.address) !== walletAddress) throw new Error('Privy wallet address does not match PRIVY_WALLET_ADDRESS');
  if (String(body.chain_type).toLowerCase() !== 'solana') throw new Error(`Unexpected Privy chain_type: ${body.chain_type}`);
  if (!Array.isArray(body.policy_ids) || body.policy_ids.length < 1) throw new Error('Privy wallet has no policy attached');
  if (!Array.isArray(body.additional_signers) || body.additional_signers.length < 1) throw new Error('Privy wallet has no additional signer attached');
  if (!body.owner_id) throw new Error('Privy wallet has no owner configured');
  console.log(JSON.stringify({
    ok: true,
    check: 'privy-wallet',
    walletId: mask(body.id),
    address: mask(body.address),
    chain: body.chain_type,
    policies: body.policy_ids.length,
    additionalSigners: body.additional_signers.length,
    ownerConfigured: true
  }));
}

async function checkAuthorizationKey() {
  const key = parseAuthorizationKey(authorizationPrivateKey);
  const publicKey = crypto.createPublicKey(key).export({ type: 'spki', format: 'der' });
  if (!publicKey?.length) throw new Error('Could not derive public key from authorization private key');
  console.log(JSON.stringify({ ok: true, check: 'privy-authorization-key', parsed: true }));
}

async function checkHeliusBalance() {
  const endpoint = `https://mainnet.helius-rpc.com/?api-key=${encodeURIComponent(heliusApiKey)}`;
  const { response, body } = await fetchJson(endpoint, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'getBalance', params: [walletAddress] })
  });
  if (!response.ok) throw new Error(`Helius HTTP ${response.status}`);
  if (body?.error) throw new Error(`Helius RPC ${body.error.code}: ${body.error.message}`);
  const lamports = Number(body?.result?.value);
  if (!Number.isFinite(lamports) || lamports < 0) throw new Error('Helius returned an invalid balance');
  console.log(JSON.stringify({ ok: true, check: 'helius-wallet-read', balanceSol: lamports / 1e9 }));
}

async function checkJupiterQuoteOnly() {
  // Deliberately omit `taker`: Jupiter returns a quote without assembling a transaction.
  // This validates the API key + route while remaining read-only even when the wallet has 0 SOL.
  const params = new URLSearchParams({
    inputMint: SOL_MINT,
    outputMint: USDC_MINT,
    amount: '100000000'
  });
  const { response, body } = await fetchJson(`https://api.jup.ag/swap/v2/order?${params}`, {
    headers: { 'x-api-key': jupiterApiKey, accept: 'application/json' }
  });
  if (response.status === 401 || response.status === 403) throw new Error(`Jupiter API key rejected with HTTP ${response.status}`);
  if (!response.ok) throw new Error(`Jupiter quote HTTP ${response.status}: ${body?.errorMessage ?? body?.error ?? 'request failed'}`);
  if (!body?.requestId) throw new Error('Jupiter quote response missing requestId');
  if (!String(body?.outAmount ?? '').match(/^\d+$/) || BigInt(body.outAmount) <= 0n) {
    throw new Error(`Jupiter quote response missing a valid outAmount: ${body?.errorMessage ?? 'unknown response'}`);
  }
  console.log(JSON.stringify({
    ok: true,
    check: 'jupiter-quote-only',
    router: body.router ?? null,
    mode: body.mode ?? null,
    quoted: true,
    transactionBuilt: false,
    signed: false,
    executed: false
  }));
}

try {
  console.log(JSON.stringify({ ok: true, check: 'safety-lock', liveTradingEnabled: false }));
  await checkPrivyWallet();
  await checkAuthorizationKey();
  await checkHeliusBalance();
  await checkJupiterQuoteOnly();
  console.log(JSON.stringify({ ok: true, summary: 'READ_ONLY_LIVE_CONFIG_SMOKE_PASSED', signed: false, sent: false }));
} catch (error) {
  console.error(`Read-only live config smoke failed: ${error.message}`);
  process.exit(1);
}
