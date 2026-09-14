const nativeFetch = globalThis.fetch.bind(globalThis);

const escapeHtml = (value) => String(value ?? '')
  .replaceAll('&', '&amp;')
  .replaceAll('<', '&lt;')
  .replaceAll('>', '&gt;');

const bold = (value) => `<b>${escapeHtml(value)}</b>`;

const TELEGRAM_BOLD_METHODS = new Set([
  'sendMessage',
  'editMessageText',
  'sendPhoto',
  'editMessageCaption'
]);

function telegramMethod(url) {
  const match = String(url ?? '').match(/^https:\/\/api\.telegram\.org\/bot[^/]+\/([^?]+)/i);
  return match?.[1] ?? '';
}

function withBoldTelegramPayload(input, init = {}) {
  const url = typeof input === 'string' || input instanceof URL ? String(input) : String(input?.url ?? '');
  const method = telegramMethod(url);
  if (!TELEGRAM_BOLD_METHODS.has(method) || typeof init?.body !== 'string') return init;

  let payload;
  try {
    payload = JSON.parse(init.body);
  } catch {
    return init;
  }

  // Preserve messages that already deliberately use Telegram HTML/Markdown formatting.
  if (payload?.parse_mode) return init;

  let changed = false;
  if ((method === 'sendMessage' || method === 'editMessageText') && typeof payload?.text === 'string' && payload.text.length) {
    payload.text = bold(payload.text);
    payload.parse_mode = 'HTML';
    changed = true;
  }
  if ((method === 'sendPhoto' || method === 'editMessageCaption') && typeof payload?.caption === 'string' && payload.caption.length) {
    payload.caption = bold(payload.caption);
    payload.parse_mode = 'HTML';
    changed = true;
  }

  return changed ? { ...init, body: JSON.stringify(payload) } : init;
}

globalThis.fetch = async (input, init = {}) => nativeFetch(input, withBoldTelegramPayload(input, init));
