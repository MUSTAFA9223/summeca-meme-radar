import { env } from '../config/env.mjs';
import { entryQuality, isRisingMomentum, momentumScore, normalizeMomentumSnapshot, persistedSafety } from '../core/momentumProfile.mjs';
import { telegramApi } from '../notifiers/telegram.mjs';

const POLL_MS = 7_000;
const ALERT_COOLDOWN_MS = 90_000;
const SOLANA_ADDRESS = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

const compactMoney = (value) => {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return '—';
  if (n >= 1e9) return `${(n / 1e9).toFixed(n >= 1e10 ? 0 : 1)}B`;
  if (n >= 1e6) return `${(n / 1e6).toFixed(n >= 1e7 ? 0 : 1)}M`;
  if (n >= 1e3) return `${(n / 1e3).toFixed(n >= 1e4 ? 0 : 1)}K`;
  return n.toFixed(n >= 100 ? 0 : 1);
};

const priceText = (value) => {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return '—';
  return n >= 0.01 ? n.toLocaleString('en-US', { maximumFractionDigits: 8 }) : n.toExponential(6);
};

const watchKeyboard = (mint, { safe = false } = {}) => {
  const tradeRow = safe
    ? [
        { text: '🧪 شراء Paper', callback_data: `paper:menu:${mint}` },
        { text: '⚡ تداول حقيقي', callback_data: `live:menu:${mint}` }
      ]
    : [{ text: '🧪 شراء Paper', callback_data: `paper:menu:${mint}` }];

  return {
    inline_keyboard: [
      [
        { text: '📊 DEX', url: `https://dexscreener.com/solana/${encodeURIComponent(mint)}` },
        { text: '🔥 FOMO', url: `https://fomo.family/tokens/solana/${encodeURIComponent(mint)}` },
        { text: '👻 Phantom', url: `https://phantom.com/tokens/solana/${encodeURIComponent(mint)}` }
      ],
      tradeRow,
      [
        { text: '🗑️ إلغاء المتابعة', callback_data: `watch:remove:${mint}` },
        { text: '📋 العقد', copy_text: { text: mint } }
      ]
    ]
  };
};

class WatchStore {
  constructor(url, key) {
    this.url = String(url ?? '').replace(/\/$/, '');
    this.key = String(key ?? '');
  }

  get enabled() { return Boolean(this.url && this.key); }

  async request(path) {
    const response = await fetch(`${this.url}/rest/v1/${path}`, {
      headers: { apikey: this.key, Authorization: `Bearer ${this.key}`, accept: 'application/json' }
    });
    const text = await response.text().catch(() => '');
    if (!response.ok) throw new Error(`Supabase GET ${path} HTTP ${response.status}${text ? `: ${text.slice(0, 180)}` : ''}`);
    return text ? JSON.parse(text) : [];
  }

  async setting(key) {
    const rows = await this.request(`app_settings?select=value&key=eq.${encodeURIComponent(key)}&limit=1`);
    return String(rows?.[0]?.value ?? '');
  }

  async chatId() {
    if (env.telegramChatId) return String(env.telegramChatId);
    return this.setting('telegram_chat_id');
  }

  async language() {
    return (await this.setting('telegram_language')) || env.telegramLanguage || 'ar';
  }

  async watchlist() {
    const raw = await this.setting('watchlist_tokens');
    if (!raw) return [];
    try {
      return [...new Set(JSON.parse(raw).map(String).filter((value) => SOLANA_ADDRESS.test(value)))].slice(0, 30);
    } catch {
      return [];
    }
  }

  async latestForAddresses(addresses) {
    if (!addresses.length) return [];
    const tokenFilter = addresses.map((value) => `"${value}"`).join(',');
    const tokens = await this.request(`tokens?select=id,address,symbol,name,source,listed_at&address=in.(${tokenFilter})`);
    if (!Array.isArray(tokens) || !tokens.length) return [];
    const ids = tokens.map((token) => token.id).filter(Boolean);
    if (!ids.length) return [];
    const snapshotFields = 'id,token_id,observed_at,price_usd,liquidity_usd,market_cap_usd,buys_30s,sells_30s,buy_volume_30s_usd,sell_volume_30s_usd,unique_buyers_30s,buyer_acceleration,volume_acceleration,top10_holder_pct,creator_pct,honeypot,mint_authority_disabled,freeze_authority_disabled,entry_score,moon_score,risk_score,raw';
    const rows = await this.request(`snapshots?select=${snapshotFields}&token_id=in.(${ids.join(',')})&order=observed_at.desc&limit=${Math.min(200, ids.length * 10)}`);
    const tokenById = new Map(tokens.map((token) => [String(token.id), token]));
    const latest = new Map();
    for (const row of Array.isArray(rows) ? rows : []) {
      const key = String(row.token_id);
      if (!latest.has(key)) latest.set(key, { ...row, tokens: tokenById.get(key) ?? {} });
    }
    return [...latest.values()];
  }
}

