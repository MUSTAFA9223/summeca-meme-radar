import { spawnSync } from 'node:child_process';
import { env } from './config/env.mjs';
import './index.mjs';
import { startMomentumAlertWorker } from './signals/momentumAlertWorker.mjs';
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
  const smoke = spawnSync(process.execPath, ['scripts/live-config-smoke.mjs'], {
    cwd: process.cwd(),
    env: process.env,
    encoding: 'utf8',
    timeout: 45_000
  });
  const stdout = String(smoke.stdout ?? '').trim();
  const stderr = String(smoke.stderr ?? '').trim();
  if (stdout) console.log(stdout);
  if (stderr) console.error(stderr);
  console.log(`[live-config-smoke] ${smoke.status === 0 ? 'PASS' : 'FAIL'} — read-only, no signing, no transaction sent`);
} else if (!env.liveTradingEnabled) {
  console.log('[live-config-smoke] SKIPPED — secure live configuration is incomplete');
}

await startMomentumAlertWorker();
await startLiveAutomation();
