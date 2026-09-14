import { env } from '../config/env.mjs';
import { telegramApi } from '../notifiers/telegram.mjs';

const POLL_MS = 7_000;
const SIGNAL_MAX_AGE_MS = 120_000;
const TRACK_TTL_MS = 6 * 60 * 60 * 1000;
const WATCH_ENTRY_THRESHOLD = Math.min(Number(env.entryScoreThreshold) || 82, 70);
const MILESTONES = [25, 50, 100, 200, 300, 500, 750, 1000, 1500, 2000, 3000, 5000, 10000];

const num = (v, fallback = 0) => Number.isFinite(Number(v)) ? Number(v) : fallback;
const compactMoney = (value) => {
  const n = num(value);
  if (n <= 0) return '—';
  if (n >= 1e9) return `${(n / 1e9).toFixed(n >= 1e10 ? 0 : 1)}B`;
  if (n >= 1e6) return `${(n / 1e6).toFixed(n >= 1e7 ? 0 : 1)}M`;
  if (n >= 1e3) return `${(n / 1e3).toFixed(n >= 1e4 ? 0 : 1)}K`;
  return n.toFixed(n >= 100 ? 0 : 1);
};
const priceText = (value) => {
  const n = num(value);
  if (n <= 0) return '—';
  return n >= 0.01 ? n.toLocaleString('en-US', { maximumFractionDigits: 8 }) : n.toExponential(6);
};

function rising(snapshot) {
  const buys = num(snapshot.buys_30s);
  const sells = num(snapshot.sells_30s);
  const ratio = buys / Math.max(1, sells);
  const price5 = num(snapshot.raw?.priceChange5mPct);
  const volume5 = num(snapshot.raw?.volume5mUsd);
  const buyerAcceleration = num(snapshot.buyer_acceleration);
  const volumeAcceleration = num(snapshot.volume_acceleration);
  return price5 >= 5
    || (ratio >= 1.8 && buys >= 4 && volume5 >= 2_000)
    || (buyerAcceleration >= 1.5 && volumeAcceleration >= 1.5 && ratio >= 1.25);
}

function strictSafety(snapshot) {
  const reasons = [];
  if (snapshot.honeypot !== false) reasons.push('honeypot not explicitly safe');
  if (snapshot.mint_authority_disabled !== true) reasons.push('mint authority not verified disabled');
  if (snapshot.freeze_authority_disabled !== true) reasons.push('freeze authority not verified disabled');
  if (num(snapshot.sells_30s) < 1) reasons.push('no verified sell observed');
  if (num(snapshot.risk_score, 100) > 35) reasons.push(`risk ${num(snapshot.risk_score)}/100`);
  if (num(snapshot.top10_holder_pct) > 40) reasons.push('top-10 concentration');
  if (num(snapshot.creator_pct) > 8) reasons.push('creator concentration');
  return { ok: reasons.length === 0, reasons };
}

function publicLinksKeyboard(mint, approved = false) {
  const dex = `https://dexscreener.com/solana/${encodeURIComponent(mint)}`;
  const phantomToken = `https://phantom.com/tokens/solana/${encodeURIComponent(mint)}`;
  const fomo = `https://fomo.family/tokens/solana/${encodeURIComponent(mint)}`;
  const caip19 = `solana:101/address:${mint}`;
  const phantomBuy = `https://phantom.app/ul/v1/swap?buy=${encodeURIComponent(caip19)}&sell=`;
  const rows = [];
  if (approved) {
    rows.push([
      { text: '🟢 شراء سريع', url: phantomBuy },
      { text: '📋 العقد', copy_text: { text: mint } }
    ]);
  } else {
    rows.push([{ text: '📋 العقد', copy_text: { text: mint } }]);
  }
  rows.push([
    { text: '📊 DEX', url: dex },
    { text: '🔥 FOMO', url: fomo },
    { text: '👻 Phantom', url: phantomToken }
  ]);
  return { inline_keyboard: rows };
}

