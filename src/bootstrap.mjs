import './telegramStartupMute.mjs';
import './telegramBoldFetch.mjs';
import './telegramOwnerMenu.mjs';
import './telegramRawContractCopy.mjs';
import { env } from './config/env.mjs';
import './index.mjs';
import { startEvmRadarWorker } from './signals/evmRadarWorker.mjs';
import { startMomentumAlertWorker } from './signals/momentumAlertWorker.mjs';
import { startSmartMoneyWorker } from './signals/smartMoneyWorker.mjs';
import { startTrenchesWorker } from './signals/trenchesWorker.mjs';
import { runLiveConfigSmoke } from './trading/liveConfigSmoke.mjs';
import { startLiveAutomation } from './trading/liveAutomation.mjs';

const liveConfigReady = [
  env.privyAppId,
  env.privyAppSecret,
  env.privyWalletId,
  env.privyWalletAddress,
  env.privyAuthorizationPrivateKey,
  env.jupiterApiKey,
  env.heliusApiKey
].every((value) => String(value ?? '').trim());

if (!env.liveTradingEnabled && liveConfigReady) {
  try {
    await runLiveConfigSmoke(env);
    console.log('[live-config-smoke] PASS — read-only, no signing, no transaction sent');
  } catch (error) {
    console.error(`[live-config-smoke] FAIL — ${error.message}`);
  }
} else if (!env.liveTradingEnabled) {
  console.log('[live-config-smoke] SKIPPED — secure live configuration is incomplete');
}

if (env.trenchesEnabled) {
  // Trenches-first production mode: old momentum, generic EVM discovery and
  // Birdeye Smart Money sources stay dormant. index.mjs is still loaded for
  // Telegram controls/paper portfolio, while scanner_paused disables its old
  // Solana discovery loop in production settings.
  console.log('[source-mode] TRENCHES-FIRST — legacy signal workers disabled');
  await startTrenchesWorker();
} else {
  await startMomentumAlertWorker();
  await startEvmRadarWorker();
  console.log('[global-radar] generic safety-pending alerts disabled in high-confidence mode; networks without contract-security verification stay silent');
  await startSmartMoneyWorker();
}

await startLiveAutomation();
