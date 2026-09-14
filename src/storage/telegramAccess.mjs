import { createHash, randomBytes } from 'node:crypto';

const normalizeCode = (value) => String(value ?? '').trim().toUpperCase().replace(/\s+/g, '');

export const hashActivationCode = (value) => createHash('sha256').update(normalizeCode(value)).digest('hex');

export function generateActivationCode() {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  const bytes = randomBytes(8);
  let token = '';
  for (let i = 0; i < 8; i += 1) token += alphabet[bytes[i] % alphabet.length];
  return `SMC-${token.slice(0, 4)}-${token.slice(4)}`;
}

export class TelegramAccess {
  constructor(url, secretKey) {
    this.url = String(url ?? '').replace(/\/$/, '');
    this.secretKey = String(secretKey ?? '');
  }

  get enabled() {
    return Boolean(this.url && this.secretKey);
  }

  async #request(path, { method = 'GET', body, prefer } = {}) {
    if (!this.enabled) throw new Error('Telegram access store is not configured');
    const response = await fetch(`${this.url}/rest/v1/${path}`, {
      method,
      headers: {
        apikey: this.secretKey,
        authorization: `Bearer ${this.secretKey}`,
        accept: 'application/json',
        ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
        ...(prefer ? { Prefer: prefer } : {})
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {})
    });
    const text = await response.text().catch(() => '');
    if (!response.ok) throw new Error(`Telegram access ${method} HTTP ${response.status}${text ? `: ${text.slice(0, 220)}` : ''}`);
    if (!text) return null;
    return JSON.parse(text);
  }

  async ownerChatId() {
    if (!this.enabled) return '';
    const rows = await this.#request('telegram_subscribers?select=chat_id&role=eq.owner&active=eq.true&limit=1');
    return Array.isArray(rows) ? String(rows[0]?.chat_id ?? '') : '';
  }

  async subscriber(chatId) {
    if (!this.enabled || !chatId) return null;
    const rows = await this.#request(`telegram_subscribers?select=chat_id,telegram_user_id,username,first_name,role,active,notify_enabled,access_expires_at&chat_id=eq.${encodeURIComponent(String(chatId))}&limit=1`);
    const row = Array.isArray(rows) ? rows[0] ?? null : null;
    if (!row) return null;
    const expired = row.access_expires_at && Date.parse(row.access_expires_at) <= Date.now();
    return { ...row, expired: Boolean(expired), authorized: row.active === true && !expired };
  }

  async activeRecipients({ excludeChatId = '' } = {}) {
    if (!this.enabled) return [];
    const rows = await this.#request('telegram_subscribers?select=chat_id,role,active,notify_enabled,access_expires_at&active=eq.true&notify_enabled=eq.true&limit=500');
    const now = Date.now();
    return (Array.isArray(rows) ? rows : []).filter((row) => {
      if (!row?.chat_id || String(row.chat_id) === String(excludeChatId)) return false;
      if (row.access_expires_at && Date.parse(row.access_expires_at) <= now) return false;
      return true;
    });
  }

  async createCode(ownerChatId, accessDays = null) {
    if (!this.enabled) throw new Error('Telegram access store is not configured');
    const code = generateActivationCode();
    const parsedDays = accessDays == null || accessDays === '' ? null : Number(accessDays);
    if (parsedDays != null && (!Number.isInteger(parsedDays) || parsedDays < 1 || parsedDays > 3650)) {
      throw new Error('access days must be between 1 and 3650');
    }
    await this.#request('telegram_activation_codes', {
      method: 'POST',
      prefer: 'return=minimal',
      body: {
        code_hash: hashActivationCode(code),
        created_by_chat_id: String(ownerChatId),
        access_days: parsedDays,
        max_uses: 1
      }
    });
    return { code, accessDays: parsedDays };
  }

  async activate(code, message) {
    if (!this.enabled) return { ok: false, reason: 'not_configured' };
    const chatId = String(message?.chat?.id ?? '');
    if (!chatId) return { ok: false, reason: 'missing_chat' };
    const result = await this.#request('rpc/activate_telegram_code', {
      method: 'POST',
      body: {
        p_code_hash: hashActivationCode(code),
        p_chat_id: chatId,
        p_telegram_user_id: String(message?.from?.id ?? ''),
        p_username: message?.from?.username ? String(message.from.username) : null,
        p_first_name: message?.from?.first_name ? String(message.from.first_name) : null
      }
    });
    return result && typeof result === 'object' ? result : { ok: false, reason: 'unknown' };
  }

  async listSubscribers(limit = 50) {
    if (!this.enabled) return [];
    const safeLimit = Math.max(1, Math.min(200, Number(limit) || 50));
    const rows = await this.#request(`telegram_subscribers?select=chat_id,username,first_name,role,active,notify_enabled,activated_at,access_expires_at&order=activated_at.desc&limit=${safeLimit}`);
    return Array.isArray(rows) ? rows : [];
  }

  async revoke(chatId) {
    if (!this.enabled || !chatId) return false;
    await this.#request(`telegram_subscribers?chat_id=eq.${encodeURIComponent(String(chatId))}&role=neq.owner`, {
      method: 'PATCH',
      prefer: 'return=minimal',
      body: { active: false, notify_enabled: false }
    });
    return true;
  }

  async markInactive(chatId) {
    if (!this.enabled || !chatId) return;
    await this.#request(`telegram_subscribers?chat_id=eq.${encodeURIComponent(String(chatId))}&role=neq.owner`, {
      method: 'PATCH',
      prefer: 'return=minimal',
      body: { active: false, notify_enabled: false }
    }).catch(() => {});
  }
}