class MomentumAlertStore {
  constructor(url, key) {
    this.url = String(url || '').replace(/\/$/, '');
    this.key = String(key || '');
  }
  get enabled() { return Boolean(this.url && this.key); }
  async request(path) {
    const res = await fetch(`${this.url}/rest/v1/${path}`, {
      headers: { apikey: this.key, Authorization: `Bearer ${this.key}`, accept: 'application/json' }
    });
    const text = await res.text().catch(() => '');
    if (!res.ok) throw new Error(`Supabase GET ${path} HTTP ${res.status}${text ? `: ${text.slice(0, 160)}` : ''}`);
    return text ? JSON.parse(text) : [];
  }
  async chatId() {
    if (env.telegramChatId) return String(env.telegramChatId);
    const rows = await this.request('app_settings?select=value&key=eq.telegram_chat_id&limit=1');
    return String(rows?.[0]?.value || '');
  }
  async language() {
    const rows = await this.request('app_settings?select=value&key=eq.telegram_language&limit=1');
    return String(rows?.[0]?.value || env.telegramLanguage || 'ar');
  }
  async recentSnapshots() {
    const since = new Date(Date.now() - SIGNAL_MAX_AGE_MS).toISOString();
    const q = new URLSearchParams({
      select: 'id,token_id,observed_at,price_usd,liquidity_usd,market_cap_usd,buys_30s,sells_30s,buy_volume_30s_usd,sell_volume_30s_usd,unique_buyers_30s,buyer_acceleration,volume_acceleration,top10_holder_pct,creator_pct,honeypot,mint_authority_disabled,freeze_authority_disabled,entry_score,moon_score,risk_score,raw,tokens(address,symbol,name,source)',
      observed_at: `gte.${since}`,
      order: 'observed_at.desc',
      limit: '120'
    });
    return await this.request(`snapshots?${q}`);
  }
  async latestForToken(tokenId) {
    const q = new URLSearchParams({
      select: 'id,token_id,observed_at,price_usd,liquidity_usd,market_cap_usd,buys_30s,sells_30s,buy_volume_30s_usd,sell_volume_30s_usd,unique_buyers_30s,buyer_acceleration,volume_acceleration,top10_holder_pct,creator_pct,honeypot,mint_authority_disabled,freeze_authority_disabled,entry_score,moon_score,risk_score,raw,tokens(address,symbol,name,source)',
      token_id: `eq.${tokenId}`,
      order: 'observed_at.desc',
      limit: '1'
    });
    const rows = await this.request(`snapshots?${q}`);
    return rows?.[0] || null;
  }
}

class MomentumAlertWorker {
  constructor() {
    this.store = new MomentumAlertStore(env.supabaseUrl, env.supabaseSecretKey);
    this.chatId = '';
    this.language = env.telegramLanguage || 'ar';
    this.alerted = new Map();
    this.running = false;
    this.timer = null;
  }

  async init() {
    if (!this.store.enabled || !env.telegramBotToken) {
      console.log('[momentum-alerts] disabled: Supabase or Telegram not configured');
      return false;
    }
    this.chatId = await this.store.chatId();
    this.language = await this.store.language();
    if (!this.chatId) {
      console.log('[momentum-alerts] disabled: Telegram chat not linked');
      return false;
    }
    console.log(`[momentum-alerts] READY threshold=${WATCH_ENTRY_THRESHOLD} chat=linked language=${this.language}`);
    return true;
  }

  async send(textAr, textEn, extra = {}) {
    const text = this.language === 'en' ? textEn : this.language === 'bilingual' ? `${textAr}\n\n────────────\n\n${textEn}` : textAr;
    return telegramApi(env.telegramBotToken, 'sendMessage', { chat_id: this.chatId, text, ...extra });
  }