class WatchlistAlertWorker {
  constructor() {
    this.store = new WatchStore(env.supabaseUrl, env.supabaseSecretKey);
    this.chatId = '';
    this.language = env.telegramLanguage || 'ar';
    this.state = new Map();
    this.running = false;
    this.timer = null;
  }

  async init() {
    if (!this.store.enabled || !env.telegramBotToken) {
      console.log('[watchlist-alerts] disabled: Supabase or Telegram not configured');
      return false;
    }
    this.chatId = await this.store.chatId();
    this.language = await this.store.language();
    if (!this.chatId) {
      console.log('[watchlist-alerts] disabled: Telegram chat not linked');
      return false;
    }
    console.log(`[watchlist-alerts] READY tri-state-safety chat=linked language=${this.language}`);
    return true;
  }

  pick(ar, en) {
    if (this.language === 'en') return en;
    if (this.language === 'bilingual') return `${ar}\n\n────────────\n\n${en}`;
    return ar;
  }

  async send(snapshot, textAr, textEn, { safe = false } = {}) {
    const s = normalizeMomentumSnapshot(snapshot);
    const text = this.pick(textAr, textEn);
    const body = { chat_id: this.chatId, reply_markup: watchKeyboard(s.address, { safe }) };
    if (s.imageUrl && text.length <= 1000) {
      try {
        return await telegramApi(env.telegramBotToken, 'sendPhoto', { ...body, photo: s.imageUrl, caption: text });
      } catch (error) {
        console.warn('[watchlist-alerts:photo]', error.message);
      }
    }
    return telegramApi(env.telegramBotToken, 'sendMessage', { ...body, text });
  }

  band(score) {
    if (score >= 90) return 3;
    if (score >= 80) return 2;
    if (score >= 65) return 1;
    return 0;
  }

