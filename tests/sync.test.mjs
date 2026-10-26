import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { DownloadEngine } from '../core/engine.mjs';
import { startBridge } from '../core/bridge.mjs';
const require = createRequire(import.meta.url);
const { sanitizeRequest } = require('../integration/native-host.cjs');

async function setup(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'awesome-sync-'));
  const engine = await new DownloadEngine({ dataDirectory: path.join(root, 'data'), downloadDirectory: path.join(root, 'dl'), tickMs: 60000 }).init();
  t.after(async () => { await engine.close?.(); await fs.rm(root, { recursive: true, force: true }); });
  return { root, engine };
}
function call(info, route, body) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body || {});
    const req = http.request({ host: '127.0.0.1', port: info.port, path: route, method: 'POST', headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(data), authorization: `Bearer ${info.token}` } }, res => {
      let text = ''; res.on('data', c => text += c); res.on('end', () => resolve({ status: res.statusCode, body: JSON.parse(text) }));
    });
    req.on('error', reject); req.end(data);
  });
}

test('watchClipboard is a validated boolean setting that defaults to off', async t => {
  const { engine } = await setup(t);
  assert.equal(engine.settings.watchClipboard, false);
  await engine.updateSettings({ watchClipboard: true });
  assert.equal(engine.settings.watchClipboard, true);
  assert.throws(() => engine.updateSettings({ watchClipboard: 'yes' }), /Invalid watchClipboard/);
});

test('bridge /status and /control keep the extension in sync with the engine', async t => {
  const { root, engine } = await setup(t);
  const bridge = await startBridge(engine, { dataDirectory: path.join(root, 'bridge'), port: 0 });
  t.after(() => bridge.close());
  const info = JSON.parse(await fs.readFile(path.join(root, 'bridge', 'bridge.json'), 'utf8'));
  const [id] = await engine.add({ url: 'https://example.com/a.zip', queueOnly: true });
  const status = await call(info, '/status');
  assert.equal(status.status, 200);
  assert.equal(status.body.items[0].id, id);
  assert.equal(status.body.items[0].status, 'paused');
  assert.ok(!('headers' in status.body.items[0]) && !('url' in status.body.items[0]), 'no URLs or credentials leave the desktop app');
  assert.equal((await call(info, '/control', { id, action: 'cancel' })).status, 200);
  assert.equal(engine.downloads.find(d => d.id === id).status, 'cancelled');
  assert.equal((await call(info, '/control', { id, action: 'remove' })).status, 400, 'extension cannot delete history');
  assert.equal((await call(info, '/control', { id: 'missing', action: 'pause' })).status, 400);
});

test('native host accepts only validated status and control requests', () => {
  assert.deepEqual(sanitizeRequest({ action: 'status' }), { action: 'status' });
  assert.deepEqual(sanitizeRequest({ action: 'control', id: 'abc-123', control: 'pause' }), { action: 'control', id: 'abc-123', control: 'pause' });
  for (const bad of [{ action: 'control', id: 'x', control: 'remove' }, { action: 'control', id: '../x', control: 'pause' }, { action: 'control', control: 'pause' }, { action: 'exec' }]) assert.throws(() => sanitizeRequest(bad));
});

test('compatibility shims behave like the modern APIs', async () => {
  await import('../core/compat.mjs');
  const a = new AbortController(), b = new AbortController();
  const any = AbortSignal.any([a.signal, b.signal]);
  assert.equal(any.aborted, false); b.abort(new Error('x')); assert.equal(any.aborted, true);
  assert.equal([1, 2, 3, 4].findLast(n => n % 2), 3);
});

// ---- high connection counts (42 / 56 / 64 parallel ranges)
import { createHash, randomBytes } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
async function rangeServer(size = 40 * 1024 * 1024) {
  const data = randomBytes(size);
  const stats = { active: 0, peak: 0, ranged: 0 };
  const server = http.createServer(async (req, res) => {
    res.setHeader('accept-ranges', 'bytes'); res.setHeader('etag', '"big-1"');
    let start = 0, end = data.length - 1;
    const m = /^bytes=(\d+)-(\d+)$/.exec(req.headers.range || '');
    if (m) { start = Number(m[1]); end = Number(m[2]); res.statusCode = 206; res.setHeader('content-range', `bytes ${start}-${end}/${data.length}`); stats.ranged++; }
    res.setHeader('content-length', end - start + 1);
    if (req.method === 'HEAD') return res.end();
    stats.active++; stats.peak = Math.max(stats.peak, stats.active);
    res.on('close', () => { stats.active--; });
    await delay(700); // hold every request open so truly parallel connections overlap
    res.end(data.subarray(start, end + 1));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  return { server, data, stats, url: `http://127.0.0.1:${server.address().port}/big.bin` };
}
for (const connections of [42, 56, 64]) {
  test(`${connections} parallel connections download a file correctly and really run in parallel`, async t => {
    const { root, engine } = await setup(t);
    const s = await rangeServer();
    t.after(() => new Promise(resolve => { s.server.close(resolve); s.server.closeAllConnections?.(); }));
    await engine.updateSettings({ connections, maxConcurrent: 1 });
    const [id] = await engine.add({ url: s.url });
    const started = Date.now();
    while (Date.now() - started < 60000) {
      const d = engine.downloads.find(x => x.id === id);
      if (d.status === 'complete') break;
      assert.notEqual(d.status, 'error', d.error);
      await delay(100);
    }
    const d = engine.downloads.find(x => x.id === id);
    assert.equal(d.status, 'complete');
    assert.equal(d.segments.length, connections);
    assert.equal(d.connections, connections);
    assert.equal(s.stats.peak, connections, 'all ranges were open at the same time');
    const hash = buf => createHash('sha256').update(buf).digest('hex');
    assert.equal(hash(await fs.readFile(d.path)), hash(s.data));
  });
}
test('connection limit is 64 and 65 is rejected', async t => {
  const { engine } = await setup(t);
  await engine.updateSettings({ connections: 64 });
  assert.equal(engine.settings.connections, 64);
  assert.throws(() => engine.updateSettings({ connections: 65 }), /Invalid connections/);
  assert.equal(engine.settings.connections, 64);
});
