import { env } from './config/env.mjs';
import { installArcRpcGuard } from './infra/arcRpcGuard.mjs';

installArcRpcGuard();

const [{ startTrenchesWorker }, { startSafePrelaunchWorker }] = await Promise.all([
  import('./signals/trenchesWorker.mjs'),
  import('./signals/prelaunchSafeWorker.mjs')
]);

if (!env.trenchesEnabled) {
  console.warn('[source-mode] TRENCHES is disabled — no legacy scanners are started in the lean production build');
} else {
  console.log('[source-mode] ARC ON-CHAIN TRENCHES — wallet-driven + pre-launch contract radar; legacy scanners/executors are not loaded');
}

await startTrenchesWorker();
await startSafePrelaunchWorker();
