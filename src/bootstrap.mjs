import { env } from './config/env.mjs';
import { startTrenchesWorker } from './signals/trenchesWorker.mjs';

if (!env.trenchesEnabled) {
  console.warn('[source-mode] TRENCHES is disabled — no legacy scanners are started in the lean production build');
} else {
  console.log('[source-mode] ARC ON-CHAIN TRENCHES — wallet-driven only; legacy scanners/executors are not loaded');
}

await startTrenchesWorker();
