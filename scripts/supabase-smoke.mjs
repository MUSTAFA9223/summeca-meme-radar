const url = String(process.env.SUPABASE_URL ?? '').replace(/\/$/, '');
const key = process.env.SUPABASE_SECRET_KEY ?? '';
if (!url || !key) {
  console.error('SUPABASE_URL and SUPABASE_SECRET_KEY are required');
  process.exit(1);
}

const headers = {
  apikey: key,
  accept: 'application/json',
  'content-type': 'application/json'
};

const address = `smoke-${Date.now()}-${Math.random().toString(16).slice(2)}`;
let inserted = false;
const started = Date.now();

async function request(path, options = {}) {
  const response = await fetch(`${url}/rest/v1/${path}`, {
    ...options,
    headers: { ...headers, ...(options.headers ?? {}) }
  });
  const text = await response.text();
  if (!response.ok) throw new Error(`Supabase ${options.method ?? 'GET'} ${path} HTTP ${response.status}: ${text.slice(0, 300)}`);
  return text ? JSON.parse(text) : null;
}

try {
  const created = await request('tokens', {
    method: 'POST',
    headers: { Prefer: 'return=representation' },
    body: JSON.stringify({
      address,
      symbol: 'SMOKE',
      name: 'CI Smoke Test',
      source: 'github-actions',
      status: 'tracking',
      initial_price_usd: 0.000001,
      initial_liquidity_usd: 1000
    })
  });
  inserted = true;
  if (!Array.isArray(created) || !created[0]?.id) throw new Error('Insert did not return a token id');

  const read = await request(`tokens?select=id,address,symbol&address=eq.${encodeURIComponent(address)}&limit=1`);
  if (!Array.isArray(read) || read[0]?.address !== address) throw new Error('Read-back did not return inserted token');

  console.log(JSON.stringify({
    ok: true,
    provider: 'supabase',
    operation: 'write-read-delete',
    table: 'tokens',
    elapsedMs: Date.now() - started
  }));
} finally {
  if (inserted) {
    await request(`tokens?address=eq.${encodeURIComponent(address)}`, { method: 'DELETE' }).catch((error) => {
      console.error(`Cleanup failed: ${error.message}`);
      process.exitCode = 1;
    });
  }
}
