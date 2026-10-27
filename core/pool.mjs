import { Worker } from 'node:worker_threads';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import os from 'node:os';

const abortError = () => Object.assign(new Error('The operation was aborted.'), { name: 'AbortError', code: 'ABORT_ERR' });
const unavailable = message => Object.assign(new Error(message), { code: 'POOL_UNAVAILABLE' });

function workerPath() {
  let file = fileURLToPath(new URL('./chunk-worker.mjs', import.meta.url));
  // Worker scripts cannot be loaded from inside app.asar; electron-builder unpacks core/** beside it.
  const unpacked = file.replace(/app\.asar(?=[\\/])/, 'app.asar.unpacked');
  return unpacked !== file && existsSync(unpacked) ? unpacked : file;
}

// Worker-thread pool: network receive + disk writes run off the main (UI) thread. Each worker multiplexes many
// concurrent chunk transfers on its own event loop, so a handful of threads serves up to 64 connections.
export class ChunkPool {
  constructor({ size = Math.min(4, os.cpus().length || 1), perWorker = 16, transport = {} } = {}) {
    this.size = Math.max(1, size); this.perWorker = perWorker; this.transport = transport;
    this.workers = []; this.nextId = 1; this.failures = 0; this.closed = false;
  }
  get broken() { return this.failures >= 3; }
  spawn() {
    const worker = new Worker(workerPath());
    const entry = { worker, jobs: new Map(), dead: false };
    worker.unref();
    worker.postMessage({ type: 'config', transport: this.transport });
    worker.on('message', message => {
      const job = entry.jobs.get(message.id);
      if (!job) return;
      if (message.type === 'progress') job.onBytes(message.bytes);
      else if (message.type === 'done') { entry.jobs.delete(message.id); job.resolve(message.done); }
      else if (message.type === 'error') {
        entry.jobs.delete(message.id);
        job.reject(Object.assign(new Error(message.message), { name: message.name || 'Error', code: message.code }));
      }
    });
    const die = error => {
      if (entry.dead) return;
      entry.dead = true; this.failures++;
      this.workers = this.workers.filter(w => w !== entry);
      for (const job of entry.jobs.values()) job.reject(Object.assign(error, { code: 'POOL_UNAVAILABLE' }));
      entry.jobs.clear();
    };
    worker.on('error', die);
    worker.on('exit', code => die(new Error(`Download worker exited (${code}).`)));
    this.workers.push(entry);
    return entry;
  }
  pick() {
    let best = this.workers.reduce((a, w) => !a || w.jobs.size < a.jobs.size ? w : a, null);
    if ((!best || best.jobs.size >= this.perWorker) && this.workers.length < this.size) best = this.spawn();
    return best;
  }
  reconfigure(transport) { this.transport = transport; for (const w of this.workers) w.worker.postMessage({ type: 'config', transport }); }
  seedDns(map) { for (const w of this.workers) w.worker.postMessage({ type: 'seed', dns: map }); this.dns = { ...this.dns, ...map }; }
  run(task, { signal, onBytes = () => {} } = {}) {
    if (this.closed || this.broken) return Promise.reject(unavailable('Worker pool unavailable.'));
    if (signal?.aborted) return Promise.reject(abortError());
    let entry;
    try { entry = this.pick(); } catch (error) { this.failures = 3; return Promise.reject(unavailable(error.message)); }
    if (this.dns && !entry.seeded) { entry.seeded = true; entry.worker.postMessage({ type: 'seed', dns: this.dns }); }
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const abort = () => entry.worker.postMessage({ type: 'abort', id });
      const cleanup = () => signal?.removeEventListener('abort', abort);
      entry.jobs.set(id, { resolve: v => { cleanup(); resolve(v); }, reject: e => { cleanup(); reject(e); }, onBytes });
      if (signal) signal.addEventListener('abort', abort, { once: true });
      entry.worker.postMessage({ type: 'run', id, task });
    });
  }
  async close() {
    this.closed = true;
    await Promise.allSettled(this.workers.map(w => w.worker.terminate()));
    this.workers = [];
  }
}
