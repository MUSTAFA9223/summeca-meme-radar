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

function hasPrefix(rows, prefix) {
  return (Array.isArray(rows) ? rows : []).some((row) =>
    (Array.isArray(row) ? row : []).some((button) => String(button?.callback_data ?? '').startsWith(prefix))
  );
}

function isSmartWalletAlert(text) {
  const value = String(text ?? '');
  return /🧠\s*(?:المحفظة|wallet)|smart\s*wallet|محفظة.*متتبعة|tracked\s*wallet/i.test(value);
}

function basicRows(network, address) {
  return [
    [
      { text: '🔎 تحليل', callback_data: `term:a:${network}:${address}` },
      { text: '🟢 Buy', callback_data: `term:b:${network}:${address}` },
      { text: '🔴 Sell', callback_data: `term:s:${network}:${address}` }
    ],
    [{ text: '📊 Positions', callback_data: 'term:p' }]
  ];
}

function advancedRows(network, address, text) {
  const rows = [[
    { text: '🎯 TP/SL', callback_data: `adv:r:${network}:${address}` },
    { text: '⚙️ Presets', callback_data: 'adv:pre' },
    { text: '👛 Wallet', callback_data: 'adv:w' }
  ]];
  if (isSmartWalletAlert(text)) rows.push([{ text: '🧠 Copy Preview / Confirm', callback_data: `adv:cp:${network}:${address}` }]);
  return rows;
}

function phase3Rows(network, address) {
  return [
    [
      { text: '🎯 Limit', callback_data: `p3:l:${network}:${address}` },
      { text: '📆 DCA', callback_data: `p3:d:${network}:${address}` },
      { text: '⚡ Sniper', callback_data: `p3:s:${network}:${address}` }
    ],
    [
      { text: '🧠 Copy Dashboard', callback_data: 'p3:c' },
      { text: '📋 Orders', callback_data: 'p3:o' }
    ]
  ];
}

let installed = false;

export function installTelegramTerminalGuard() {
  if (installed) return;
  installed = true;
  const originalFetch = globalThis.fetch.bind(globalThis);

  globalThis.fetch = async (input, init = {}) => {
    const url = typeof input === 'string' ? input : String(input?.url ?? input ?? '');
    if (!/https:\/\/api\.telegram\.org\/bot[^/]+\/(sendMessage|sendPhoto)$/i.test(url)) return originalFetch(input, init);

    try {
      if (typeof init?.body !== 'string') return originalFetch(input, init);
      const body = JSON.parse(init.body);
      const text = String(body?.text ?? body?.caption ?? '');
      const network = detectNetwork(text);
      const address = detectAddress(text, network);
      if (!network || !address) return originalFetch(input, init);

      const markup = body.reply_markup && typeof body.reply_markup === 'object' ? body.reply_markup : {};
      const rows = Array.isArray(markup.inline_keyboard) ? markup.inline_keyboard : [];
      const extra = [];
      if (!hasPrefix(rows, 'term:')) extra.push(...basicRows(network, address));
      if (!hasPrefix(rows, 'adv:')) extra.push(...advancedRows(network, address, text));
      if (!hasPrefix(rows, 'p3:')) extra.push(...phase3Rows(network, address));
      if (extra.length) {
        body.reply_markup = { ...markup, inline_keyboard: [...rows, ...extra] };
        init = { ...init, body: JSON.stringify(body) };
      }
    } catch {
      // Fail open: Telegram delivery must never be blocked by the UI enhancer.
    }
    return originalFetch(input, init);
  };

  console.log('TELEGRAM TERMINAL GUARD: Basic + Advanced + Limit/DCA/Sniper/Copy actions merged without duplicates');
}
