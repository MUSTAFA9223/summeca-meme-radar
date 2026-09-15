const ALERT_PATTERN = /SUMMECA TRENDING|APPROVED ENTRY SIGNAL|إشارة دخول معتمدة|SUMMECA EARLY MOMENTUM|SAFETY PENDING|الأمان قيد التحقق|Tracking reference set|بدأ مرجع المتابعة|update\s*[—-]\s*crossed|تحديث\s+\$.*تجاوز|RISK EMERGENCY|طوارئ مخاطرة|WATCHLIST RISK|تحذير مخاطرة|زخم انفجاري|الزخم يتسارع|متابعة\s*[—-]\s*حركة صاعدة|tracking update|تحديث متابعة|Reached:\s*\+|وصل:\s*\+/i;
const CA_PATTERN = /(?:^|\n)\s*CA:\s*([0-9A-Za-z]{32,64}|0x[0-9a-fA-F]{40})\b/i;

export const STARTUP_ALERT_MUTE_MS = 60_000;
export const STARTUP_SUPPRESSED_TOKEN_TTL_MS = 15 * 60_000;

export const stripTelegramHtml = (value) => String(value ?? '').replace(/<[^>]*>/g, '');

export function isTelegramRadarAlert(payload = {}) {
  const text = stripTelegramHtml(payload.text ?? payload.caption ?? '');
  return Boolean(text && ALERT_PATTERN.test(text));
}

export function telegramAlertTokenKey(payload = {}) {
  const text = stripTelegramHtml(payload.text ?? payload.caption ?? '');
  const match = text.match(CA_PATTERN);
  return match?.[1] ? String(match[1]).toLowerCase() : '';
}
