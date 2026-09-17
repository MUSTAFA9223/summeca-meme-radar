import { TradingTerminal, normalizeTerminalNetwork, isTerminalAddress } from './tradingTerminal.mjs';

const ORDERS_KEY = 'terminal_paper_orders_v1';
const finite = (value, fallback = 0) => Number.isFinite(Number(value)) ? Number(value) : fallback;

async function loadOrders(instance) {
  if (!instance?.settings?.enabled) return [];
  try {
    const raw = await instance.settings.get(ORDERS_KEY);
    const rows = raw ? JSON.parse(String(raw)) : [];
    return Array.isArray(rows) ? rows : [];
  } catch { return []; }
}

async function saveOrders(instance, rows) {
  if (instance?.settings?.enabled) await instance.settings.set(ORDERS_KEY, JSON.stringify(rows.slice(0, 80))).catch(() => {});
}

function orderToken(id) {
  let hash = 2166136261;
  for (const char of String(id ?? '')) {
    hash ^= char.charCodeAt(0);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(36);
}

async function cancelOrderByToken(instance, token) {
  const orders = await loadOrders(instance);
  const order = orders.find((row) => row.status === 'open' && orderToken(row.id) === String(token));
  if (!order) {
    return { text: 'ℹ️ الأمر غير موجود أو تم إغلاقه.', keyboard: [[{ text: '📋 Orders', callback_data: 'p3:o' }]] };
  }
  order.status = 'cancelled';
  order.cancelledAt = new Date().toISOString();
  await saveOrders(instance, orders);
  return {
    text: `✅ تم إلغاء Paper ${String(order.type || 'order').toUpperCase()} لـ $${order.symbol || 'TOKEN'}.`,
    keyboard: [[{ text: '📋 Orders', callback_data: 'p3:o' }, { text: '📊 Positions', callback_data: 'term:p' }]]
  };
}

function compactOrderCallbacks(result) {
  if (!Array.isArray(result?.keyboard)) return result;
  result.keyboard = result.keyboard.map((row) => (Array.isArray(row) ? row.map((button) => {
    const data = String(button?.callback_data ?? '');
    if (!data.startsWith('p3:oc:')) return button;
    let id = data.slice('p3:oc:'.length);
    try { id = decodeURIComponent(id); } catch {}
    return { ...button, callback_data: `p3:cx:${orderToken(id)}` };
  }) : row));
  return result;
}

async function createDcaCompat(instance, totalUsd, installments, intervalMin, network, address) {
  const key = normalizeTerminalNetwork(network);
  const total = Math.max(1, Math.min(5_000, finite(totalUsd)));
  const count = Math.max(2, Math.min(12, Math.floor(finite(installments))));
  const minutes = Math.max(1, Math.min(240, finite(intervalMin)));
  if (!isTerminalAddress(key, address)) return { text: '❌ عقد غير صالح.', keyboard: [] };
  const orders = await loadOrders(instance);
  const order = {
    id: `dca:${Date.now().toString(36)}:${key}:${String(address).toLowerCase()}`,
    type: 'dca', status: 'open', network: key, address, symbol: 'TOKEN',
    totalUsd: total, installments: count, filled: 0, amountPerFill: total / count,
    intervalMs: minutes * 60_000, nextAt: Date.now(), createdAt: new Date().toISOString()
  };
  orders.unshift(order);
  await saveOrders(instance, orders);
  return {
    text: [
      '✅ PAPER DCA CREATED', '',
      `الإجمالي: $${total.toFixed(2)}`,
      `الدفعات: ${count} × $${order.amountPerFill.toFixed(2)}`,
      `الفاصل: ${minutes} دقيقة`,
      '',
      '🤖 أول دفعة ستنفذ في دورة المراقبة القادمة بعد توفر سعر سوق موثوق.',
      '🧪 Paper فقط — لا توجد معاملة حقيقية.'
    ].join('\n'),
    keyboard: [[{ text: '📋 Orders', callback_data: 'p3:o' }, { text: '📊 Positions', callback_data: 'term:p' }]]
  };
}

let installed = false;
export function installPhase3Compat() {
  if (installed) return;
  installed = true;

  const previousHandle = TradingTerminal.prototype.handle;
  TradingTerminal.prototype.handle = async function(data) {
    const value = String(data ?? '');

    if (value === 'p3:o') {
      const result = await previousHandle.call(this, data);
      return compactOrderCallbacks(result);
    }

    if (value.startsWith('p3:cx:')) {
      return { handled: true, ...(await cancelOrderByToken(this, value.slice('p3:cx:'.length))) };
    }

    if (value.startsWith('p3:dc:')) {
      const parts = value.split(':');
      if (parts.length >= 7) {
        try {
          return { handled: true, ...(await createDcaCompat(this, parts[2], parts[3], parts[4], parts[5], parts.slice(6).join(':'))) };
        } catch (error) {
          return { handled: true, text: `❌ DCA error: ${String(error?.message ?? error).slice(0, 160)}`, keyboard: [[{ text: '📋 Orders', callback_data: 'p3:o' }]] };
        }
      }
    }
    return previousHandle.call(this, data);
  };

  const previousPositions = TradingTerminal.prototype.positions;
  TradingTerminal.prototype.positions = async function() {
    const result = await previousPositions.call(this);
    if (result?.keyboard) {
      const hasP3 = result.keyboard.some((row) => row.some((button) => String(button?.callback_data ?? '').startsWith('p3:')));
      if (!hasP3) result.keyboard.push([{ text: '📋 Orders', callback_data: 'p3:o' }, { text: '🧠 Copy Dashboard', callback_data: 'p3:c' }]);
    }
    return result;
  };

  console.log('SUMMECA PHASE 3 COMPAT: DCA callbacks + compact Order cancel + Orders/Copy navigation fixed');
}
