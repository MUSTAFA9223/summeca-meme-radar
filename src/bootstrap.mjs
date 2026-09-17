import { env } from './config/env.mjs';
import { installArcRpcGuard } from './infra/arcRpcGuard.mjs';
import { installDexScreenerGuard } from './infra/dexScreenerGuard.mjs';
import { installSmartWalletSignalRecorder } from './infra/smartWalletSignalRecorder.mjs';
import { installTelegramTerminalGuard } from './infra/telegramTerminalGuard.mjs';
import { attachRuntimeCheckpoint } from './infra/runtimeCheckpoint.mjs';
import { installAdvancedTerminal } from './bot/advancedTerminal.mjs';
import { installPhase3Terminal } from './bot/phase3Terminal.mjs';
import { installPhase3Compat } from './bot/phase3Compat.mjs';
import { installPhase4SafetyLeaderboard } from './bot/phase4SafetyLeaderboard.mjs';
import { installPhase4PerformanceOverlay } from './bot/phase4PerformanceOverlay.mjs';
import { installPhase5RiskQuote } from './bot/phase5RiskQuote.mjs';
import { installPhase6ManualConfirm } from './bot/phase6ManualConfirm.mjs';

installArcRpcGuard();
installDexScreenerGuard();
installSmartWalletSignalRecorder();
installTelegramTerminalGuard();
installAdvancedTerminal();
installPhase3Terminal();
installPhase3Compat();
installPhase4SafetyLeaderboard();
installPhase4PerformanceOverlay();
installPhase5RiskQuote();
installPhase6ManualConfirm();

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
    const worker = await starter();
    await attachRuntimeCheckpoint(name, worker);
    console.log(`[bootstrap] ${name} started`);
    return worker;
  } catch (error) {
    console.error(`[bootstrap] ${name} start failed: ${String(error?.message ?? error)}`);
    return null;
  }
}

// Start all engines in parallel. A rate-limited provider on one network must never
// delay Telegram controls or the other chains. Durable checkpoints are attached
// immediately after each worker starts and can replay a bounded gap after restart.
await Promise.allSettled([
  startSafely('arc-trenches', startTrenchesWorker),
  startSafely('arc-prelaunch', startSafePrelaunchWorker),
  startSafely('multichain', startMultiChainWorker),
  startSafely('bnb', startBnbLeanWorker),
  startSafely('solana-ultra', startSolanaUltraEarlyWorker),
  startSafely('wallet-performance', startWalletPerformanceWorker),
  startSafely('telegram-controller', startLeanTelegramController)
]);
