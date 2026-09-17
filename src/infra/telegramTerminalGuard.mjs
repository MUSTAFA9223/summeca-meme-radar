const EVM = /^0x[0-9a-fA-F]{40}$/;
const SOLANA = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

function detectNetwork(text) {
  const value = String(text ?? '');
  if (/ROBINHOOD\s+CHAIN/i.test(value)) return 'rh';
  if (/BNB\s+CHAIN|\bBSC\b/i.test(value)) return 'bsc';
  if (/SOLANA|PUMP\.FUN|PUMPSWAP/i.test(value)) return 'sol';
  if (/\bARC\b/i.test(value)) return 'arc';
  return '';
}

function detectAddress(text, network) {
  const match = String(text ?? '').match(/(?:^|\n)CA:\s*([^\s\n]+)/i);
  const address = String(match?.[1] ?? '').trim();
  if (network === 'sol') return SOLANA.test(address) ? address : '';
  return EVM.test(address) ? address : '';
}

function hasTerminalActions(rows) {
  return (Array.isArray(rows) ? rows : []).some((row) =>
    (Array.isArray(row) ? row : []).some((button) => String(button?.callback_data ?? '').startsWith('term:'))
  );
}

function terminalRows(network, address) {
  return [
    [
      { text: '🔎 تحليل', callback_data: `term:a:${network}:${address}` },
      { text: '🟢 Buy', callback_data: `term:b:${network}:${address}` },
      { text: '🔴 Sell', callback_data: `term:s:${network}:${address}` }
    ],
    [{ text: '📊 Positions', callback_data: 'term:p' }]
  ];
}

let installed = false;

export function installTelegramTerminalGuard() {
  if (installed) return;
  installed = true;
  const originalFetch = globalThis.fetch.bind(globalThis);

  globalThis.fetch = async (input, init = {}) => {
    const url = typeof input === 'string' ? input : String(input?.url ?? input ?? '');
    if (!/https:\/\/api\.telegram\.org\/bot[^/]+\/(sendMessage|sendPhoto)$/i.test(url)) {
      return originalFetch(input, init);
    }

    try {
      if (typeof init?.body !== 'string') return originalFetch(input, init);
      const body = JSON.parse(init.body);
      const text = String(body?.text ?? body?.caption ?? '');
      const network = detectNetwork(text);
      const address = detectAddress(text, network);
      if (!network || !address) return originalFetch(input, init);

      const markup = body.reply_markup && typeof body.reply_markup === 'object'
        ? body.reply_markup
        : {};
      const rows = Array.isArray(markup.inline_keyboard) ? markup.inline_keyboard : [];
      if (!hasTerminalActions(rows)) {
        body.reply_markup = { ...markup, inline_keyboard: [...rows, ...terminalRows(network, address)] };
        init = { ...init, body: JSON.stringify(body) };
      }
    } catch {
      // Fail open: Telegram delivery must never be blocked by the UI enhancer.
    }
    return originalFetch(input, init);
  };

  console.log('TELEGRAM TERMINAL GUARD: token alerts get Analyse/Buy/Sell/Positions actions');
}
