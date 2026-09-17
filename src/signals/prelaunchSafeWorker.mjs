import { PrelaunchWorker } from './prelaunchWorker.mjs';

const TRANSFER_TOPIC = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';
const ARC_SYSTEM_EMITTER = '0xfffffffffffffffffffffffffffffffffffffffe';
const ARC_NATIVE_USDC = '0x3600000000000000000000000000000000000000';
const low = (value) => String(value ?? '').trim().toLowerCase();
const topicAddress = (topic) => topic && topic.length >= 42 ? `0x${topic.slice(-40)}`.toLowerCase() : '';
const hexBigInt = (value) => {
  try { return BigInt(value || '0x0'); } catch { return 0n; }
};
const usd18 = (value) => Number(hexBigInt(value)) / 1e18;

export class SafePrelaunchWorker extends PrelaunchWorker {
  payerEvidence(wallet, tx, receipt, boughtToken) {
    if (low(tx?.from) === wallet) {
      return { verified: true, paidUsd: usd18(tx?.value), mode: 'tx-from' };
    }

    let verified = false;
    let paidUsd = 0;
    for (const log of receipt?.logs ?? []) {
      if (low(log?.topics?.[0]) !== TRANSFER_TOPIC || topicAddress(log?.topics?.[1]) !== wallet) continue;
      const to = topicAddress(log?.topics?.[2]);
      if (!to || low(log?.address) === low(boughtToken)) continue;

      verified = true;
      const asset = low(log?.address);
      if (asset === ARC_SYSTEM_EMITTER || asset === ARC_NATIVE_USDC) {
        paidUsd = Math.max(paidUsd, usd18(log?.data));
      }
    }
    return { verified, paidUsd, mode: verified ? 'outflow-proof' : 'none' };
  }
}

let singleton = null;
export async function startSafePrelaunchWorker() {
  if (!singleton) singleton = new SafePrelaunchWorker();
  await singleton.start();
  return singleton;
}
