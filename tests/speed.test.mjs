import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import http2 from 'node:http2';
import { execFileSync } from 'node:child_process';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomBytes, createHash } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { DownloadEngine } from '../core/engine.mjs';
import { lookup, seed, peek, resolveHost, clearDnsCache } from '../core/dns.mjs';
import { configureTransport } from '../core/http.mjs';

const digest = b => createHash('sha256').update(b).digest('hex');
async function until(check, timeout = 20000) { const end = Date.now() + timeout; while (!check()) { if (Date.now() > end) throw new Error('timeout'); await delay(15); } }
function handler(data, stats) {
  return (req, res) => {
    stats.requests++;
    res.setHeader('etag', '"speed-1"'); res.setHeader('accept-ranges', 'bytes');
    let start = 0, end = data.length - 1;
    if (req.headers.range) { [, start, end] = /^bytes=(\d+)-(\d+)$/.exec(req.headers.range).map(Number); res.statusCode = 206; res.setHeader('content-range', `bytes ${start}-${end}/${data.length}`); }
    res.setHeader('content-length', end - start + 1);
    if (req.method === 'HEAD') return res.end();
    res.end(data.subarray(start, end + 1));
  };
}
async function engineFor(t, extra = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'speed-test-'));
  const engine = await new DownloadEngine({ dataDirectory: path.join(root, 's'), downloadDirectory: path.join(root, 'd'), tickMs: 30 }).init();
  if (Object.keys(extra).length) await engine.updateSettings(extra);
  t.after(async () => { await engine.close(); await fs.rm(root, { recursive: true, force: true }); });
  return { engine, root };
}
async function run(engine, url) {
  await engine.add({ url }); const d = engine.downloads.at(-1);
  await until(() => ['complete', 'error'].includes(d.status));
  assert.equal(d.status, 'complete', d.error); return d;
}

for (const workerThreads of [true, false]) {
  test(`direct seek-and-write is byte exact with workerThreads=${workerThreads} and leaves no part files`, async t => {
    const data = randomBytes(9 * 1024 * 1024 + 123), stats = { requests: 0 };
    const server = http.createServer(handler(data, stats)); await new Promise(r => server.listen(0, '127.0.0.1', r));
    t.after(() => { server.closeAllConnections(); server.close(); });
    const { engine, root } = await engineFor(t, { workerThreads, connections: 16 });
    const d = await run(engine, `http://127.0.0.1:${server.address().port}/big.bin`);
    assert.equal(d.layout, 'direct'); assert.equal(d.segments.length, 16);
    assert.equal(digest(await fs.readFile(d.path)), digest(data));
    await assert.rejects(fs.stat(path.join(root, 's', 'parts', d.id)), { code: 'ENOENT' });
  });
}

test('segments larger than one write slab (multi-slab, time-based flushes) are byte exact', async t => {
  const data = randomBytes(14 * 1024 * 1024 + 3), stats = { requests: 0 };
  const server = http.createServer(handler(data, stats)); await new Promise(r => server.listen(0, '127.0.0.1', r));
  t.after(() => { server.closeAllConnections(); server.close(); });
  const { engine } = await engineFor(t, { connections: 2 });
  const d = await run(engine, `http://127.0.0.1:${server.address().port}/slabs.bin`);
  assert.equal(d.segments.length, 2); assert.equal(digest(await fs.readFile(d.path)), digest(data));
});

test('legacy part-file mode still works when directWrite is disabled', async t => {
  const data = randomBytes(3 * 1024 * 1024 + 5), stats = { requests: 0 };
  const server = http.createServer(handler(data, stats)); await new Promise(r => server.listen(0, '127.0.0.1', r));
  t.after(() => { server.closeAllConnections(); server.close(); });
  const { engine } = await engineFor(t, { directWrite: false });
  const d = await run(engine, `http://127.0.0.1:${server.address().port}/f.bin`);
  assert.notEqual(d.layout, 'direct'); assert.equal(digest(await fs.readFile(d.path)), digest(data));
});

