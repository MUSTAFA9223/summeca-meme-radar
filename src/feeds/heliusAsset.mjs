const normalizeImage = (value) => {
  const raw = String(value ?? '').trim();
  if (!raw) return null;
  if (raw.startsWith('ipfs://')) return `https://ipfs.io/ipfs/${raw.slice(7)}`;
  if (/^https?:\/\//i.test(raw)) return raw;
  return null;
};

export async function fetchHeliusAssetMetadata(apiKey, address) {
  if (!apiKey || !address) return {};
  const endpoint = `https://mainnet.helius-rpc.com/?api-key=${encodeURIComponent(apiKey)}`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 8000);
  try {
    const response = await fetch(endpoint, {
      method: 'POST',
      signal: controller.signal,
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 'summeca-asset',
        method: 'getAsset',
        params: { id: address }
      })
    });
    if (!response.ok) throw new Error(`Helius getAsset HTTP ${response.status}`);
    const body = await response.json();
    if (body.error) throw new Error(`Helius getAsset ${body.error.code}: ${body.error.message}`);
    const asset = body.result ?? {};
    const files = Array.isArray(asset?.content?.files) ? asset.content.files : [];
    const imageUrl = normalizeImage(asset?.content?.links?.image)
      ?? normalizeImage(files.find((file) => String(file?.mime ?? '').startsWith('image/'))?.uri)
      ?? normalizeImage(files[0]?.uri);
    const metadata = asset?.content?.metadata ?? {};
    return {
      ...(imageUrl ? { imageUrl } : {}),
      ...(metadata.name ? { name: String(metadata.name) } : {}),
      ...(metadata.symbol ? { symbol: String(metadata.symbol) } : {})
    };
  } finally {
    clearTimeout(timer);
  }
}
