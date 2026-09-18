export const STOP_LADDER_KEY = 'terminal_stop_ladder_v1';

export const DEFAULT_STOP_LADDER_CONFIG = Object.freeze({
  initialStopLossPct: 15,
  levels: Object.freeze([
    Object.freeze({ triggerPct: 50, stopPct: 20 }),
    Object.freeze({ triggerPct: 100, stopPct: 50 }),
    Object.freeze({ triggerPct: 200, stopPct: 120 }),
    Object.freeze({ triggerPct: 300, stopPct: 200 }),
    Object.freeze({ triggerPct: 500, stopPct: 350 }),
    Object.freeze({ triggerPct: 1000, stopPct: 750 })
  ])
});

const finite = (value, fallback = 0) => Number.isFinite(Number(value)) ? Number(value) : fallback;
const clamp = (value, min, max) => Math.max(min, Math.min(max, finite(value, min)));

export function normalizeStopLadderLevels(value, fallback = DEFAULT_STOP_LADDER_CONFIG.levels) {
  let rows = value;
  if (typeof rows === 'string') {
    rows = rows.split(',').map((part) => {
      const [trigger, stop] = part.trim().split(':');
      return { triggerPct: Number(trigger), stopPct: Number(stop) };
    });
  }
  if (!Array.isArray(rows)) rows = fallback;
  const unique = new Map();
  for (const row of rows) {
    const triggerPct = clamp(row?.triggerPct, 5, 5000);
    const stopPct = clamp(row?.stopPct, 0, 4999);
    if (!(triggerPct > 0) || !(stopPct >= 0) || stopPct >= triggerPct) continue;
    unique.set(triggerPct, { triggerPct, stopPct });
  }
  const result = [...unique.values()].sort((a, b) => a.triggerPct - b.triggerPct);
  return result.length ? result.slice(0, 12) : [...fallback].map((row) => ({ ...row }));
}

export function normalizeStopLadderConfig(value, fallback = DEFAULT_STOP_LADDER_CONFIG) {
  let source = value;
  if (typeof source === 'string') {
    try { source = JSON.parse(source); } catch { source = null; }
  }
  if (!source || typeof source !== 'object') source = fallback;
  return {
    initialStopLossPct: clamp(source.initialStopLossPct ?? fallback.initialStopLossPct, 2, 60),
    levels: normalizeStopLadderLevels(source.levels, fallback.levels)
  };
}

export function parseStopLadderInput(text) {
  const raw = String(text || '').trim();
  if (!raw) throw new Error('الإعداد فارغ');
  const parts = raw.split(';').map((item) => item.trim()).filter(Boolean);
  let initialStopLossPct = DEFAULT_STOP_LADDER_CONFIG.initialStopLossPct;
  let ladderText = '';
  for (const part of parts) {
    const sl = part.match(/^(?:sl|stoploss|وقف|ستوب)s*=s*([0-9]+(?:.[0-9]+)?)$/i);
    if (sl) {
      initialStopLossPct = Number(sl[1]);
      continue;
    }
    ladderText = ladderText ? `${ladderText},${part}` : part;
  }
  const levels = normalizeStopLadderLevels(ladderText || raw);
  if (!levels.length) throw new Error('صيغة السلم غير صالحة');
  return normalizeStopLadderConfig({ initialStopLossPct, levels });
}

export function stopFloorForHighWater(highWaterPnlPct, config = DEFAULT_STOP_LADDER_CONFIG) {
  const normalized = normalizeStopLadderConfig(config);
  const high = finite(highWaterPnlPct);
  let floor = null;
  let trigger = null;
  for (const row of normalized.levels) {
    if (high >= row.triggerPct) {
      floor = row.stopPct;
      trigger = row.triggerPct;
    }
  }
  return { floorPct: floor, triggerPct: trigger };
}

export function formatStopLadder(config = DEFAULT_STOP_LADDER_CONFIG) {
  const normalized = normalizeStopLadderConfig(config);
  return [
    `وقف الخسارة الأولي: -${normalized.initialStopLossPct}%`,
    ...normalized.levels.map((row) => `عند +${row.triggerPct}% ← الوقف يصبح +${row.stopPct}%`)
  ];
}
