import { env } from '../config/env.mjs';
import { AppSettings } from '../storage/appSettings.mjs';
import { TradingTerminal } from './tradingTerminal.mjs';

const KEYS = ['wallet_performance_v2', 'wallet_performance_v1'];
const settings = new AppSettings(env.supabaseUrl, env.supabaseSecretKey);
const finite = (value, fallback = 0) => Number.isFinite(Number(value)) ? Number(value) : fallback;
const short = (value) => { const s = String(value ?? ''); return s.length > 16 ? `${s.slice(0, 7)}…${s.slice(-5)}` : s; };
const money = (value) => { const n = finite(value); if (Math.abs(n) >= 1e6) return `${(n / 1e6).toFixed(2)}M`; if (Math.abs(n) >= 1e3) return `${(n / 1e3).toFixed(1)}K`; return `${n.toFixed(0)}`; };
const priceText = (value) => { const n = finite(value); if (!(n > 0)) return '—'; if (n >= 1) return `${n.toFixed(4)}`; if (n >= 0.01) return `${n.toFixed(6)}`; if (n >= 0.000001) return `${n.toFixed(9)}`; return `${n.toExponential(4)}`; };

async function loadPerformance() {
  if (!settings.enabled) return null;
  for (const key of KEYS) {
    try {
      const raw = await settings.get(key);
      const parsed = raw ? JSON.parse(String(raw)) : null;
      if (parsed && Array.isArray(parsed.wallets)) return parsed;
    } catch {}
  }
  return null;
}

export function performanceView(data) {
  const wallets = data.wallets.filter((w) => finite(w.samples) > 0).slice(0, 10);
  if (!wallets.length) return null;
  const lines = [
    '🧠📈 أداء المحافظ الذكية', '',
    'الترتيب يعطي أولوية لأداء آخر 24 ساعة ثم 7 أيام، مع الاحتفاظ بالسجل الكلي.',
    'Peak ROI = أعلى حركة وصلت إليها العملة بعد الإشارة، وليس ربحًا محققًا للمحفظة.', ''
  ];
  for (const [i, w] of wallets.entries()) {
    lines.push(
      `${i + 1}. ${w.label || short(w.address)} • الدرجة ${finite(w.performanceScore).toFixed(0)}/100`,
      `   👛 المحفظة: ${w.address || '—'}`,
      `   🔥 24h: score ${finite(w.recentScore24h).toFixed(0)} • عينات ${finite(w.samples24h)} • +50 ${finite(w.hit50Rate24h).toFixed(0)}% • avg peak ${finite(w.avgPeakRoi24h).toFixed(1)}%`,
      `   📅 7d: score ${finite(w.recentScore7d).toFixed(0)} • عينات ${finite(w.samples7d)} • +50 ${finite(w.hit50Rate7d).toFixed(0)}% • avg peak ${finite(w.avgPeakRoi7d).toFixed(1)}%`,
      `   إجمالي: عينات ${finite(w.samples)} | +25 ${finite(w.hit25Rate).toFixed(0)}% | +50 ${finite(w.hit50Rate).toFixed(0)}% | +100 ${finite(w.hit100Rate).toFixed(0)}%`,
      `   تدفق موثق ${money(w.paidUsd)} | متوسط الدخول ${finite(w.avgEntryScore).toFixed(0)} | متوسط المخاطر ${finite(w.avgRisk).toFixed(0)}`
    );
    if (w.lastTokenAddress) {
      lines.push(
        `   🪙 آخر دخول: $${w.lastTokenSymbol || 'TOKEN'}`,
        `   العقد: ${w.lastTokenAddress}`,
        `   سعر الرصد: ${priceText(w.lastDetectedPriceUsd)} • الوقت: ${String(w.lastSignalAt || '—').replace('T', ' ').replace('Z', ' UTC')}`
      );
    }
  }
  lines.push('', `آخر تحديث: ${String(data.updatedAt || '').replace('T', ' ').slice(0, 19) || '—'} UTC`, '⚠️ هذا قياس تاريخي ولا يضمن تكرار الأداء مستقبلًا.');
  return {
    text: lines.join('\n'),
    keyboard: [[{ text: '📋 الأوامر', callback_data: 'p3:o' }, { text: '📊 المراكز', callback_data: 'term:p' }], [{ text: '👛 المحفظة', callback_data: 'adv:w' }]]
  };
}

let installed = false;
export function installPhase4PerformanceOverlay() {
  if (installed) return;
  installed = true;
  const previousHandle = TradingTerminal.prototype.handle;
  TradingTerminal.prototype.handle = async function(data) {
    if (String(data ?? '') === 'p4:lb') {
      const perf = await loadPerformance();
      const view = perf ? performanceView(perf) : null;
      if (view) return { handled: true, ...view };
    }
    return previousHandle.call(this, data);
  };
  console.log('SUMMECA PHASE 4 PERFORMANCE: measured peak-outcome leaderboard overlay active');
}
