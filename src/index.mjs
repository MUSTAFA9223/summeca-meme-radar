import { TelegramController } from './bot/telegramController.mjs';
import { env } from './config/env.mjs';
import { scoreToken } from './core/scoring.mjs';
import { enrichTokenSnapshot, fetchNewListings } from './feeds/birdeye.mjs';
import { demoSnapshots } from './feeds/demo.mjs';
import { HeliusProgramStream } from './feeds/heliusWs.mjs';
import { discoverPrivateStartChat, TelegramNotifier, telegramApi } from './notifiers/telegram.mjs';
import { SignalTracker } from './signals/signalTracker.mjs';
import { AppSettings } from './storage/appSettings.mjs';
import { SupabaseStore } from './storage/supabaseStore.mjs';
import { PaperTrader } from './trading/paperTrader.mjs';

const store = new SupabaseStore(env.supabaseUrl, env.supabaseSecretKey);
const appSettings = new AppSettings(env.supabaseUrl, env.supabaseSecretKey);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const SOLANA_ADDRESS = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

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
  walletAddress: ''
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
const earlyCreateRoots = new Map();
const earlyCreateQueued = new Set();
const earlyCreateQueue = [];
const pendingPaperBuys = new Map();
const EARLY_ROOT_TTL_MS = 15 * 60 * 1000;
const EARLY_QUEUE_MAX_AGE_MS = 20_000;
const PAPER_BUY_TTL_MS = 3 * 60 * 1000;
let earlyCreateWorkerRunning = false;
let ticking = false;
let lastHeliusTriggerAt = 0;
let heliusStream = null;

function paperSizeLabel(mode, value) {
  return mode === 'percent' ? `${Number(value)}%` : `$${Number(value).toFixed(2)}`;
}

function minimalCandidate(address) {
  const now = Date.now();
  return {
    address,
    symbol: 'NEW',
    name: 'New Pump.fun coin',
    source: 'pump_fun_direct',
    observedAt: now,
    listedAt: now,
    priceUsd: 0,
    liquidityUsd: 0,
    directCreate: true
  };
}

