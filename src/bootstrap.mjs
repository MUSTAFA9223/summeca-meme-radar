import { env } from './config/env.mjs';
import { installArcRpcGuard } from './infra/arcRpcGuard.mjs';

installArcRpcGuard();

// Keep the owner/admin Telegram layer, but do not load any legacy scanners.
await import('./telegramOwnerMenu.mjs');

const [
  { startTrenchesWorker },
  { startSafePrelaunchWorker },
  { startMultiChainWorker },
  { startBnbLeanWorker },
  { startSolanaUltraEarlyWorker },
  { startLeanTelegramController }
] = await Promise.all([
  import('./signals/trenchesWorker.mjs'),
  import('./signals/prelaunchSafeWorker.mjs'),
  import('./signals/multiChainWorker.mjs'),
  import('./signals/bnbLeanWorker.mjs'),
  import('./signals/solanaUltraEarlyWorker.mjs'),
  import('./bot/leanTelegramController.mjs')
]);

if (!env.trenchesEnabled) {
  console.warn('[source-mode] ARC TRENCHES is disabled');
} else {
  console.log('[source-mode] MULTICHAIN LEAN — Arc + Solana Ultra-Early + BNB Chain + Robinhood Chain; legacy scanners/executors are not loaded');
}

await startTrenchesWorker();
await startSafePrelaunchWorker();
await startMultiChainWorker();
await startBnbLeanWorker();
await startSolanaUltraEarlyWorker();
await startLeanTelegramController();
