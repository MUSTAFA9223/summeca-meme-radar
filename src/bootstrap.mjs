import './index.mjs';
import { startMomentumAlertWorker } from './signals/momentumAlertWorker.mjs';
import { startLiveAutomation } from './trading/liveAutomation.mjs';

await startMomentumAlertWorker();
await startLiveAutomation();
