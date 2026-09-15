import { TelegramController } from './bot/telegramController.mjs';
import { env } from './config/env.mjs';
import { evaluateSignalSafety } from './core/safetyGate.mjs';
import { scoreToken } from './core/scoring.mjs';
import { enrichTokenSnapshot, fetchNewListings } from './feeds/birdeye.mjs';
import { fetchDexScreenerSnapshot, fetchDexScreenerSnapshots } from './feeds/dexscreener.mjs';
import { demoSnapshots } from './feeds/demo.mjs';
import { HeliusProgramStream } from './feeds/heliusWs.mjs';
import { discoverPrivateStartChat, TelegramNotifier, telegramApi } from './notifiers/telegram.mjs';
import { SignalTracker } from './signals/signalTracker.mjs';
import { AppSettings } from './storage/appSettings.mjs';
import { SupabaseStore } from './storage/supabaseStore.mjs';
import { PaperTrader } from './trading/paperTrader.mjs';

const store = new SupabaseStore(env.supabaseUrl, env.supabaseSecretKey);
const appSettings = new AppSettings(env.supabaseUrl, env.supabaseSecretKey);
const SOLANA_ADDRESS = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
const WATCH_POOL_SIZE = 20;

async function resolveTelegramChatId() {
  if (env.telegramChatId) return env.telegramChatId;
  if (!env.telegramBotToken) return '';

  if (appSettings.enabled) {
    try {
      const saved = await appSettings.get('telegram_chat_id');
      if (saved) return saved;
    } catch (error) {
      console.error('[telegram:settings-read]', error.message);
    }
  }

  try {
    const discovered = await discoverPrivateStartChat(env.telegramBotToken);
    if (appSettings.enabled) {
      try {
        await appSettings.set('telegram_chat_id', discovered);
      } catch (error) {
        console.error('[telegram:settings-write]', error.message);
      }
    }
    console.log('[telegram] private chat linked');
    return discovered;
  } catch (error) {
    console.warn('[telegram] alerts not linked yet:', error.message);
    return '';
  }
}

const runtime = {
  language: env.telegramLanguage,
  alertsEnabled: true,
  scannerPaused: false,
  walletAddress: '',
  recentCreates: []
};

if (appSettings.enabled) {
  try {
    const [language, alerts, paused, wallet] = await Promise.all([
      appSettings.get('telegram_language'),
      appSettings.get('alerts_enabled'),
      appSettings.get('scanner_paused'),
      appSettings.get('wallet_address')
    ]);
    if (['ar', 'en', 'bilingual'].includes(String(language))) runtime.language = String(language);
    if (alerts != null) runtime.alertsEnabled = String(alerts) !== 'false';
    if (paused != null) runtime.scannerPaused = String(paused) === 'true';
    if (wallet) runtime.walletAddress = String(wallet);
  } catch (error) {
    console.error('[runtime:settings-read]', error.message);
  }
}

const telegramChatId = await resolveTelegramChatId();
const telegram = new TelegramNotifier(env.telegramBotToken, telegramChatId, runtime.language);
const signalTracker = new SignalTracker({ ttlMs: 6 * 60 * 60 * 1000 });
const trader = new PaperTrader({
  startingUsd: env.paperStartingUsd,
  tradeSizeUsd: env.paperTradeSizeUsd,
  maxOpen: env.maxOpenPositions,
  stopLossPct: env.paperStopLossPct,
  peakHunterStartPct: env.peakHunterStartPct
});

const candidates = new Map();
const securityChecked = new Set();
const emergencyNotified = new Set();
const pendingPaperBuys = new Map();
const PAPER_BUY_TTL_MS = 3 * 60 * 1000;
let ticking = false;
let lastHeliusTriggerAt = 0;
let heliusStream = null;

function paperSizeLabel(mode, value) {
  return mode === 'percent' ? `${Number(value)}%` : `$${Number(value).toFixed(2)}`;
}

function minimalCandidate(address, observedAt = Date.now()) {
  return {
    address,
    symbol: 'NEW',
    name: 'New Pump.fun coin',
    source: 'pump_fun_direct',
    observedAt,
    listedAt: observedAt,
    priceUsd: 0,
    liquidityUsd: 0,
    directCreate: true
  };
}

function recordRecentCreate(event) {
  const address = String(event?.mint ?? '').trim();
  if (!SOLANA_ADDRESS.test(address)) return;
  const createdAt = Number(event.observedAt ?? Date.now());
  const candidate = {
    ...minimalCandidate(address, createdAt),
    createSignature: event.signature ?? '',
    slot: event.slot ?? null
  };
  candidates.set(address, { ...candidates.get(address), ...candidate });
  runtime.recentCreates = [candidate, ...runtime.recentCreates.filter((item) => item.address !== address)].slice(0, 50);
  console.log(`[new-coins] stored mint=${address.slice(0, 8)}… (push alert hidden)`);
}

function isRisingMomentum(snapshot) {
  const buys = Number(snapshot?.buys30s ?? 0);
  const sells = Number(snapshot?.sells30s ?? 0);
  const buySell = buys / Math.max(1, sells);
  const price5 = Number(snapshot?.priceChange5mPct ?? 0);
  const volume5 = Number(snapshot?.volume5mUsd ?? 0);
  const buyerAcceleration = Number(snapshot?.buyerAcceleration ?? 0);
  const volumeAcceleration = Number(snapshot?.volumeAcceleration ?? 0);

  if (Number.isFinite(price5) && price5 >= 5) return true;
  if (buySell >= 1.8 && buys >= 4 && volume5 >= 2_000) return true;
  if (buyerAcceleration >= 1.5 && volumeAcceleration >= 1.5 && buySell >= 1.25) return true;
  return false;
}

