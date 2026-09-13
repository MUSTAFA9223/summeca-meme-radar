export class AppSettings {
  constructor(url, secretKey) {
    this.url = String(url ?? '').replace(/\/$/, '');
    this.secretKey = secretKey ?? '';
  }

  get enabled() {
    return Boolean(this.url && this.secretKey);
  }

  async #request(path, { method = 'GET', body, prefer } = {}) {
    if (!this.enabled) throw new Error('Supabase settings store is not configured');
    const response = await fetch(`${this.url}/rest/v1/${path}`, {
      method,
      headers: {
        apikey: this.secretKey,
        accept: 'application/json',
        ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
        ...(prefer ? { Prefer: prefer } : {})
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {})
    });
    if (!response.ok) {
      const text = await response.text().catch(() => '');
      throw new Error(`Supabase settings ${method} HTTP ${response.status}${text ? `: ${text.slice(0, 200)}` : ''}`);
    }
    if (response.status === 204) return null;
    const text = await response.text();
    return text ? JSON.parse(text) : null;
  }

  async get(key) {
    if (!this.enabled) return null;
    const rows = await this.#request(`app_settings?select=value&key=eq.${encodeURIComponent(key)}&limit=1`);
    return Array.isArray(rows) ? rows[0]?.value ?? null : null;
  }

  async set(key, value) {
    if (!this.enabled) return;
    await this.#request('app_settings?on_conflict=key', {
      method: 'POST',
      prefer: 'resolution=merge-duplicates,return=minimal',
      body: { key, value: String(value) }
    });
  }
}