test('direct download resumes from committed offsets after a restart', async t => {
  const data = randomBytes(6 * 1024 * 1024 + 11);
  const server = http.createServer((req, res) => {
    res.setHeader('etag', '"r1"'); res.setHeader('accept-ranges', 'bytes');
    let start = 0, end = data.length - 1;
    if (req.headers.range) { [, start, end] = /^bytes=(\d+)-(\d+)$/.exec(req.headers.range).map(Number); res.statusCode = 206; res.setHeader('content-range', `bytes ${start}-${end}/${data.length}`); }
    res.setHeader('content-length', end - start + 1);
    if (req.method === 'HEAD') return res.end();
    if (start === 0) return res.end(data.subarray(start, end + 1)); // first block arrives at once, the rest trickle in
    let o = start; const iv = setInterval(() => { if (o > end) { clearInterval(iv); return res.end(); } const u = Math.min(end + 1, o + 32768); res.write(data.subarray(o, u)); o = u; }, 40);
    res.on('close', () => clearInterval(iv));
  });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  t.after(() => { server.closeAllConnections(); server.close(); });
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'speed-resume-')), opts = { dataDirectory: path.join(root, 's'), downloadDirectory: path.join(root, 'd'), tickMs: 30 };
  let second;
  t.after(async () => { await second?.close(); await fs.rm(root, { recursive: true, force: true }); });
  const first = await new DownloadEngine(opts).init();
  await first.add({ url: `http://127.0.0.1:${server.address().port}/f.bin` });
  await until(() => first.downloads[0].transfer?.hashing?.hashedBytes > 0); // at least one whole block is durable
  await first.close();
  const mid = first.downloads[0].ranges.reduce((n, [a, b]) => n + b - a, 0);
  assert.ok(mid > 0 && mid < data.length);
  second = await new DownloadEngine(opts).init();
  assert.equal(second.downloads[0].status, 'paused');
  await second.action(second.downloads[0].id, 'resume');
  await until(() => ['complete', 'error'].includes(second.downloads[0].status));
  assert.equal(second.downloads[0].status, 'complete', second.downloads[0].error);
  assert.equal(digest(await fs.readFile(second.downloads[0].path)), digest(data));
});

test('DNS cache serves repeat lookups, rotates addresses and honours family', async () => {
  clearDnsCache();
  seed('cdn.example.test', [{ address: '192.0.2.1', family: 4 }, { address: '192.0.2.2', family: 4 }, { address: '2001:db8::1', family: 6 }]);
  const one = (host, opts) => new Promise((resolve, reject) => lookup(host, opts, (e, a, f) => e ? reject(e) : resolve([a, f])));
  const all = (host, opts) => new Promise((resolve, reject) => lookup(host, { ...opts, all: true }, (e, l) => e ? reject(e) : resolve(l)));
  const first = (await one('cdn.example.test', {}))[0], second = (await one('cdn.example.test', {}))[0];
  assert.notEqual(first, second);
  assert.deepEqual((await all('cdn.example.test', { family: 6 })).map(a => a.address), ['2001:db8::1']);
  assert.equal((await one('127.0.0.1', {}))[0], '127.0.0.1');
  assert.ok(peek('cdn.example.test')); assert.deepEqual(await resolveHost('cdn.example.test'), peek('cdn.example.test'));
});

test('HTTP/2 over TLS: multiplexed range transfers are byte exact', async t => {
  let ca, key, cert;
  try {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'h2-cert-'));
    t.after(() => fs.rm(dir, { recursive: true, force: true }));
    execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', path.join(dir, 'k.pem'), '-out', path.join(dir, 'c.pem'), '-days', '2', '-subj', '/CN=localhost', '-addext', 'subjectAltName=DNS:localhost,IP:127.0.0.1'], { stdio: 'ignore' });
    key = await fs.readFile(path.join(dir, 'k.pem')); cert = await fs.readFile(path.join(dir, 'c.pem')); ca = cert;
  } catch { return t.skip('openssl unavailable'); }
  const data = randomBytes(40 * 1024 * 1024 + 77), stats = { requests: 0, h2: 0, sessions: 0 };
  const server = http2.createSecureServer({ key, cert, allowHTTP1: true });
  server.on('session', () => { stats.sessions++; });
  server.on('request', (req, res) => { if (req.httpVersion === '2.0') stats.h2++; handler(data, stats)(req, res); });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  t.after(() => { server.close(); });
  configureTransport({ ca }); t.after(() => configureTransport({ ca: undefined }));
  const { engine } = await engineFor(t, { connections: 12 });
  const d = await run(engine, `https://127.0.0.1:${server.address().port}/h2.bin`);
  assert.equal(digest(await fs.readFile(d.path)), digest(data));
  assert.ok(stats.h2 >= 10, `expected h2 range requests, saw ${stats.h2}`);
  assert.ok(stats.sessions <= 10, `h2 should multiplex over few connections, saw ${stats.sessions}`);
});
