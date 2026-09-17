import { env } from './config/env.mjs';
import { installArcRpcGuard } from './infra/arcRpcGuard.mjs';
import { installDexScreenerGuard } from './infra/dexScreenerGuard.mjs';
import { installSmartWalletSignalRecorder } from './infra/smartWalletSignalRecorder.mjs';
import { installTelegramTerminalGuard } from './infra/telegramTerminalGuard.mjs';
import { installAdvancedTerminal } from './bot/advancedTerminal.mjs';
import { installPhase3Terminal } from './bot/phase3Terminal.mjs';
import { installPhase3Compat } from './bot/phase3Compat.mjs';
import { installPhase4SafetyLeaderboard } from './bot/phase4SafetyLeaderboard.mjs';
import { installPhase4PerformanceOverlay } from './bot/phase4PerformanceOverlay.mjs';

installArcRpcGuard();
installDexScreenerGuard();
installSmartWalletSignalRecorder();
installTelegramTerminalGuard();
installAdvancedTerminal();
installPhase3Terminal();
installPhase3Compat();
installPhase4SafetyLeaderboard();
installPhase4PerformanceOverlay();

// Shared Telegram wrappers only. They do not create additional long-pollers.
await import('./bot/phase4TelegramRouter.mjs');
await import('./telegramOwnerMenu.mjs');

const [
  { startTrenchesWorker },
  { startSafePrelaunchWorker },
  { startMultiChainWorker },
  { startBnbLeanWorker },
  { startSolanaUltraEarlyWorker },
  { startWalletPerformanceWorker },
  { startLeanTelegramController }
] = await Promise.all([
  import('./signals/trenchesWorker.mjs'),
  import('./signals/prelaunchSafeWorker.mjs'),
  import('./signals/multiChainWorker.mjs'),
  import('./signals/bnbLeanWorker.mjs'),
  import('./signals/solanaUltraEarlyWorker.mjs'),
  import('./signals/walletPerformanceWorker.mjs'),
  import('./bot/leanTelegramController.mjs')
]);

if (!env.trenchesEnabled) {
  console.warn('[source-mode] ARC TRENCHES is disabled');
} else {
  console.log('[source-mode] MULTICHAIN LEAN — Arc + Solana Ultra-Early + BNB Chain + Robinhood Chain; legacy scanners/executors are not loaded');
}

async function startSafely(name, starter) {
  try {
    await starter();
    console.log(`[bootstrap] ${name} started`);
  } catch (error) {
    console.error(`[bootstrap] ${name} start failed: ${String(error?.message ?? error)}`);
  }
}

// Start all engines in parallel. A rate-limited provider on one network must never
// delay Telegram controls or the other chains.
await Promise.allSettled([
  startSafely('arc-trenches', startTrenchesWorker),
  startSafely('arc-prelaunch', startSafePrelaunchWorker),
  startSafely('multichain', startMultiChainWorker),
  startSafely('bnb', startBnbLeanWorker),
  startSafely('solana-ultra', startSolanaUltraEarlyWorker),
  startSafely('wallet-performance', startWalletPerformanceWorker),
  startSafely('telegram-controller', startLeanTelegramController)
]);