function momentumRank(snapshot) {
  const buys = Math.max(0, Number(snapshot?.buys30s ?? 0));
  const sells = Math.max(0, Number(snapshot?.sells30s ?? 0));
  const ratio = buys / Math.max(1, sells);
  const price5 = Number(snapshot?.priceChange5mPct ?? 0);
  const volume5 = Math.max(0, Number(snapshot?.volume5mUsd ?? 0));
  const liquidity = Math.max(0, Number(snapshot?.liquidityUsd ?? 0));
  const acceleration = Math.max(0, Number(snapshot?.buyerAcceleration ?? 0)) + Math.max(0, Number(snapshot?.volumeAcceleration ?? 0));
  return Math.max(-20, Math.min(60, price5)) * 3
    + Math.min(60, buys * 3)
    + Math.min(35, ratio * 7)
    + Math.min(45, Math.log10(volume5 + 1) * 10)
    + Math.min(25, Math.log10(liquidity + 1) * 4)
    + Math.min(30, acceleration * 5);
}

function hasSecurityEvidence(snapshot) {
  return typeof snapshot?.honeypot === 'boolean'
    || typeof snapshot?.mintAuthorityDisabled === 'boolean'
    || typeof snapshot?.freezeAuthorityDisabled === 'boolean'
    || Number(snapshot?.top10HolderPct ?? 0) > 0
    || Number(snapshot?.creatorPct ?? 0) > 0;
}

function hasVerifiedMarketActivity(snapshot) {
  const price = Number(snapshot?.priceUsd ?? 0);
  const trades = Number(snapshot?.buys30s ?? 0) + Number(snapshot?.sells30s ?? 0);
  const volume5m = Number(snapshot?.volume5mUsd ?? 0);
  return Number.isFinite(price) && price > 0 && (trades > 0 || volume5m > 0);
}

function isEarlyPumpMarket(snapshot) {
  const source = String(snapshot?.source ?? '').toLowerCase();
  return source.includes('pump') && hasVerifiedMarketActivity(snapshot);
}

async function notifyEmergencyRisk(snapshot, scores, safety, thread) {
  const address = String(snapshot?.address ?? '');
  if (!address || emergencyNotified.has(address)) return;
  emergencyNotified.add(address);

  const reasons = safety.emergencyReasons.length ? safety.emergencyReasons : safety.reasons;
  const ar = [
    `🚨 طوارئ مخاطرة — ${snapshot.symbol ?? 'TOKEN'}`,
    '',
    'تم منع أي دخول جديد على هذه العملة، لكن متابعة الزخم والأداء ستستمر.',
    `الأسباب: ${reasons.join(' | ')}`,
    `Risk: ${scores.risk}/100`,
    Number(snapshot.priceUsd) > 0 ? `السعر الحالي: $${snapshot.priceUsd}` : '',
    Number(snapshot.liquidityUsd) >= 0 ? `السيولة الحالية: $${Number(snapshot.liquidityUsd).toFixed(2)}` : '',
    '',
    '⛔ لا دخول حقيقي جديد. 👀 المتابعة التحليلية مستمرة.'
  ].filter(Boolean).join('\n');
  const en = [
    `🚨 RISK EMERGENCY — ${snapshot.symbol ?? 'TOKEN'}`,
    '',
    'New entry is blocked, but momentum and performance tracking will continue.',
    `Reasons: ${reasons.join(' | ')}`,
    `Risk: ${scores.risk}/100`,
    Number(snapshot.priceUsd) > 0 ? `Current price: $${snapshot.priceUsd}` : '',
    Number(snapshot.liquidityUsd) >= 0 ? `Current liquidity: $${Number(snapshot.liquidityUsd).toFixed(2)}` : '',
    '',
    '⛔ No new live entry. 👀 Analytical tracking continues.'
  ].filter(Boolean).join('\n');
  const body = {
    chat_id: telegramChatId,
    text: runtime.language === 'en' ? en : runtime.language === 'bilingual' ? `${ar}\n\n────────────\n\n${en}` : ar,
    ...(thread?.rootMessageId ? {
      reply_parameters: { message_id: Number(thread.rootMessageId), allow_sending_without_reply: true }
    } : {})
  };
  if (runtime.alertsEnabled && env.telegramBotToken && telegramChatId) {
    await telegramApi(env.telegramBotToken, 'sendMessage', body).catch((error) => console.error('[telegram:emergency-risk]', error.message));
  }

  if (thread && store.enabled) {
    try {
      await store.updateSignalThread(thread, {
        referencePriceUsd: thread.referencePriceUsd,
        peakPriceUsd: thread.peakPriceUsd,
        peakReturnPct: thread.peakReturnPct,
        lastMilestonePct: thread.lastMilestonePct,
        lastUpdateAt: snapshot.observedAt,
        active: true
      });
    } catch (error) {
      console.error('[supabase:emergency-thread-continue]', address, error.message);
    }
  }
  console.warn(`[safety:emergency] entry blocked; tracking continues mint=${address.slice(0, 8)}… reasons=${reasons.join('; ')}`);
}

