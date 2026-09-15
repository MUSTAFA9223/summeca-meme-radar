const SOLANA_ADDRESS = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

export function ensureRawCoinContractCopy(payload = {}) {
  const text = String(payload?.text ?? payload?.caption ?? '');
  if (!/(?:الحالة:\s*خام|Status:\s*raw)/i.test(text)) return payload;

  const match = text.match(/(?:^|\n)CA:\s*([1-9A-HJ-NP-Za-km-z]{32,44})(?:\s|$)/i);
  const address = String(match?.[1] ?? '');
  if (!SOLANA_ADDRESS.test(address)) return payload;

  const existing = Array.isArray(payload?.reply_markup?.inline_keyboard)
    ? payload.reply_markup.inline_keyboard
    : [];

  const cleaned = existing
    .map((row) => (Array.isArray(row) ? row : []).filter((button) => String(button?.copy_text?.text ?? '') !== address))
    .filter((row) => row.length > 0);

  return {
    ...payload,
    reply_markup: {
      ...(payload.reply_markup ?? {}),
      inline_keyboard: [
        [{ text: '📋 نسخ عقد العملة', copy_text: { text: address } }],
        ...cleaned
      ]
    }
  };
}
