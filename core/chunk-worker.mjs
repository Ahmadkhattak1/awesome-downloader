import { parentPort } from 'node:worker_threads';
import { downloadChunk } from './chunk.mjs';
import { configureTransport } from './http.mjs';
import { seed } from './dns.mjs';

const jobs = new Map();
parentPort.on('message', message => {
  if (message.type === 'config') {
    configureTransport(message.transport || {});
    for (const [host, list] of Object.entries(message.dns || {})) seed(host, list);
    return;
  }
  if (message.type === 'seed') { for (const [host, list] of Object.entries(message.dns || {})) seed(host, list); return; }
  if (message.type === 'abort') { jobs.get(message.id)?.abort(); return; }
  if (message.type !== 'run') return;
  const { id, task } = message, controller = new AbortController();
  jobs.set(id, controller);
  let pending = 0, last = 0;
  const report = () => { if (pending) { parentPort.postMessage({ id, type: 'progress', bytes: pending }); pending = 0; } };
  downloadChunk({ ...task, signal: controller.signal, onBytes: n => { pending += n; const now = Date.now(); if (now - last >= 40) { last = now; report(); } } })
    .then(done => { report(); parentPort.postMessage({ id, type: 'done', done }); })
    .catch(error => { report(); parentPort.postMessage({ id, type: 'error', name: error.name, message: error.message, code: error.code }); })
    .finally(() => jobs.delete(id));
});
