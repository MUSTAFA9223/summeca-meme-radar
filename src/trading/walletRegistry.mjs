import crypto from 'node:crypto';
import { env } from '../config/env.mjs';
import { AppSettings } from '../storage/appSettings.mjs';
import { PrivySolanaWallet } from './privyWallet.mjs';

const PRIVY_API = 'https://api.privy.io';
const WALLETS_KEY = 'telegram_trading_wallets_v1';
const ACTIVE_KEY = 'telegram_active_trading_wallet_v1';
const SOLANA = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
const settings = new AppSettings(env.supabaseUrl, env.supabaseSecretKey);

function parseRows(value) {
  try {
    const rows = JSON.parse(String(value || '[]'));
    return Array.isArray(rows) ? rows : [];
  } catch {
    return [];
  }
}

function defaultWallet() {
  if (!env.privyWalletId || !SOLANA.test(String(env.privyWalletAddress || ''))) return null;
  return {
    id: String(env.privyWalletId),
    address: String(env.privyWalletAddress),
    label: 'SUMMECA Primary',
    source: 'env',
    createdAt: null
  };
}

async function storedWallets() {
  if (!settings.enabled) return [];
  return parseRows(await settings.get(WALLETS_KEY).catch(() => '[]'))
    .filter((row) => row?.id && SOLANA.test(String(row?.address || '')))
    .map((row) => ({
      id: String(row.id),
      address: String(row.address),
      label: String(row.label || 'SUMMECA Wallet').slice(0, 80),
      source: 'privy',
      createdAt: row.createdAt || null
    }));
}

async function saveStoredWallets(rows) {
  if (!settings.enabled) throw new Error('App settings store is required for dynamic wallets');
  const safe = (Array.isArray(rows) ? rows : []).slice(0, 12).map((row) => ({
    id: String(row.id),
    address: String(row.address),
    label: String(row.label || 'SUMMECA Wallet').slice(0, 80),
    createdAt: row.createdAt || new Date().toISOString()
  }));
  await settings.set(WALLETS_KEY, JSON.stringify(safe));
  return safe;
}

export async function listTradingWallets() {
  const rows = await storedWallets();
  const primary = defaultWallet();
  const merged = primary ? [primary, ...rows.filter((row) => row.id !== primary.id)] : rows;
  return merged.slice(0, 12);
}

export async function getActiveTradingWallet() {
  const wallets = await listTradingWallets();
  if (!wallets.length) return null;
  const activeId = settings.enabled ? String(await settings.get(ACTIVE_KEY).catch(() => '') || '') : '';
  return wallets.find((row) => row.id === activeId) || wallets[0];
}

export async function setActiveTradingWallet(walletId) {
  const wallets = await listTradingWallets();
  const wallet = wallets.find((row) => row.id === String(walletId || ''));
  if (!wallet) throw new Error('Trading wallet was not found');
  if (!settings.enabled) {
    if (wallet.source !== 'env') throw new Error('App settings store is required for dynamic wallets');
    return wallet;
  }
  await settings.set(ACTIVE_KEY, wallet.id);
  return wallet;
}

export async function createPrivyTradingWallet({ label = 'SUMMECA Trading Wallet' } = {}) {
  if (!env.privyAppId || !env.privyAppSecret) throw new Error('Privy app credentials are not configured');
  if (!settings.enabled) throw new Error('App settings store is required before creating a wallet');

  const externalId = `summeca_bot_${crypto.randomUUID().replaceAll('-', '').slice(0, 28)}`;
  const response = await fetch(`${PRIVY_API}/v1/wallets`, {
    method: 'POST',
    headers: {
      Authorization: `Basic ${Buffer.from(`${env.privyAppId}:${env.privyAppSecret}`).toString('base64')}`,
      'privy-app-id': env.privyAppId,
      'content-type': 'application/json',
      accept: 'application/json'
    },
    body: JSON.stringify({
      chain_type: 'solana',
      external_id: externalId,
      display_name: String(label || 'SUMMECA Trading Wallet').slice(0, 100)
    })
  });
  const payload = await response.json().catch(() => null);
  if (!response.ok) {
    const message = payload?.message ?? payload?.error ?? payload?.detail ?? `HTTP ${response.status}`;
    throw new Error(`Privy wallet create failed: ${message}`);
  }

  const wallet = payload?.wallet || payload;
  const id = String(wallet?.id || '');
  const address = String(wallet?.address || '');
  if (!id || !SOLANA.test(address)) throw new Error('Privy returned an invalid Solana wallet');

  const rows = await storedWallets();
  const record = {
    id,
    address,
    label: String(label || `SUMMECA Wallet ${rows.length + 2}`).slice(0, 80),
    source: 'privy',
    createdAt: new Date().toISOString()
  };
  rows.push(record);
  await saveStoredWallets(rows);
  await settings.set(ACTIVE_KEY, id);
  return record;
}

export function privyClientForTradingWallet(wallet) {
  const row = wallet || defaultWallet();
  return new PrivySolanaWallet({
    appId: env.privyAppId,
    appSecret: env.privyAppSecret,
    walletId: row?.id || '',
    walletAddress: row?.address || '',
    authorizationPrivateKey: env.privyAuthorizationPrivateKey
  });
}

export function walletFromAuditPayload(payload = {}) {
  const id = String(payload?.walletId || '');
  const address = String(payload?.walletAddress || '');
  if (!id || !SOLANA.test(address)) return null;
  return {
    id,
    address,
    label: String(payload?.walletLabel || 'SUMMECA Trading Wallet'),
    source: 'audit'
  };
}