async function notifyTrackedSafetyUpdate(snapshot, scores, safety, event) {
  if (!runtime.alertsEnabled || !env.telegramBotToken || !telegramChatId || !event?.thread?.rootMessageId) return null;
  const returnPct = Number(event.returnPct ?? 0);
  const peakReturnPct = Number(event.peakReturnPct ?? event.thread.peakReturnPct ?? 0);
  const price = Number(event.priceUsd ?? snapshot.priceUsd ?? 0);
  const statusAr = safety.status === 'dangerous'
    ? `⛔ خطر مؤكد — متابعة فقط\n${safety.dangerReasons.slice(0, 3).join(' | ')}`
    : `⚠️ الأمان قيد التحقق — لا دخول حقيقي\n${safety.pendingReasons.slice(0, 3).join(' | ')}`;
  const statusEn = safety.status === 'dangerous'
    ? `⛔ Confirmed risk — tracking only\n${safety.dangerReasons.slice(0, 3).join(' | ')}`
    : `⚠️ Safety pending — no live entry\n${safety.pendingReasons.slice(0, 3).join(' | ')}`;
  const milestone = event.type === 'milestone' ? `+${event.milestonePct}%` : 'tracking';
  const ar = [
    `📈 تحديث متابعة $${snapshot.symbol ?? 'TOKEN'} — ${milestone}`,
    '',
    `الصعود من الإشارة: ${returnPct >= 0 ? '+' : ''}${returnPct.toFixed(1)}%`,
    `أعلى صعود: ${peakReturnPct >= 0 ? '+' : ''}${peakReturnPct.toFixed(1)}%`,
    price > 0 ? `السعر: $${price}` : '',
    `Momentum/Entry: ${scores.entry}/100 | Risk: ${scores.risk}/100`,
    `🟢 شراء 30ث: ${Number(snapshot.buys30s ?? 0).toFixed(1)} | 🔴 بيع: ${Number(snapshot.sells30s ?? 0).toFixed(1)}`,
    '',
    statusAr
  ].filter(Boolean).join('\n');
  const en = [
    `📈 $${snapshot.symbol ?? 'TOKEN'} tracking update — ${milestone}`,
    '',
    `Return from signal: ${returnPct >= 0 ? '+' : ''}${returnPct.toFixed(1)}%`,
    `Peak: ${peakReturnPct >= 0 ? '+' : ''}${peakReturnPct.toFixed(1)}%`,
    price > 0 ? `Price: $${price}` : '',
    `Entry: ${scores.entry}/100 | Risk: ${scores.risk}/100`,
    `🟢 Buys 30s: ${Number(snapshot.buys30s ?? 0).toFixed(1)} | 🔴 Sells: ${Number(snapshot.sells30s ?? 0).toFixed(1)}`,
    '',
    statusEn
  ].filter(Boolean).join('\n');
  return telegramApi(env.telegramBotToken, 'sendMessage', {
    chat_id: telegramChatId,
    text: runtime.language === 'en' ? en : runtime.language === 'bilingual' ? `${ar}\n\n────────────\n\n${en}` : ar,
    reply_parameters: { message_id: Number(event.thread.rootMessageId), allow_sending_without_reply: true }
  }).catch((error) => console.error('[telegram:tracked-safety-update]', error.message));
}

async function notifyQueuedPaperFill(position, intent, warnings = []) {
  if (!env.telegramBotToken || !telegramChatId) return;
  const warningText = warnings.length ? `\n⚠️ ${warnings.join('، ')}` : '';
  const ar = [
    '✅ تم تنفيذ طلب الدخول التجريبي المعلق', '',
    `${position.symbol ?? 'TOKEN'}`,
    `الحجم المختار: ${paperSizeLabel(intent.mode, intent.value)}`,
    `المبلغ المنفذ: $${Number(position.usdSize).toFixed(2)}`,
    `السعر: ${position.entryPriceUsd}`,
    'الستوب: -10%',
    'حماية الربح: تستهدف +20% بعد بلوغ +30%',
    warningText
  ].filter(Boolean).join('\n');
  const en = [
    '✅ Queued PAPER entry filled', '',
    `${position.symbol ?? 'TOKEN'}`,
    `Selected size: ${paperSizeLabel(intent.mode, intent.value)}`,
    `Filled amount: $${Number(position.usdSize).toFixed(2)}`,
    `Price: ${position.entryPriceUsd}`,
    'Stop: -10%',
    'Profit lock: targets +20% after reaching +30%',
    warningText
  ].filter(Boolean).join('\n');
  const text = runtime.language === 'en' ? en : runtime.language === 'bilingual' ? `${ar}\n\n────────────\n\n${en}` : ar;
  await telegramApi(env.telegramBotToken, 'sendMessage', { chat_id: telegramChatId, text }).catch((error) => {
    console.error('[telegram:paper-fill]', error.message);
  });
}

