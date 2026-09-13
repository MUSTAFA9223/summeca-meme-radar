const apiKey = process.env.HELIUS_API_KEY;

if (!apiKey) {
  console.error('HELIUS_API_KEY is required');
  process.exit(1);
}

const endpoint = `https://mainnet.helius-rpc.com/?api-key=${encodeURIComponent(apiKey)}`;

async function rpc(method, params = []) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 10_000);
  try {
    const response = await fetch(endpoint, {
      method: 'POST',
      signal: controller.signal,
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params })
    });

    if (!response.ok) throw new Error(`Helius HTTP ${response.status}`);
    const body = await response.json();
    if (body.error) throw new Error(`Helius RPC ${body.error.code}: ${body.error.message}`);
    return body.result;
  } finally {
    clearTimeout(timer);
  }
}

try {
  const started = Date.now();
  const [health, slot] = await Promise.all([rpc('getHealth'), rpc('getSlot')]);
  const elapsedMs = Date.now() - started;

  if (health !== 'ok') throw new Error(`Unexpected health response: ${JSON.stringify(health)}`);
  if (!Number.isInteger(slot) || slot <= 0) throw new Error(`Unexpected slot: ${JSON.stringify(slot)}`);

  console.log(JSON.stringify({
    ok: true,
    provider: 'helius',
    chain: 'solana-mainnet',
    health,
    slot,
    elapsedMs
  }));
} catch (error) {
  console.error(`Helius smoke test failed: ${error.message}`);
  process.exit(1);
}
