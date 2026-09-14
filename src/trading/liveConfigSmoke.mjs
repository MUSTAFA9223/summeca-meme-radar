import crypto from 'node:crypto';

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

export async function runLiveConfigSmoke(env) {
  const required = {
    PRIVY_APP_ID: env.privyAppId,
    PRIVY_APP_SECRET: env.privyAppSecret,
    PRIVY_WALLET_ID: env.privyWalletId,
    PRIVY_WALLET_ADDRESS: env.privyWalletAddress,
    PRIVY_AUTHORIZATION_PRIVATE_KEY: env.privyAuthorizationPrivateKey,
    JUPITER_API_KEY: env.jupiterApiKey,
    HELIUS_API_KEY: env.heliusApiKey
  };
  const missing = Object.entries(required)
    .filter(([, value]) => !String(value ?? '').trim())
    .map(([name]) => name);
  if (missing.length) throw new Error(`Missing required variables: ${missing.join(', ')}`);
  if (env.liveTradingEnabled) throw new Error('Safety stop: LIVE_TRADING_ENABLED must be false for read-only smoke');

  const appId = String(env.privyAppId).trim();
  const appSecret = String(env.privyAppSecret).trim();
  const walletId = String(env.privyWalletId).trim();
  const walletAddress = String(env.privyWalletAddress).trim();
  const jupiterApiKey = String(env.jupiterApiKey).trim();
  const heliusApiKey = String(env.heliusApiKey).trim();

  console.log(JSON.stringify({ ok: true, check: 'safety-lock', liveTradingEnabled: false }));

  const auth = Buffer.from(`${appId}:${appSecret}`).toString('base64');
  const privy = await fetchJson(`https://api.privy.io/v1/wallets/${encodeURIComponent(walletId)}`, {
    headers: {
      Authorization: `Basic ${auth}`,
      'privy-app-id': appId,
      accept: 'application/json'
    }
  });
  if (!privy.response.ok) throw new Error(`Privy GET wallet HTTP ${privy.response.status}`);
  const wallet = privy.body;
  if (!wallet?.id || !wallet?.address) throw new Error('Privy wallet response missing id/address');
  if (String(wallet.id) !== walletId) throw new Error('Privy wallet ID does not match configured ID');
  if (String(wallet.address) !== walletAddress) throw new Error('Privy wallet address does not match configured address');
  if (String(wallet.chain_type).toLowerCase() !== 'solana') throw new Error(`Unexpected Privy chain_type: ${wallet.chain_type}`);
  if (!Array.isArray(wallet.policy_ids) || wallet.policy_ids.length < 1) throw new Error('Privy wallet has no policy attached');
  if (!Array.isArray(wallet.additional_signers) || wallet.additional_signers.length < 1) throw new Error('Privy wallet has no additional signer attached');
  if (!wallet.owner_id) throw new Error('Privy wallet has no owner configured');
  console.log(JSON.stringify({
    ok: true,
    check: 'privy-wallet',
    walletId: mask(wallet.id),
    address: mask(wallet.address),
    chain: wallet.chain_type,
    policies: wallet.policy_ids.length,
    additionalSigners: wallet.additional_signers.length,
    ownerConfigured: true
  }));

  const key = parseAuthorizationKey(env.privyAuthorizationPrivateKey);
  const publicKey = crypto.createPublicKey(key).export({ type: 'spki', format: 'der' });
  if (!publicKey?.length) throw new Error('Could not derive public key from authorization private key');
  console.log(JSON.stringify({ ok: true, check: 'privy-authorization-key', parsed: true }));

  const helius = await fetchJson(`https://mainnet.helius-rpc.com/?api-key=${encodeURIComponent(heliusApiKey)}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'getBalance', params: [walletAddress] })
  });
  if (!helius.response.ok) throw new Error(`Helius HTTP ${helius.response.status}`);
  if (helius.body?.error) throw new Error(`Helius RPC ${helius.body.error.code}: ${helius.body.error.message}`);
  const lamports = Number(helius.body?.result?.value);
  if (!Number.isFinite(lamports) || lamports < 0) throw new Error('Helius returned an invalid balance');
  console.log(JSON.stringify({ ok: true, check: 'helius-wallet-read', balanceSol: lamports / 1e9 }));

  const params = new URLSearchParams({
    inputMint: SOL_MINT,
    outputMint: USDC_MINT,
    amount: '1000000',
    taker: walletAddress
  });
  const jupiter = await fetchJson(`https://api.jup.ag/swap/v2/order?${params}`, {
    headers: { 'x-api-key': jupiterApiKey, accept: 'application/json' }
  });
  if (jupiter.response.status === 401 || jupiter.response.status === 403) {
    throw new Error(`Jupiter API key rejected with HTTP ${jupiter.response.status}`);
  }
  if (!jupiter.response.ok) {
    throw new Error(`Jupiter order build HTTP ${jupiter.response.status}: ${jupiter.body?.errorMessage ?? jupiter.body?.error ?? 'request failed'}`);
  }
  if (!jupiter.body?.requestId) throw new Error('Jupiter order response missing requestId');
  if (!jupiter.body?.transaction) throw new Error('Jupiter order response missing unsigned transaction');
  console.log(JSON.stringify({
    ok: true,
    check: 'jupiter-order-build',
    router: jupiter.body.router ?? null,
    mode: jupiter.body.mode ?? null,
    transactionBuilt: true,
    executed: false
  }));

  console.log(JSON.stringify({ ok: true, summary: 'READ_ONLY_LIVE_CONFIG_SMOKE_PASSED', signed: false, sent: false }));
  return true;
}