async function requestPaperBuy({ address, mode, value }) {
  const mint = String(address ?? '').trim();
  const sizeMode = mode === 'percent' ? 'percent' : 'usd';
  const sizeValue = Number(value);
  if (!SOLANA_ADDRESS.test(mint)) return { status: 'rejected', reason: 'invalid-token-address' };
  if (!Number.isFinite(sizeValue) || sizeValue <= 0) return { status: 'rejected', reason: 'invalid-size' };
  if (sizeMode === 'percent' && sizeValue > 100) return { status: 'rejected', reason: 'percentage-over-100' };
  if (trader.openPositions.some((p) => p.address === mint)) return { status: 'rejected', reason: 'position-already-open' };

  const current = candidates.get(mint) ?? minimalCandidate(mint);
  candidates.set(mint, current);

  if (Number(current.priceUsd) > 0) {
    const scores = scoreToken(current);
    const result = trader.enterManual(current, scores, { mode: sizeMode, value: sizeValue });
    if (!result.ok) return { status: 'rejected', reason: result.reason };
    const refs = await persistSnapshot(current, scores);
    await persistEntry(current, scores, result.position, refs);
    return {
      status: 'filled',
      position: result.position,
      warnings: scores.blockers ?? [],
      availableUsd: trader.availableUsd
    };
  }

  pendingPaperBuys.set(mint, { mode: sizeMode, value: sizeValue, createdAt: Date.now() });
  void tick('telegram-paper-buy').catch((error) => console.error('[paper-buy-trigger]', error.message));
  return {
    status: 'queued',
    address: mint,
    size: paperSizeLabel(sizeMode, sizeValue),
    availableUsd: trader.availableUsd
  };
}

async function requestPaperSell({ address, percent }) {
  const mint = String(address ?? '').trim();
  const sellPct = Number(percent);
  if (!SOLANA_ADDRESS.test(mint)) return { status: 'rejected', reason: 'invalid-token-address' };
  if (![25, 50, 100].includes(sellPct)) return { status: 'rejected', reason: 'invalid-sell-percent' };

  const current = candidates.get(mint);
  if (!current) return { status: 'rejected', reason: 'market-snapshot-unavailable' };
  if (!(Number(current.priceUsd) > 0)) return { status: 'rejected', reason: 'price-unavailable' };

  const scores = scoreToken(current);
  const result = trader.manualSell(current, sellPct);
  if (!result.ok) return { status: 'rejected', reason: result.reason };

  const refs = await persistSnapshot(current, scores);
  if (result.closed) {
    await persistExit(current, scores, result.position, refs);
  } else if (store.enabled && refs?.tokenId) {
    try {
      await store.saveSignal({
        tokenId: refs.tokenId,
        snapshotId: refs.snapshotId,
        type: 'partial_exit',
        scores,
        reason: {
          trigger: 'telegram-manual-paper-sell',
          sellPct: result.sellPct,
          priceUsd: current.priceUsd,
          legPnlUsd: result.legPnlUsd,
          legPnlPct: result.legPnlPct,
          remainingUsdSize: result.remainingUsdSize
        }
      });
      await store.updateOpenPaperTrade(current, result.position);
    } catch (error) {
      console.error('[supabase:partial-exit]', mint, error.message);
    }
  }

  return {
    status: 'sold',
    closed: result.closed,
    symbol: result.position?.symbol ?? current.symbol,
    sellPct: result.sellPct,
    priceUsd: Number(current.priceUsd),
    legPnlUsd: result.legPnlUsd,
    legPnlPct: result.legPnlPct,
    totalPnlPct: result.position?.pnlPct ?? null,
    remainingUsdSize: result.remainingUsdSize,
    availableUsd: trader.availableUsd
  };
}

const telegramController = new TelegramController({
  token: env.telegramBotToken,
  chatId: telegramChatId,
  notifier: telegram,
  settings: appSettings,
  store,
  runtime,
  heliusApiKey: env.heliusApiKey,
  onPaperBuy: requestPaperBuy,
  onPaperSell: requestPaperSell,
  getRecentCreates: () => runtime.recentCreates
});

function prunePaperBuys() {
  const now = Date.now();
  for (const [address, intent] of pendingPaperBuys) {
    if (now - Number(intent.createdAt ?? 0) > PAPER_BUY_TTL_MS) {
      pendingPaperBuys.delete(address);
      console.warn(`[paper-buy] expired pending intent mint=${address.slice(0, 8)}…`);
    }
  }
}

if (store.enabled && telegramChatId) {
  try {
    const restored = signalTracker.restore(await store.listActiveSignalThreads(telegramChatId));
    for (const thread of restored) {
      candidates.set(thread.address, {
        address: thread.address,
        symbol: thread.symbol,
        name: thread.name,
        imageUrl: thread.imageUrl,
        source: 'tracked_signal',
        listedAt: thread.startedAt,
        observedAt: Date.now(),
        priceUsd: thread.referencePriceUsd ?? 0,
        liquidityUsd: 0
      });
    }
    if (restored.length) console.log(`[signal-tracker] restored ${restored.length} active thread(s)`);
  } catch (error) {
    console.error('[signal-tracker:restore]', error.message);
  }
}

