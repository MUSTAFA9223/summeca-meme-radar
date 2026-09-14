import test from 'node:test';
import assert from 'node:assert/strict';
import { evaluateSignalSafety } from '../src/core/safetyGate.mjs';

const safeSnapshot = {
  source: 'pump_fun_direct',
  priceUsd: 0.00001,
  liquidityUsd: 0,
  buys30s: 12,
  sells30s: 2,
  volume5mUsd: 5000,
  marketDataVerified: true,
  securityVerified: true,
  honeypot: false,
  mintAuthorityDisabled: true,
  freezeAuthorityDisabled: true,
  top10HolderPct: 22,
  creatorPct: 2
};

const safeScores = { risk: 20, blockers: [] };

test('fails closed when security is unverified', () => {
  const result = evaluateSignalSafety({ ...safeSnapshot, securityVerified: false }, safeScores);
  assert.equal(result.ok, false);
  assert.ok(result.reasons.includes('security not verified'));
  assert.equal(result.emergency, false);
});

test('allows verified active Pump.fun bonding-curve signal', () => {
  const result = evaluateSignalSafety(safeSnapshot, safeScores);
  assert.equal(result.ok, true);
  assert.equal(result.emergency, false);
});

test('allows missing dedicated honeypot field when authorities are proven safe and a sell is observed', () => {
  const result = evaluateSignalSafety({ ...safeSnapshot, honeypot: undefined }, safeScores);
  assert.equal(result.ok, true);
});

test('blocks a signal with no valid price', () => {
  const result = evaluateSignalSafety({ ...safeSnapshot, priceUsd: 0 }, safeScores);
  assert.equal(result.ok, false);
  assert.ok(result.reasons.includes('price unavailable'));
});

test('blocks automatic entry until a real sell has been observed', () => {
  const result = evaluateSignalSafety({ ...safeSnapshot, sells30s: 0 }, safeScores);
  assert.equal(result.ok, false);
  assert.ok(result.reasons.includes('no verified sell observed'));
});

test('fails closed when mint/freeze authority checks are not explicit', () => {
  const result = evaluateSignalSafety({
    ...safeSnapshot,
    honeypot: undefined,
    mintAuthorityDisabled: undefined,
    freezeAuthorityDisabled: undefined
  }, safeScores);
  assert.equal(result.ok, false);
  assert.ok(result.reasons.includes('mint authority not verified disabled'));
  assert.ok(result.reasons.includes('freeze authority not verified disabled'));
});

test('direct Solana mint-security failure cannot be overridden by provider metadata', () => {
  const result = evaluateSignalSafety({
    ...safeSnapshot,
    onchainSecurityVerified: false,
    securitySource: 'solana-rpc'
  }, safeScores);
  assert.equal(result.ok, false);
  assert.ok(result.reasons.includes('on-chain mint security not verified'));
});

test('blocks non-transferable Token-2022 assets', () => {
  const result = evaluateSignalSafety({
    ...safeSnapshot,
    honeypot: undefined,
    isToken2022: true,
    token2022ExtensionsVerified: true,
    nonTransferable: true,
    transferFeeEnable: false
  }, safeScores);
  assert.equal(result.ok, false);
  assert.ok(result.reasons.includes('non-transferable token'));
  assert.equal(result.emergency, true);
});

test('blocks Token-2022 transfer fee assets from automatic entry', () => {
  const result = evaluateSignalSafety({
    ...safeSnapshot,
    honeypot: undefined,
    isToken2022: true,
    token2022ExtensionsVerified: true,
    nonTransferable: false,
    transferFeeEnable: true
  }, safeScores);
  assert.equal(result.ok, false);
  assert.ok(result.reasons.includes('Token-2022 transfer fee enabled'));
  assert.equal(result.emergency, true);
});

test('blocks any other directly detected risky Token-2022 extension', () => {
  const result = evaluateSignalSafety({
    ...safeSnapshot,
    honeypot: undefined,
    isToken2022: true,
    token2022ExtensionsVerified: true,
    nonTransferable: false,
    transferFeeEnable: false,
    onchainSecurityVerified: false,
    token2022UnsafeExtensions: ['permanentDelegate']
  }, safeScores);
  assert.equal(result.ok, false);
  assert.ok(result.reasons.includes('Token-2022 risky extension: permanentDelegate'));
  assert.equal(result.emergency, true);
});

test('fails closed when Token-2022 extension parsing is unavailable', () => {
  const result = evaluateSignalSafety({
    ...safeSnapshot,
    honeypot: undefined,
    isToken2022: true,
    token2022ExtensionsVerified: false,
    nonTransferable: false,
    transferFeeEnable: false
  }, safeScores);
  assert.equal(result.ok, false);
  assert.ok(result.reasons.includes('Token-2022 extensions not verified'));
});

test('blocks dangerous known holder concentration', () => {
  const result = evaluateSignalSafety({ ...safeSnapshot, top10HolderPct: 55 }, { risk: 30, blockers: [] });
  assert.equal(result.ok, false);
  assert.match(result.reasons.join(' '), /top-10 concentration/i);
});

test('treats critically low PumpSwap liquidity as emergency', () => {
  const result = evaluateSignalSafety({
    ...safeSnapshot,
    source: 'dexscreener:pumpswap',
    liquidityUsd: 0.01,
    securityVerified: false
  }, { risk: 45, blockers: ['very low liquidity'] });
  assert.equal(result.ok, false);
  assert.equal(result.emergency, true);
  assert.match(result.emergencyReasons.join(' '), /liquidity critically low/i);
});

test('treats verified honeypot as emergency', () => {
  const result = evaluateSignalSafety({ ...safeSnapshot, honeypot: true }, { risk: 100, blockers: ['honeypot flag'] });
  assert.equal(result.ok, false);
  assert.equal(result.emergency, true);
  assert.ok(result.emergencyReasons.includes('honeypot flag'));
});