  async inspect(snapshot) {
    const s = normalizeMomentumSnapshot(snapshot);
    if (!SOLANA_ADDRESS.test(s.address)) return;
    const safety = persistedSafety(snapshot);
    const rising = isRisingMomentum(snapshot);
    const score = momentumScore(snapshot);
    const quality = entryQuality(snapshot);
    const now = Date.now();
    const previous = this.state.get(s.address) ?? {
      band: 0,
      status: 'unknown',
      lastAlertAt: 0,
      warnedDangerous: false
    };
    const nextBand = this.band(score);
    const statusChanged = previous.status !== safety.status;

    // Confirmed danger blocks entry, but it no longer erases the momentum state.
    // This preserves post-signal performance tracking instead of going silent.
    if (safety.status === 'dangerous' && !previous.warnedDangerous) {
      await this.send(snapshot,
        `🚨 تحذير مخاطرة — $${s.symbol}\n\nتم منع الدخول، لكن المتابعة ستستمر.\n${safety.dangerReasons.slice(0, 4).join(' | ')}\nRisk: ${Math.round(s.riskScore)}/100\nCA: ${s.address}`,
        `🚨 WATCHLIST RISK — $${s.symbol}\n\nEntry is blocked, but tracking will continue.\n${safety.dangerReasons.slice(0, 4).join(' | ')}\nRisk: ${Math.round(s.riskScore)}/100\nCA: ${s.address}`,
        { safe: false }
      );
      previous.warnedDangerous = true;
      previous.lastAlertAt = now;
    } else if (safety.status !== 'dangerous') {
      previous.warnedDangerous = false;
    }

    const shouldAlert = rising
      && nextBand > 0
      && (nextBand > previous.band || (statusChanged && now - previous.lastAlertAt >= 5_000));

    if (shouldAlert) {
      const ratio = s.buys30s / Math.max(1, s.sells30s);
      const safetyAr = safety.status === 'safe'
        ? '✅ فحص الأمان ناجح'
        : safety.status === 'unknown'
          ? `⚠️ الأمان قيد التحقق — لا دخول حقيقي\n${safety.pendingReasons.slice(0, 3).join(' | ')}`
          : `⛔ خطر مؤكد — متابعة فقط\n${safety.dangerReasons.slice(0, 3).join(' | ')}`;
      const safetyEn = safety.status === 'safe'
        ? '✅ Safety gate passed'
        : safety.status === 'unknown'
          ? `⚠️ Safety pending — no live entry\n${safety.pendingReasons.slice(0, 3).join(' | ')}`
          : `⛔ Confirmed risk — tracking only\n${safety.dangerReasons.slice(0, 3).join(' | ')}`;

      const ar = [
        nextBand >= 3 ? '🚀 متابعة — زخم انفجاري' : nextBand >= 2 ? '🔥 متابعة — الزخم يتسارع' : '📈 متابعة — حركة صاعدة',
        '',
        `$${s.symbol} • ${s.name}`,
        `Momentum: ${score}/100 | Entry: ${Math.round(s.entryScore)}/100 | Risk: ${Math.round(s.riskScore)}/100`,
        `${quality.ar}`,
        `🟢 شراء 30ث: ${s.buys30s.toFixed(1)} | 🔴 بيع: ${s.sells30s.toFixed(1)} | النسبة: ${ratio.toFixed(2)}x`,
        `Vol 5m: $${compactMoney(s.volume5mUsd)} | MC: $${compactMoney(s.marketCapUsd)}`,
        `السعر: $${priceText(s.priceUsd)} | تغير 5د: ${s.priceChange5mPct.toFixed(1)}%`,
        '',
        safetyAr,
        `CA: ${s.address}`
      ].join('\n');
      const en = [
        nextBand >= 3 ? '🚀 WATCHLIST — EXPLOSIVE MOMENTUM' : nextBand >= 2 ? '🔥 WATCHLIST — MOMENTUM ACCELERATING' : '📈 WATCHLIST — RISING ACTIVITY',
        '',
        `$${s.symbol} • ${s.name}`,
        `Momentum: ${score}/100 | Entry: ${Math.round(s.entryScore)}/100 | Risk: ${Math.round(s.riskScore)}/100`,
        `${quality.en}`,
        `🟢 Buys 30s: ${s.buys30s.toFixed(1)} | 🔴 Sells: ${s.sells30s.toFixed(1)} | Ratio: ${ratio.toFixed(2)}x`,
        `Vol 5m: $${compactMoney(s.volume5mUsd)} | MC: $${compactMoney(s.marketCapUsd)}`,
        `Price: $${priceText(s.priceUsd)} | 5m: ${s.priceChange5mPct.toFixed(1)}%`,
        '',
        safetyEn,
        `CA: ${s.address}`
      ].join('\n');
      await this.send(snapshot, ar, en, { safe: safety.ok });
      previous.lastAlertAt = now;
      console.log(`[watchlist-alerts] SENT mint=${s.address.slice(0, 8)}… momentum=${score} band=${nextBand} safety=${safety.status}`);
    }

    previous.status = safety.status;
    previous.band = Math.max(previous.band, nextBand);
    this.state.set(s.address, previous);
  }

  async tick() {
    if (this.running) return;
    this.running = true;
    try {
      this.language = await this.store.language();
      const watchlist = await this.store.watchlist();
      if (!watchlist.length) {
        if (this.state.size) this.state.clear();
        return;
      }
      const rows = await this.store.latestForAddresses(watchlist);
      const active = new Set(watchlist);
      for (const key of [...this.state.keys()]) if (!active.has(key)) this.state.delete(key);
      for (const snapshot of rows) {
        try { await this.inspect(snapshot); } catch (error) { console.error('[watchlist-alerts:inspect]', error.message); }
      }
      console.log(`[watchlist-alerts] scan watched=${watchlist.length} snapshots=${rows.length}`);
    } finally {
      this.running = false;
    }
  }

  async start() {
    if (!(await this.init())) return false;
    await this.tick();
    this.timer = setInterval(() => this.tick().catch((error) => console.error('[watchlist-alerts]', error.message)), POLL_MS);
    return true;
  }
}

let singleton;
export async function startMomentumAlertWorker() {
  if (!singleton) singleton = new WatchlistAlertWorker();
  return singleton.start();
}