if (store.enabled) {
  try {
    const [openTrades, closedRealizedPnlUsd] = await Promise.all([
      store.listOpenPaperTrades(Math.max(10, env.maxOpenPositions * 4)),
      store.paperRealizedPnlUsd()
    ]);
    trader.setRealizedPnlUsd(closedRealizedPnlUsd);

    let restoredCount = 0;
    for (const row of openTrades) {
      if (restoredCount >= env.maxOpenPositions) break;
      const result = trader.restoreOpenPosition(row);
      if (!result.ok) {
        console.warn(`[paper-trader:restore] skipped id=${row?.id ?? 'unknown'} reason=${result.reason}`);
        continue;
      }

      const position = result.position;
      const token = row.tokens ?? {};
      store.bindPaperTrade(position.address, row.id);
      const openedAt = Date.parse(String(row.opened_at ?? ''));
      const listedAt = Date.parse(String(token.listed_at ?? ''));
      candidates.set(position.address, {
        ...minimalCandidate(position.address, Number.isFinite(openedAt) ? openedAt : Date.now()),
        symbol: token.symbol ?? position.symbol ?? 'TOKEN',
        name: token.name ?? token.symbol ?? position.symbol ?? 'Restored paper position',
        source: token.source ?? 'restored_paper_trade',
        listedAt: Number.isFinite(listedAt) ? listedAt : (Number.isFinite(openedAt) ? openedAt : Date.now()),
        observedAt: Date.now(),
        priceUsd: Number(row.entry_price_usd ?? position.entryPriceUsd ?? 0),
        liquidityUsd: 0,
        restoredPaperTrade: true
      });
      restoredCount += 1;
    }

    if (openTrades.length > restoredCount) {
      console.warn(`[paper-trader:restore] ${openTrades.length - restoredCount} persisted open trade(s) exceed MAX_OPEN_POSITIONS or were invalid`);
    }
    console.log(`[paper-trader] restored=${restoredCount} closedRealizedPnlUsd=${Number(closedRealizedPnlUsd).toFixed(2)} availableUsd=${trader.availableUsd.toFixed(2)}`);
  } catch (error) {
    console.error('[paper-trader:restore]', error.message);
  }
}

const ageSeconds = (s) => {
  const listedAt = Number(s?.listedAt);
  if (!Number.isFinite(listedAt) || listedAt <= 0) return 0;
  return Math.max(0, (Date.now() - listedAt) / 1000);
};

async function persistSnapshot(snapshot, scores) {
  if (!store.enabled) return null;
  try {
    return await store.saveSnapshot(snapshot, scores);
  } catch (error) {
    console.error('[supabase:snapshot]', snapshot.address, error.message);
    return null;
  }
}

async function persistEntry(snapshot, scores, position, refs) {
  if (!store.enabled || !position || !refs?.tokenId) return;
  try {
    await store.saveSignal({
      tokenId: refs.tokenId,
      snapshotId: refs.snapshotId,
      type: 'entry',
      scores,
      reason: {
        trigger: position.manual ? 'telegram-manual-paper-entry' : 'paper-entry',
        blockers: scores.blockers ?? [],
        sizing: position.sizing ?? null
      }
    });
    await store.openPaperTrade(snapshot, scores, position, refs.tokenId);
  } catch (error) {
    console.error('[supabase:entry]', snapshot.address, error.message);
  }
}

async function persistWatchSignal(snapshot, scores, refs, safety) {
  if (!store.enabled || !refs?.tokenId) return;
  try {
    await store.saveSignal({
      tokenId: refs.tokenId,
      snapshotId: refs.snapshotId,
      type: 'watch',
      scores,
      reason: {
        trigger: safety?.ok ? 'telegram-rising-momentum-signal' : 'telegram-rising-momentum-pending-safety',
        safetyStatus: safety?.status ?? 'unknown',
        priceAvailable: Number(snapshot.priceUsd) > 0,
        priceChange5mPct: snapshot.priceChange5mPct ?? null,
        buyers30s: snapshot.buys30s ?? 0,
        sells30s: snapshot.sells30s ?? 0,
        securityVerified: snapshot.securityVerified === true,
        marketDataVerified: snapshot.marketDataVerified === true
      }
    });
  } catch (error) {
    console.error('[supabase:watch-signal]', snapshot.address, error.message);
  }
}

async function persistExit(snapshot, scores, position, refs) {
  if (!store.enabled || !position) return;
  try {
    if (refs?.tokenId) {
      await store.saveSignal({
        tokenId: refs.tokenId,
        snapshotId: refs.snapshotId,
        type: 'exit',
        scores,
        reason: { exitReason: position.exitReason ?? null, pnlPct: position.pnlPct ?? null }
      });
    }
    await store.closePaperTrade(snapshot, scores, position);
  } catch (error) {
    console.error('[supabase:exit]', snapshot.address, error.message);
  }
}

async function persistTrackingEvent(snapshot, scores, refs, event) {
  if (!event?.thread) return;
  if (store.enabled) {
    try {
      await store.updateSignalThread(event.thread, {
        referencePriceUsd: event.thread.referencePriceUsd,
        peakPriceUsd: event.thread.peakPriceUsd,
        peakReturnPct: event.thread.peakReturnPct,
        lastMilestonePct: event.thread.lastMilestonePct,
        lastUpdateAt: snapshot.observedAt,
        active: event.type !== 'expired'
      });
      if (event.type === 'milestone' && refs?.tokenId) {
        await store.saveSignal({
          tokenId: refs.tokenId,
          snapshotId: refs.snapshotId,
          type: 'moon',
          scores,
          reason: {
            milestonePct: event.milestonePct,
            returnPct: event.returnPct,
            peakReturnPct: event.peakReturnPct
          }
        });
      }
    } catch (error) {
      console.error('[supabase:signal-thread]', snapshot.address, error.message);
    }
  }
}