  async sendMomentum(snapshot) {
    const token = snapshot.tokens || {};
    const mint = String(token.address || '');
    const symbol = String(token.symbol || 'TOKEN').replace(/^\$/, '');
    const name = String(token.name || symbol);
    const safety = strictSafety(snapshot);
    const statusAr = safety.ok ? '✅ فحص السكام: ناجح — دخول معتمد' : '⚠️ فحص السكام: قيد التحقق — مراقبة فقط';
    const statusEn = safety.ok ? '✅ Scam check: PASSED — entry approved' : '⚠️ Scam check: pending — WATCH ONLY';
    const ar = [
      '🔥 SUMMECA TRENDING — زخم قوي', '',
      `$${symbol}  •  ${name}`, '',
      `CA: ${mint}`, '',
      `MC: $${compactMoney(snapshot.market_cap_usd)}  |  Vol 5m: $${compactMoney(snapshot.raw?.volume5mUsd)}`,
      `💧 Liquidity: $${compactMoney(snapshot.liquidity_usd)}  |  💵 Price: $${priceText(snapshot.price_usd)}`,
      `🟢 Buy 30s: ${num(snapshot.buys_30s).toFixed(1)}  |  🔴 Sell 30s: ${num(snapshot.sells_30s).toFixed(1)}  |  👥 ${num(snapshot.unique_buyers_30s).toFixed(1)}`,
      '',
      `🎯 Entry ${num(snapshot.entry_score).toFixed(0)}/100  |  🚀 Moon ${num(snapshot.moon_score).toFixed(0)}/100  |  🛡️ Risk ${num(snapshot.risk_score).toFixed(0)}/100`,
      statusAr,
      safety.ok ? '' : `سبب الانتظار: ${safety.reasons.slice(0, 3).join(' | ')}`,
      '', '📈 بدأت متابعة الأداء من هذه الإشارة.'
    ].filter(Boolean).join('\n');
    const en = [
      '🔥 SUMMECA TRENDING — STRONG MOMENTUM', '',
      `$${symbol}  •  ${name}`, '',
      `CA: ${mint}`, '',
      `MC: $${compactMoney(snapshot.market_cap_usd)}  |  Vol 5m: $${compactMoney(snapshot.raw?.volume5mUsd)}`,
      `💧 Liquidity: $${compactMoney(snapshot.liquidity_usd)}  |  💵 Price: $${priceText(snapshot.price_usd)}`,
      `🟢 Buy 30s: ${num(snapshot.buys_30s).toFixed(1)}  |  🔴 Sell 30s: ${num(snapshot.sells_30s).toFixed(1)}  |  👥 ${num(snapshot.unique_buyers_30s).toFixed(1)}`,
      '',
      `🎯 Entry ${num(snapshot.entry_score).toFixed(0)}/100  |  🚀 Moon ${num(snapshot.moon_score).toFixed(0)}/100  |  🛡️ Risk ${num(snapshot.risk_score).toFixed(0)}/100`,
      statusEn,
      safety.ok ? '' : `Waiting on: ${safety.reasons.slice(0, 3).join(' | ')}`,
      '', '📈 Performance tracking started from this signal.'
    ].filter(Boolean).join('\n');

    let message;
    const image = snapshot.raw?.imageUrl;
    const text = this.language === 'en' ? en : this.language === 'bilingual' ? `${ar}\n\n────────────\n\n${en}` : ar;
    if (image && text.length <= 1000) {
      try {
        message = await telegramApi(env.telegramBotToken, 'sendPhoto', {
          chat_id: this.chatId,
          photo: image,
          caption: text,
          reply_markup: publicLinksKeyboard(mint, safety.ok)
        });
      } catch (error) {
        console.warn('[momentum-alerts:photo]', error.message);
      }
    }
    if (!message) message = await this.send(ar, en, { reply_markup: publicLinksKeyboard(mint, safety.ok) });

    this.alerted.set(snapshot.token_id, {
      tokenId: snapshot.token_id,
      mint,
      symbol,
      rootMessageId: Number(message.message_id),
      referencePrice: num(snapshot.price_usd),
      peakReturn: 0,
      lastMilestone: 0,
      approved: safety.ok,
      startedAt: Date.now()
    });
    console.log(`[momentum-alerts] SENT mint=${mint.slice(0, 8)}… entry=${num(snapshot.entry_score).toFixed(0)} risk=${num(snapshot.risk_score).toFixed(0)} safety=${safety.ok}`);
  }

