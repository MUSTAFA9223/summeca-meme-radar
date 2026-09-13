import { PUMP_FUN_PROGRAM_ID, buildLogsSubscribeRequest, createHeliusWsUrl } from '../src/feeds/heliusWs.mjs';

const apiKey = process.env.HELIUS_API_KEY ?? '';
if (!apiKey) {
  console.error('HELIUS_API_KEY is required');
  process.exit(1);
}

const timeoutMs = 10_000;
const startedAt = Date.now();
const ws = new WebSocket(createHeliusWsUrl(apiKey));
let settled = false;

const finish = (code, payload) => {
  if (settled) return;
  settled = true;
  clearTimeout(timeout);
  try { ws.close(1000, 'smoke complete'); } catch {}
  if (payload) console.log(JSON.stringify(payload));
  process.exitCode = code;
};

const timeout = setTimeout(() => {
  console.error('Helius WebSocket smoke test timed out');
  finish(1);
}, timeoutMs);

ws.addEventListener('open', () => {
  ws.send(JSON.stringify(buildLogsSubscribeRequest(PUMP_FUN_PROGRAM_ID, 1, 'processed')));
});

ws.addEventListener('message', (event) => {
  let message;
  try {
    message = JSON.parse(String(event.data));
  } catch {
    return;
  }

  if (message?.id === 1 && typeof message?.result === 'number') {
    finish(0, {
      ok: true,
      provider: 'helius',
      chain: 'solana',
      transport: 'websocket',
      method: 'logsSubscribe',
      program: 'pump.fun',
      subscriptionId: message.result,
      elapsedMs: Date.now() - startedAt
    });
  } else if (message?.id === 1 && message?.error) {
    console.error(`Helius WebSocket subscription failed: ${message.error.message ?? 'unknown error'}`);
    finish(1);
  }
});

ws.addEventListener('error', () => {
  console.error('Helius WebSocket connection failed');
  finish(1);
});
