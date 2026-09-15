import test from 'node:test';
import assert from 'node:assert/strict';
import {
  STARTUP_ALERT_MUTE_MS,
  STARTUP_SUPPRESSED_TOKEN_TTL_MS,
  isTelegramRadarAlert,
  telegramAlertTokenKey
} from '../src/bot/telegramNotificationPolicy.mjs';

test('recognizes radar alerts that must stay silent during deploy startup', () => {
  assert.equal(isTelegramRadarAlert({ text: '🔥 SUMMECA TRENDING — APPROVED ENTRY SIGNAL\nCA: AbCd12345678901234567890123456789012' }), true);
  assert.equal(isTelegramRadarAlert({ text: '🚨 RISK EMERGENCY — TOKEN' }), true);
  assert.equal(isTelegramRadarAlert({ text: '📈 TOKEN tracking update — +50%' }), true);
});

test('does not classify activation/admin messages as radar alerts', () => {
  assert.equal(isTelegramRadarAlert({ text: '🔐 كود تفعيل جديد\nSMC-ABCD-2345' }), false);
  assert.equal(isTelegramRadarAlert({ text: '🛠️ لوحة المالك — SUMMECA' }), false);
  assert.equal(isTelegramRadarAlert({ text: '✅ تم تفعيل SUMMECA Meme Radar بنجاح.' }), false);
});

test('extracts a stable token key from Solana and EVM CA lines', () => {
  assert.equal(
    telegramAlertTokenKey({ text: 'Signal\nCA: 6H6KWWQ2qmQ8sxe6DFPCqWWempBhgWGityFpYdpJpump' }),
    '6h6kwwq2qmq8sxe6dfpcqwwempbhgwgityfpydpjpump'
  );
  assert.equal(
    telegramAlertTokenKey({ text: 'Signal\nCA: 0x1234567890abcdef1234567890abcdef12345678' }),
    '0x1234567890abcdef1234567890abcdef12345678'
  );
});

test('startup mute and replay suppression windows are intentional', () => {
  assert.equal(STARTUP_ALERT_MUTE_MS, 60_000);
  assert.ok(STARTUP_SUPPRESSED_TOKEN_TTL_MS >= 10 * 60_000);
});