async function startSignalThread(snapshot, scores, refs, paperPosition, safety) {
  if (!runtime.alertsEnabled || signalTracker.has(snapshot.address)) return null;

  let message = null;
  if (safety?.ok) {
    message = await telegram.signal(snapshot, scores, paperPosition ?? undefined);
  } else if (telegram.enabled && env.telegramBotToken && telegramChatId) {
    const ratio = Number(snapshot.buys30s ?? 0) / Math.max(1, Number(snapshot.sells30s ?? 0));
    const ar = [
      '⚡ SUMMECA EARLY MOMENTUM — الأمان قيد التحقق', '',
      `$${snapshot.symbol ?? 'TOKEN'} • ${snapshot.name ?? snapshot.symbol ?? 'Token'}`,
      `CA: ${snapshot.address}`, '',
      `MC: $${Math.round(Number(snapshot.marketCapUsd ?? 0)).toLocaleString('en-US')} | Vol 5m: $${Math.round(Number(snapshot.volume5mUsd ?? 0)).toLocaleString('en-US')}`,
      `💧 Liquidity: $${Math.round(Number(snapshot.liquidityUsd ?? 0)).toLocaleString('en-US')} | Price: $${snapshot.priceUsd ?? '—'}`,
      `🟢 شراء 30ث: ${Number(snapshot.buys30s ?? 0).toFixed(1)} | 🔴 بيع: ${Number(snapshot.sells30s ?? 0).toFixed(1)} | Ratio ${ratio.toFixed(2)}x`,
      `🎯 Entry ${scores.entry}/100 | 🚀 Moon ${scores.moon}/100 | 🛡️ Risk ${scores.risk}/100`, '',
      '⚠️ لم يثبت خطر مؤكد، لكن فحص الأمان لم يكتمل بعد.',
      `الناقص: ${(safety?.pendingReasons ?? safety?.reasons ?? []).slice(0, 4).join(' | ')}`,
      '👀 بدأت متابعة الأداء الآن. لا يوجد دخول حقيقي حتى نجاح بوابة الأمان.'
    ].join('\n');
    const en = [
      '⚡ SUMMECA EARLY MOMENTUM — SAFETY PENDING', '',
      `$${snapshot.symbol ?? 'TOKEN'} • ${snapshot.name ?? snapshot.symbol ?? 'Token'}`,
      `CA: ${snapshot.address}`, '',
      `MC: $${Math.round(Number(snapshot.marketCapUsd ?? 0)).toLocaleString('en-US')} | Vol 5m: $${Math.round(Number(snapshot.volume5mUsd ?? 0)).toLocaleString('en-US')}`,
      `💧 Liquidity: $${Math.round(Number(snapshot.liquidityUsd ?? 0)).toLocaleString('en-US')} | Price: $${snapshot.priceUsd ?? '—'}`,
      `🟢 Buys 30s: ${Number(snapshot.buys30s ?? 0).toFixed(1)} | 🔴 Sells: ${Number(snapshot.sells30s ?? 0).toFixed(1)} | Ratio ${ratio.toFixed(2)}x`,
      `🎯 Entry ${scores.entry}/100 | 🚀 Moon ${scores.moon}/100 | 🛡️ Risk ${scores.risk}/100`, '',
      '⚠️ No confirmed danger was found, but the safety check is incomplete.',
      `Pending: ${(safety?.pendingReasons ?? safety?.reasons ?? []).slice(0, 4).join(' | ')}`,
      '👀 Performance tracking starts now. No live entry until the strict safety gate passes.'
    ].join('\n');
    message = await telegramApi(env.telegramBotToken, 'sendMessage', {
      chat_id: telegramChatId,
      text: runtime.language === 'en' ? en : runtime.language === 'bilingual' ? `${ar}\n\n────────────\n\n${en}` : ar
    }).catch((error) => {
      console.error('[telegram:pending-signal]', error.message);
      return null;
    });
  }

  if (!message?.message_id) return null;

  const thread = signalTracker.start({
    tokenId: refs?.tokenId ?? null,
    chatId: telegramChatId,
    rootMessageId: message.message_id,
    snapshot
  });

  if (thread && store.enabled && refs?.tokenId) {
    try {
      await store.saveSignalThread({
        tokenId: refs.tokenId,
        chatId: telegramChatId,
        rootMessageId: message.message_id,
        snapshot
      });
    } catch (error) {
      console.error('[supabase:signal-thread-start]', snapshot.address, error.message);
    }
  }
  return thread;
}

async function enrichWithFallback(base) {
  let snapshot = base;
  try {
    snapshot = await enrichTokenSnapshot(env.birdeyeApiKey, base, {
      includeSecurity: !securityChecked.has(base.address)
    });
  } catch (error) {
    console.error('[birdeye:enrich]', base.address, error.message);
  }

  snapshot = {
    ...snapshot,
    securityVerified: snapshot.securityVerified === true || hasSecurityEvidence(snapshot),
    marketDataVerified: snapshot.marketDataVerified === true || hasVerifiedMarketActivity(snapshot)
  };
  if (snapshot.securityVerified === true) securityChecked.add(base.address);

  const trades = Number(snapshot.buys30s ?? 0) + Number(snapshot.sells30s ?? 0);
  const needsMarketFallback = Number(snapshot.priceUsd ?? 0) <= 0
    || Number(snapshot.liquidityUsd ?? 0) <= 0
    || trades <= 0;

  if (needsMarketFallback) {
    try {
      const fallback = await fetchDexScreenerSnapshot(snapshot);
      if (Object.keys(fallback).length) {
        snapshot = { ...snapshot, ...fallback };
        snapshot.marketDataVerified = hasVerifiedMarketActivity(snapshot);
        console.log(`[market:fallback] DexScreener mint=${base.address.slice(0, 8)}… price=${snapshot.priceUsd || 0} liq=${Math.round(snapshot.liquidityUsd || 0)}`);
      }
    } catch (error) {
      console.warn('[dexscreener]', base.address, error.message);
    }
  }

  candidates.set(base.address, snapshot);
  return snapshot;
}

