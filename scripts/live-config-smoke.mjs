import { env } from '../src/config/env.mjs';
import { runLiveConfigSmoke } from '../src/trading/liveConfigSmoke.mjs';

try {
  await runLiveConfigSmoke(env);
} catch (error) {
  console.error(`[live-config-smoke] FAIL — ${error.message}`);
  process.exitCode = 1;
}
