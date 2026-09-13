import crypto from 'node:crypto';

const PRIVY_API = 'https://api.privy.io';
const SOLANA_MAINNET_CAIP2 = 'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp';

function canonicalize(value) {
  if (value === null || typeof value !== 'object') {
    if (typeof value === 'number' && !Number.isFinite(value)) throw new Error('Cannot canonicalize non-finite number');
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonicalize).join(',')}]`;
  const keys = Object.keys(value).sort();
  return `{${keys.map((key) => `${JSON.stringify(key)}:${canonicalize(value[key])}`).join(',')}}`;
}

function authorizationKeyObject(value) {
  let key = String(value ?? '').trim();
  if (!key) return null;
  if (key.startsWith('wallet-auth:')) key = key.slice('wallet-auth:'.length);
  if (key.startsWith('wallet-api:')) key = key.slice('wallet-api:'.length);
  if (key.includes('BEGIN PRIVATE KEY')) return crypto.createPrivateKey(key);

  const der = Buffer.from(key, 'base64');
  if (!der.length) throw new Error('Invalid Privy authorization private key');
  return crypto.createPrivateKey({ key: der, format: 'der', type: 'pkcs8' });
}

function authorizationSignature({ url, method, body, appId, authorizationPrivateKey, expiry }) {
  const key = authorizationKeyObject(authorizationPrivateKey);
  if (!key) return '';
  const headers = {
    'privy-app-id': appId,
    'privy-request-expiry': String(expiry)
  };
  const payload = canonicalize({ version: 1, method, url, body, headers });
  return crypto.sign('sha256', Buffer.from(payload), { key, dsaEncoding: 'der' }).toString('base64');
}

export class PrivySolanaWallet {
  constructor({ appId, appSecret, walletId, walletAddress, authorizationPrivateKey = '' }) {
    this.appId = String(appId ?? '').trim();
    this.appSecret = String(appSecret ?? '').trim();
    this.walletId = String(walletId ?? '').trim();
    this.walletAddress = String(walletAddress ?? '').trim();
    this.authorizationPrivateKey = String(authorizationPrivateKey ?? '').trim();
  }

  get configured() {
    return Boolean(this.appId && this.appSecret && this.walletId && this.walletAddress);
  }

  async signAndSendTransaction(transaction, { referenceId } = {}) {
    if (!this.configured) throw new Error('Privy wallet is not fully configured');
    const serialized = String(transaction ?? '').trim();
    if (!serialized) throw new Error('Serialized Solana transaction is required');

    const url = `${PRIVY_API}/v1/wallets/${encodeURIComponent(this.walletId)}/rpc`;
    const body = {
      method: 'signAndSendTransaction',
      caip2: SOLANA_MAINNET_CAIP2,
      params: { transaction: serialized, encoding: 'base64' },
      ...(referenceId ? { reference_id: String(referenceId).slice(0, 64) } : {})
    };
    const expiry = Date.now() + 30_000;
    const signature = authorizationSignature({
      url,
      method: 'POST',
      body,
      appId: this.appId,
      authorizationPrivateKey: this.authorizationPrivateKey,
      expiry
    });

    const response = await fetch(url, {
      method: 'POST',
      headers: {
        Authorization: `Basic ${Buffer.from(`${this.appId}:${this.appSecret}`).toString('base64')}`,
        'content-type': 'application/json',
        'privy-app-id': this.appId,
        'privy-request-expiry': String(expiry),
        ...(signature ? { 'privy-authorization-signature': signature } : {})
      },
      body: JSON.stringify(body)
    });
    const payload = await response.json().catch(() => null);
    if (!response.ok) {
      const message = payload?.message ?? payload?.error ?? `HTTP ${response.status}`;
      throw new Error(`Privy sign/send failed: ${message}`);
    }
    const hash = payload?.data?.hash ?? payload?.hash;
    if (!hash) throw new Error('Privy sign/send returned no transaction hash');
    return {
      hash: String(hash),
      transactionId: payload?.data?.transaction_id ?? payload?.transaction_id ?? null,
      referenceId: payload?.data?.reference_id ?? referenceId ?? null
    };
  }
}
