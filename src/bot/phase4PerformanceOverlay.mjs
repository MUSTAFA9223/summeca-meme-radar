import { env } from '../config/env.mjs';
import { AppSettings } from '../storage/appSettings.mjs';
import { TradingTerminal } from './tradingTerminal.mjs';

const KEY = 'wallet_performance_v1';
const settings = new AppSettings(env.supabaseUrl, env.supabaseSecretKey);
const finite = (value, fallback = 0) => Number.isFinite(Number(value)) ? Number(value) : fallback;
const short = (value) => { const s = String(value ?? ''); return s.length > 16 ? `${s.slice(0, 7)}…${s.slice(-5)}` : s; };
const money = (value) => { const n = finite(value); if (Math.abs(n) >= 1e6) return `$${(n / 1e6).toFixed(2)}M`; if (Math.abs(n) >= 1e3) return `$${(n / 1e3).toFixed(1)}K`; return `$${n.toFixed(0)}`; };

async function loadPerformance() {
  if (!settings.enabled) return null;
  try {
    const raw = await settings.get(KEY);
    const parsed = raw ? JSON.parse(String(raw)) : null;
    return parsed && Array.isArray(parsed.wallets) ? parsed : null;
  } catch { return null; }
}

function performanceView(data) {
  const wallets = data.wallets.filter((w) => finite(w.samples) > 0).slice(0, 10);
  if (!wallets.length) return null;
  const lines = [
    '🧠📈 SMART-WALLET PERFORMANCE', '',
    'هذا الترتيب يستخدم نتائج ما بعد الإشارة المسجلة فعليًا.',
    'Peak ROI = أعلى حركة وصلت لها العملة بعد الإشارة، وليس ربحًا محققًا للمحفظة.', ''
  ];
  for (const [i, w] of wallets.entries()) {
    lines.push(
      `${i + 1}. ${w.label || short(w.address)} • Score ${finite(w.performanceScore).toFixed(0)}/100`,
      `   samples ${finite(w.samples)} | avg peak ${finite(w.avgPeakRoi).toFixed(1)}% | +25 ${finite(w.hit25Rate).toFixed(0)}% | +50 ${finite(w.hit50Rate).toFixed(0)}% | +100 ${finite(w.hit100Rate).toFixed(0)}%`,
      `   verified flow ${money(w.paidUsd)} | avg entry ${finite(w.avgEntryScore).toFixed(0)} | avg risk ${finite(w.avgRisk).toFixed(0)}`
    );
  }
  lines.push('', `Updated: ${String(data.updatedAt || '').replace('T', ' ').slice(0, 19) || '—'} UTC`, '⚠️ هذا قياس تاريخي ولا يضمن تكرار الأداء مستقبلًا.');
  return {
    text: lines.join('\n'),
    keyboard: [[{ text: '📋 Orders', callback_data: 'p3:o' }, { text: '📊 Positions', callback_data: 'term:p' }], [{ text: '👛 Wallet', callback_data: 'adv:w' }]]
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
