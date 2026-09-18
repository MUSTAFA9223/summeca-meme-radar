import { Worker } from 'node:worker_threads';

let instance = null;

export class LiveProtectionSupervisor {
  constructor({ restartDelayMs = 1500 } = {}) {
    this.restartDelayMs = restartDelayMs;
    this.worker = null;
    this.stopped = false;
    this.restartTimer = null;
  }

  spawn() {
    if (this.stopped || this.worker) return;
    const worker = new Worker(new URL('./liveProtectionWorker.mjs', import.meta.url), {
      name: 'summeca-live-protection'
    });
    this.worker = worker;

    worker.on('message', (message) => {
      if (message?.type === 'ready') {
        console.log(`[live-protect:supervisor] isolated worker ready broadcast=${message.broadcastEnabled ? 'ENABLED' : 'LOCKED'}`);
      } else if (message?.type === 'fatal') {
        console.error(`[live-protect:supervisor] worker fatal: ${message.error}`);
      }
    });

    worker.on('error', (error) => {
      console.error(`[live-protect:supervisor] worker error: ${String(error?.message ?? error)}`);
    });

    worker.on('exit', (code) => {
      this.worker = null;
      if (this.stopped) return;
      console.error(`[live-protect:supervisor] worker exited code=${code}; restarting without touching radar workers`);
      clearTimeout(this.restartTimer);
      this.restartTimer = setTimeout(() => this.spawn(), this.restartDelayMs);
    });
  }

  start() {
    this.spawn();
    return this;
  }

  async stop() {
    this.stopped = true;
    clearTimeout(this.restartTimer);
    const worker = this.worker;
    this.worker = null;
    if (worker) await worker.terminate();
  }
}

export function startLiveProtectionSupervisor() {
  if (instance) return instance;
  instance = new LiveProtectionSupervisor().start();
  return instance;
}
