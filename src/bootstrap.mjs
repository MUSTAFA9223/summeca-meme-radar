import { env } from './config/env.mjs';
import { installArcRpcGuard } from './infra/arcRpcGuard.mjs';

installArcRpcGuard();

// Keep the owner/admin Telegram layer, but do not load any legacy scanners.
await import('./telegramOwnerMenu.mjs');

const [{ startTrenchesWorker }, { startSafePrelaunchWorker }, { startLeanTelegramController }] = await Promise.all([
  import('./signals/trenchesWorker.mjs'),
  import('./signals/prelaunchSafeWorker.mjs'),
  import('./bot/leanTelegramController.mjs')
]);

if (!env.trenchesEnabled) {
  console.warn('[source-mode] TRENCHES is disabled — no legacy scanners are started in the lean production build');
} else {
  console.log('[source-mode] ARC ON-CHAIN TRENCHES — wallet-driven + pre-launch contract radar; legacy scanners/executors are not loaded');
}

await startTrenchesWorker();
await startSafePrelaunchWorker();
await startLeanTelegramController();