async function liveSnapshots() {
  prunePaperBuys();
  const listings = await fetchNewListings(env.birdeyeApiKey, { limit: env.discoveryBatchSize });
  for (const listing of listings) {
    if (ageSeconds(listing) <= env.maxTokenAgeSeconds || pendingPaperBuys.has(listing.address)) {
      candidates.set(listing.address, { ...candidates.get(listing.address), ...listing });
    }
  }

  const openAddresses = new Set(trader.openPositions.map((p) => p.address));
  const pendingAddresses = new Set(pendingPaperBuys.keys());
  const trackedAddresses = new Set(signalTracker.values().map((thread) => thread.address));
  for (const [address, snapshot] of candidates) {
    if (!openAddresses.has(address) && !pendingAddresses.has(address) && !trackedAddresses.has(address) && ageSeconds(snapshot) > env.maxTokenAgeSeconds) {
      candidates.delete(address);
      securityChecked.delete(address);
    }
  }

  const openSnapshots = [...openAddresses].map((address) => candidates.get(address)).filter(Boolean);
  const pendingSnapshots = [...pendingAddresses]
    .filter((address) => !openAddresses.has(address))
    .map((address) => candidates.get(address) ?? minimalCandidate(address));
  for (const snapshot of pendingSnapshots) candidates.set(snapshot.address, snapshot);

  const reserved = new Set([...openAddresses, ...pendingAddresses]);
  const freshCandidates = [...candidates.values()]
    .filter((snapshot) => !reserved.has(snapshot.address) && !trackedAddresses.has(snapshot.address))
    .sort((a, b) => (b.listedAt - a.listedAt) || (b.liquidityUsd - a.liquidityUsd));

  const watchCandidates = freshCandidates.slice(0, WATCH_POOL_SIZE);
  let rankedFreshCandidates = freshCandidates;
  if (watchCandidates.length) {
    try {
      const marketBatch = await fetchDexScreenerSnapshots(watchCandidates);
      for (const base of watchCandidates) {
        const market = marketBatch.get(base.address);
        if (!market) continue;
        const merged = { ...base, ...market };
        candidates.set(base.address, merged);
      }
      rankedFreshCandidates = watchCandidates
        .map((base) => candidates.get(base.address) ?? base)
        .sort((a, b) => momentumRank(b) - momentumRank(a));
      const active = rankedFreshCandidates.filter(hasVerifiedMarketActivity).length;
      const rising = rankedFreshCandidates.filter(isRisingMomentum).length;
      console.log(`[watch-pool] monitored=${watchCandidates.length} active=${active} rising=${rising}`);
    } catch (error) {
      console.warn('[watch-pool]', error.message);
      rankedFreshCandidates = watchCandidates;
    }
  }

  const openSelected = [...openAddresses].map((address) => candidates.get(address)).filter(Boolean);
  const baseSelected = [...openSelected, ...pendingSnapshots];
  const capacity = Math.max(env.maxTrackedTokens, baseSelected.length);
  let remaining = Math.max(0, capacity - baseSelected.length);
  const activeTrackedNotOpen = [...trackedAddresses].filter((address) => !reserved.has(address)).length;
  const trackedSlots = Math.min(activeTrackedNotOpen, rankedFreshCandidates.length && remaining > 0 ? Math.max(0, remaining - 1) : remaining);
  const rotatingTrackedAddresses = signalTracker.nextAddresses(trackedSlots, reserved);
  const trackedSnapshots = rotatingTrackedAddresses.map((address) => candidates.get(address)).filter(Boolean);
  remaining = Math.max(0, remaining - trackedSnapshots.length);
  const selected = [...baseSelected, ...trackedSnapshots, ...rankedFreshCandidates.slice(0, remaining)];

  const enriched = [];
  const seen = new Set();
  for (const base of selected) {
    if (!base?.address || seen.has(base.address)) continue;
    seen.add(base.address);
    enriched.push(await enrichWithFallback(base));
  }
  return enriched;
}