async function notifyQueuedPaperFill(position, intent, warnings = []) {
  if (!env.telegramBotToken || !telegramChatId) return;
  const warningText = warnings.length ? `\n⚠️ ${warnings.join('، ')}` : '';
  const ar = [
    '✅ تم تنفيذ طلب الدخول التجريبي المعلق',
    '',
    `${position.symbol ?? 'TOKEN'}`,
    `الحجم المختار: ${paperSizeLabel(intent.mode, intent.value)}`,
    `المبلغ المنفذ: $${Number(position.usdSize).toFixed(2)}`,
    `السعر: ${position.entryPriceUsd}`,
    'الستوب: -10%',
    'حماية الربح: تستهدف +20% بعد بلوغ +30%',
    warningText
  ].filter(Boolean).join('\n');
  const en = [
    '✅ Queued PAPER entry filled',
    '',
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

  pendingPaperBuys.set(mint, {
    mode: sizeMode,
    value: sizeValue,
    createdAt: Date.now()
  });
  void tick('telegram-paper-buy').catch((error) => console.error('[paper-buy-trigger]', error.message));
  return {
    status: 'queued',
    address: mint,
    size: paperSizeLabel(sizeMode, sizeValue),
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
  onPaperBuy: requestPaperBuy
});

function pruneEarlyCreateRoots() {
  const now = Date.now();
  for (const [address, root] of earlyCreateRoots) {
    if (now - root.createdAt > EARLY_ROOT_TTL_MS) earlyCreateRoots.delete(address);
  }
}

function prunePaperBuys() {
  const now = Date.now();
  for (const [address, intent] of pendingPaperBuys) {
    if (now - Number(intent.createdAt ?? 0) > PAPER_BUY_TTL_MS) {
      pendingPaperBuys.delete(address);
      console.warn(`[paper-buy] expired pending intent mint=${address.slice(0, 8)}…`);
    }
  }
}

async function runEarlyCreateWorker() {
  if (earlyCreateWorkerRunning) return;
  earlyCreateWorkerRunning = true;
  try {
    while (earlyCreateQueue.length) {
      const item = earlyCreateQueue.shift();
      if (!item?.candidate?.address) continue;
      const address = item.candidate.address;
      earlyCreateQueued.delete(address);

      if (Date.now() - item.enqueuedAt > EARLY_QUEUE_MAX_AGE_MS) {
        console.warn(`[telegram:early-create] skipped stale mint=${address.slice(0, 8)}…`);
        continue;
      }
      if (!runtime.alertsEnabled || !telegram.enabled || earlyCreateRoots.has(address)) continue;

      try {
        const message = await telegram.earlyCreate(item.candidate, item.event);
        if (message?.message_id) {
          earlyCreateRoots.set(address, {
            messageId: message.message_id,
            createdAt: Date.now()
          });
          console.log(`[telegram:early-create] sent mint=${address.slice(0, 8)}… msg=${message.message_id}`);
        }
      } catch (error) {
        console.error('[telegram:early-create]', address, error.message);
      }
      await sleep(1100);
    }
  } finally {
    earlyCreateWorkerRunning = false;
  }
}

function queueEarlyCreateAlert(event) {
  const address = String(event?.mint ?? '').trim();
  if (!address || !runtime.alertsEnabled || !telegram.enabled) return;
  pruneEarlyCreateRoots();
  if (earlyCreateRoots.has(address) || earlyCreateQueued.has(address)) return;

  const candidate = {
    address,
    symbol: 'NEW',
    name: 'New Pump.fun coin',
    source: 'pump_fun_direct',
    observedAt: event.observedAt ?? Date.now(),
    listedAt: event.observedAt ?? Date.now(),
    priceUsd: 0,
    liquidityUsd: 0,
    directCreate: true,
    createSignature: event.signature ?? ''
  };
  candidates.set(address, { ...candidates.get(address), ...candidate });
  earlyCreateQueued.add(address);
  earlyCreateQueue.push({
    enqueuedAt: Date.now(),
    candidate,
    event
  });
  void runEarlyCreateWorker();
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

async function persistWatchSignal(snapshot, scores, refs) {
  if (!store.enabled || !refs?.tokenId) return;
  try {
    await store.saveSignal({
      tokenId: refs.tokenId,
      snapshotId: refs.snapshotId,
      type: 'watch',
      scores,
      reason: {
        trigger: 'telegram-strong-signal',
        priceAvailable: Number(snapshot.priceUsd) > 0,
        buyers30s: snapshot.buys30s ?? 0,
        sells30s: snapshot.sells30s ?? 0
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

async function startSignalThread(snapshot, scores, refs, paperPosition) {
  if (!runtime.alertsEnabled || signalTracker.has(snapshot.address)) return null;
  pruneEarlyCreateRoots();
  const earlyRoot = earlyCreateRoots.get(snapshot.address) ?? null;
  const message = await telegram.signal(
    snapshot,
    scores,
    paperPosition ?? undefined,
    earlyRoot ? { replyToMessageId: earlyRoot.messageId } : {}
  );
  if (!message?.message_id) return null;

  const rootMessageId = earlyRoot?.messageId ?? message.message_id;
  const thread = signalTracker.start({
    tokenId: refs?.tokenId ?? null,
    chatId: telegramChatId,
    rootMessageId,
    snapshot
  });

  earlyCreateRoots.delete(snapshot.address);

  if (thread && store.enabled && refs?.tokenId) {
    try {
      await store.saveSignalThread({
        tokenId: refs.tokenId,
        chatId: telegramChatId,
        rootMessageId,
        snapshot
      });
    } catch (error) {
      console.error('[supabase:signal-thread-start]', snapshot.address, error.message);
    }
  }
  return thread;
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

  const baseSelected = [...openSnapshots, ...pendingSnapshots];
  const capacity = Math.max(env.maxTrackedTokens, baseSelected.length);
  let remaining = Math.max(0, capacity - baseSelected.length);
  const activeTrackedNotOpen = [...trackedAddresses].filter((address) => !reserved.has(address)).length;
  const trackedSlots = Math.min(activeTrackedNotOpen, freshCandidates.length && remaining > 0 ? Math.max(0, remaining - 1) : remaining);
  const rotatingTrackedAddresses = signalTracker.nextAddresses(trackedSlots, reserved);
  const trackedSnapshots = rotatingTrackedAddresses.map((address) => candidates.get(address)).filter(Boolean);
  remaining = Math.max(0, remaining - trackedSnapshots.length);
  const selected = [...baseSelected, ...trackedSnapshots, ...freshCandidates.slice(0, remaining)];

  const enriched = [];
  const seen = new Set();
  for (const base of selected) {
    if (!base?.address || seen.has(base.address)) continue;
    seen.add(base.address);
    const address = base.address;
    try {
      const snapshot = await enrichTokenSnapshot(env.birdeyeApiKey, base, {
        includeSecurity: !securityChecked.has(address)
      });
      candidates.set(address, snapshot);
      securityChecked.add(address);
      enriched.push(snapshot);
    } catch (error) {
      console.error('[enrich]', address, error.message);
      enriched.push(base);
    }
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
      if (!isTracked && !hasPendingPaperBuy && s.liquidityUsd < env.minLiquidityUsd) continue;
      if (!isOpen && !isTracked && !hasPendingPaperBuy && ageSeconds(s) > env.maxTokenAgeSeconds) continue;

      const scores = scoreToken(s);
      const refs = await persistSnapshot(s, scores);

      if (isTracked) {
        const trackingEvent = signalTracker.observe(s);
        if (trackingEvent) {
          await persistTrackingEvent(s, scores, refs, trackingEvent);
          if (trackingEvent.type === 'expired') {
            signalTracker.remove(s.address);
          } else if (runtime.alertsEnabled) {
            await telegram.signalUpdate(s, scores, trackingEvent);
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
          await notifyQueuedPaperFill(p, pendingIntent, scores.blockers ?? []);
          console.log(`[paper-buy] filled queued ${paperSizeLabel(pendingIntent.mode, pendingIntent.value)} mint=${s.address.slice(0, 8)}… usd=${p.usdSize.toFixed(2)}`);
        } else if (['position-already-open', 'max-open-positions', 'no-paper-cash'].includes(result.reason)) {
          pendingPaperBuys.delete(s.address);
          console.warn(`[paper-buy] rejected queued mint=${s.address.slice(0, 8)}… reason=${result.reason}`);
        }
      }

      if (!p) {
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

      if (scores.entry >= env.entryScoreThreshold && !signalTracker.has(s.address)) {
        if (!p) await persistWatchSignal(s, scores, refs);
        await startSignalThread(s, scores, refs, p);
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

      if (event.kind === 'create' && event.mint) {
        queueEarlyCreateAlert(event);
      }

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
console.log(`SUMMECA Meme Radar v0.10 — PAPER ONLY — ${liveMode ? 'Birdeye live data' : 'demo feed'}${heliusMode ? ' + Helius Direct Create + WebSocket' : ''}${store.enabled ? ' + Supabase persistence' : ''}${telegram.enabled ? ` + Telegram controls (${runtime.language})` : ''} + instant create alerts + in-bot paper sizing + threaded signal tracking`);
await telegramController.start();
startHeliusWakeups();
await tick('startup');
setInterval(() => tick('fallback-poll').catch((err) => console.error('[tick]', err)), env.birdeyePollMs);