  async track(state) {
    if (Date.now() - state.startedAt > TRACK_TTL_MS) {
      this.alerted.delete(state.tokenId);
      return;
    }
    const snapshot = await this.store.latestForToken(state.tokenId);
    if (!snapshot || num(snapshot.price_usd) <= 0 || state.referencePrice <= 0) return;

    const safety = strictSafety(snapshot);
    if (!state.approved && safety.ok) {
      state.approved = true;
      await this.send(
        `✅ دخول معتمد — ${state.symbol}\n\nاكتمل فحص السكام بنجاح.\nEntry ${num(snapshot.entry_score).toFixed(0)}/100 | Risk ${num(snapshot.risk_score).toFixed(0)}/100\nيمكن استخدام زر الشراء السريع الآن.`,
        `✅ ENTRY APPROVED — ${state.symbol}\n\nStrict scam check has passed.\nEntry ${num(snapshot.entry_score).toFixed(0)}/100 | Risk ${num(snapshot.risk_score).toFixed(0)}/100\nQuick buy is now enabled.`,
        {
          reply_parameters: { message_id: state.rootMessageId, allow_sending_without_reply: true },
          reply_markup: publicLinksKeyboard(state.mint, true)
        }
      );
      console.log(`[momentum-alerts] APPROVED mint=${state.mint.slice(0, 8)}…`);
    }

    const ret = (num(snapshot.price_usd) / state.referencePrice - 1) * 100;
    if (!Number.isFinite(ret)) return;
    state.peakReturn = Math.max(state.peakReturn, ret);
    const milestone = [...MILESTONES].reverse().find((m) => ret >= m && m > state.lastMilestone);
    if (!milestone) return;
    state.lastMilestone = milestone;
    await this.send(
      `🚀 تحديث ${state.symbol} — تجاوز +${milestone}%\n\nالصعود من الإشارة: +${ret.toFixed(1)}%\nأعلى صعود: +${state.peakReturn.toFixed(1)}%\nالسعر: $${priceText(snapshot.price_usd)}\nEntry ${num(snapshot.entry_score).toFixed(0)}/100 | Risk ${num(snapshot.risk_score).toFixed(0)}/100`,
      `🚀 ${state.symbol} update — crossed +${milestone}%\n\nReturn from signal: +${ret.toFixed(1)}%\nPeak: +${state.peakReturn.toFixed(1)}%\nPrice: $${priceText(snapshot.price_usd)}\nEntry ${num(snapshot.entry_score).toFixed(0)}/100 | Risk ${num(snapshot.risk_score).toFixed(0)}/100`,
      {
        reply_parameters: { message_id: state.rootMessageId, allow_sending_without_reply: true },
        reply_markup: publicLinksKeyboard(state.mint, state.approved)
      }
    );
    console.log(`[momentum-alerts] UPDATE mint=${state.mint.slice(0, 8)}… milestone=${milestone} return=${ret.toFixed(1)}%`);
  }

  async tick() {
    if (this.running) return;
    this.running = true;
    try {
      for (const state of [...this.alerted.values()]) {
        try { await this.track(state); } catch (error) { console.error('[momentum-alerts:track]', error.message); }
      }

      const rows = await this.store.recentSnapshots();
      const latestByToken = new Map();
      for (const row of rows) if (!latestByToken.has(row.token_id)) latestByToken.set(row.token_id, row);
      const candidates = [...latestByToken.values()]
        .filter((s) => !this.alerted.has(s.token_id))
        .filter((s) => num(s.price_usd) > 0)
        .filter((s) => num(s.entry_score) >= WATCH_ENTRY_THRESHOLD)
        .filter((s) => num(s.risk_score, 100) <= 55)
        .filter(rising)
        .sort((a, b) => num(b.entry_score) - num(a.entry_score));

      for (const snapshot of candidates.slice(0, 2)) {
        try { await this.sendMomentum(snapshot); } catch (error) { console.error('[momentum-alerts:send]', error.message); }
      }
      if (candidates.length) console.log(`[momentum-alerts] candidates=${candidates.length} tracked=${this.alerted.size}`);
    } finally {
      this.running = false;
    }
  }

  async start() {
    if (!(await this.init())) return false;
    await this.tick();
    this.timer = setInterval(() => this.tick().catch((error) => console.error('[momentum-alerts]', error.message)), POLL_MS);
    return true;
  }
}

let singleton;
export async function startMomentumAlertWorker() {
  if (!singleton) singleton = new MomentumAlertWorker();
  return singleton.start();
}