async function tick(trigger = 'poll') {
  if (runtime.scannerPaused) return false;
  if (ticking) return false;
  ticking = true;
  try {
    prunePaperBuys();
    const live = Boolean(env.birdeyeApiKey);
    const snapshots = live ? await liveSnapshots() : demoSnapshots();

    for (const s of snapshots) {
      const isOpen = trader.openPositions.some((p) => p.address === s.address);
      const isTracked = signalTracker.has(s.address);
      const hasPendingPaperBuy = pendingPaperBuys.has(s.address);
      const earlyPumpMarket = isEarlyPumpMarket(s);
      if (!isTracked && !hasPendingPaperBuy && s.liquidityUsd < env.minLiquidityUsd && !earlyPumpMarket) continue;
      if (!isOpen && !isTracked && !hasPendingPaperBuy && ageSeconds(s) > env.maxTokenAgeSeconds) continue;

      const scores = scoreToken(s);
      const rising = isRisingMomentum(s);
      const safety = evaluateSignalSafety(s, scores);
      const refs = await persistSnapshot(s, scores);

      if (isTracked) {
        const thread = signalTracker.get(s.address);
        if (safety.emergency) await notifyEmergencyRisk(s, scores, safety, thread);

        const trackingEvent = signalTracker.observe(s);
        if (trackingEvent) {
          await persistTrackingEvent(s, scores, refs, trackingEvent);
          if (trackingEvent.type === 'expired') {
            signalTracker.remove(s.address);
          } else if (runtime.alertsEnabled) {
            if (safety.ok) await telegram.signalUpdate(s, scores, trackingEvent);
            else await notifyTrackedSafetyUpdate(s, scores, safety, trackingEvent);
          }
        }
      }

      const existing = trader.openPositions.find((p) => p.address === s.address);
      if (existing) {
        const result = trader.update(s, scores);
        if (result.closed) {
          await persistExit(s, scores, result.closed, refs);
          if (runtime.alertsEnabled) await telegram.exit(result.closed);
        }
        continue;
      }

      let p = null;
      const pendingIntent = pendingPaperBuys.get(s.address);
      if (pendingIntent && Number(s.priceUsd) > 0) {
        const result = trader.enterManual(s, scores, pendingIntent);
        if (result.ok) {
          p = result.position;
          pendingPaperBuys.delete(s.address);
          await persistEntry(s, scores, p, refs);
          await notifyQueuedPaperFill(p, pendingIntent, [...(scores.blockers ?? []), ...(!safety.ok ? safety.reasons : [])]);
          console.log(`[paper-buy] filled queued ${paperSizeLabel(pendingIntent.mode, pendingIntent.value)} mint=${s.address.slice(0, 8)}… usd=${p.usdSize.toFixed(2)}`);
        } else if (['position-already-open', 'max-open-positions', 'no-paper-cash'].includes(result.reason)) {
          pendingPaperBuys.delete(s.address);
          console.warn(`[paper-buy] rejected queued mint=${s.address.slice(0, 8)}… reason=${result.reason}`);
        }
      }

      if (!p && rising && safety.ok) {
        p = trader.maybeEnter(s, scores, env.entryScoreThreshold);
        if (p) await persistEntry(s, scores, p, refs);
      }

      console.log(JSON.stringify({
        mode: live ? 'live-data/paper-trading' : 'demo/paper-trading',
        trigger,
        database: store.enabled ? 'supabase' : 'disabled',
        telegram: telegram.enabled ? 'linked' : 'disabled',
        alerts: runtime.alertsEnabled,
        token: s.symbol,
        address: s.address,
        scores,
        safety,
        risingMomentum: rising,
        priceChange5mPct: s.priceChange5mPct ?? null,
        volume5mUsd: s.volume5mUsd ?? null,
        flow: {
          buys30s: s.buys30s ?? 0,
          sells30s: s.sells30s ?? 0,
          uniqueBuyers30s: s.uniqueBuyers30s ?? 0
        },
        paperEntry: Boolean(p),
        manualPaperEntry: Boolean(p?.manual),
        pendingPaperBuy: pendingPaperBuys.has(s.address),
        signalTracked: signalTracker.has(s.address)
      }));

      if (rising && safety.trackingAllowed && scores.entry >= env.entryScoreThreshold && !signalTracker.has(s.address)) {
        if (!p) await persistWatchSignal(s, scores, refs, safety);
        await startSignalThread(s, scores, refs, p, safety);
      }
    }
    return true;
  } finally {
    ticking = false;
  }
}

function startHeliusWakeups() {
  if (!env.heliusWsEnabled || !env.heliusApiKey || !env.birdeyeApiKey) return;

  heliusStream = new HeliusProgramStream({
    apiKey: env.heliusApiKey,
    programIds: env.heliusProgramIds,
    staleAfterMs: env.heliusStaleAfterMs,
    onEvent: (event) => {
      if (event.err || runtime.scannerPaused) return;
      if (!['create', 'migrate'].includes(event.kind)) return;

      if (event.kind === 'create' && event.mint) recordRecentCreate(event);

      const now = Date.now();
      if (now - lastHeliusTriggerAt < env.heliusTriggerMinMs) return;
      lastHeliusTriggerAt = now;

      console.log(JSON.stringify({
        mode: 'helius-wakeup',
        kind: event.kind,
        signature: event.signature,
        slot: event.slot,
        observedAt: event.observedAt,
        mint: event.mint ?? null,
        directCreate: Boolean(event.directCreate)
      }));
      void tick(`helius:${event.kind}`).catch((error) => console.error('[helius-trigger]', error));
    }
  });
  heliusStream.start();
}

function shutdown(signal) {
  console.log(`[shutdown] ${signal}`);
  telegramController.stop();
  heliusStream?.stop();
  process.exit(0);
}

process.once('SIGINT', () => shutdown('SIGINT'));
process.once('SIGTERM', () => shutdown('SIGTERM'));

const liveMode = Boolean(env.birdeyeApiKey);
const heliusMode = liveMode && env.heliusWsEnabled && Boolean(env.heliusApiKey);
console.log(`SUMMECA Meme Radar v0.15 — PAPER ONLY — ${liveMode ? 'Birdeye + DexScreener 20-token watch pool' : 'demo feed'}${heliusMode ? ' + Helius Direct Create + WebSocket' : ''}${store.enabled ? ' + Supabase persistence' : ''}${telegram.enabled ? ` + Telegram controls (${runtime.language})` : ''} + tri-state safety + continued momentum tracking + emergency entry blocks + raw creates hidden + direct in-bot paper buy/sell`);
await telegramController.start();
startHeliusWakeups();
await tick('startup');
setInterval(() => tick('fallback-poll').catch((err) => console.error('[tick]', err)), env.birdeyePollMs);
