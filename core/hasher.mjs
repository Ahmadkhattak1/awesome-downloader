import { Worker } from 'node:worker_threads';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { HashSession } from './hash-session.mjs';

function workerPath() {
  const file = fileURLToPath(new URL('./hash-worker.mjs', import.meta.url));
  // Worker scripts cannot be loaded from inside app.asar; electron-builder unpacks core/** beside it.
  const unpacked = file.replace(/app\.asar(?=[\\/])/, 'app.asar.unpacked');
  return unpacked !== file && existsSync(unpacked) ? unpacked : file;
}

// One shared hashing thread for all downloads. If the thread cannot start or dies, sessions transparently fall back
// to hashing in-process (still asynchronous file I/O, just on the main thread) so verification never silently vanishes.
export class HashService {
  constructor({ useWorker = true } = {}) { this.useWorker = useWorker; this.worker = null; this.nextId = 1; this.pending = new Map(); this.failed = false; }
  start() {
    if (this.worker || this.failed || !this.useWorker) return this.worker;
    try {
      const worker = new Worker(workerPath()); worker.unref();
      worker.on('message', message => {
        const waiter = this.pending.get(message.id); if (!waiter) return;
        this.pending.delete(message.id);
        if (message.type === 'digest') waiter.resolve(message.digests); else waiter.reject(new Error(message.message));
      });
      const die = error => {
        if (this.worker !== worker) return;
        this.worker = null; this.failed = true;
        for (const waiter of this.pending.values()) waiter.reject(Object.assign(error, { code: 'HASH_WORKER_FAILED' }));
        this.pending.clear();
      };
      worker.on('error', die); worker.on('exit', code => die(new Error(`Hash worker exited (${code}).`)));
      this.worker = worker;
    } catch { this.failed = true; this.worker = null; }
    return this.worker;
  }
  get threaded() { return Boolean(this.worker); }
  open(file, algorithms = ['sha256', 'md5']) {
    const worker = this.start();
    if (!worker) return new LocalSession(file, algorithms);
    const id = this.nextId++;
    worker.postMessage({ type: 'open', id, file, algorithms });
    return {
      threaded: true,
      advance: upTo => { try { worker.postMessage({ type: 'advance', id, upTo }); } catch { /* digest() falls back */ } },
      digest: total => new Promise((resolve, reject) => {
        this.pending.set(id, { resolve, reject });
        try { worker.postMessage({ type: 'digest', id, total }); } catch (error) { this.pending.delete(id); reject(error); }
      }).catch(error => (error.code === 'HASH_WORKER_FAILED' || this.failed ? new HashSession(file, algorithms).digest(total) : Promise.reject(error))),
      close: () => { try { worker.postMessage({ type: 'close', id }); } catch { /* worker already gone */ } }
    };
  }
  async close() { const worker = this.worker; this.worker = null; this.failed = false; if (worker) await worker.terminate().catch(() => {}); }
}
class LocalSession {
  constructor(file, algorithms) { this.threaded = false; this.session = new HashSession(file, algorithms); }
  advance(upTo) { this.session.advance(upTo); }
  digest(total) { return this.session.digest(total); }
  close() {}
}
