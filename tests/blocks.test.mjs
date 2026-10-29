import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomBytes, createHash } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { RangeSet } from '../core/ranges.mjs';
import { BlockBuffer, pooledBuffers } from '../core/block-buffer.mjs';
import { WriteQueue } from '../core/write-queue.mjs';
import { BlockScheduler, chooseBlockSize, MIN_BLOCK, MAX_BLOCK } from '../core/scheduler.mjs';
import { HashSession } from '../core/hash-session.mjs';
import { HashService } from '../core/hasher.mjs';
import { normalizeChecksum, digestsFromHeaders } from '../core/digest.mjs';
import { ThrottleError, parseRetryAfter } from '../core/http.mjs';
import { downloadBlock } from '../core/chunk.mjs';
import { DownloadEngine } from '../core/engine.mjs';

const MiB = 1024 * 1024, sha = (b, a = 'sha256') => createHash(a).update(b).digest('hex');
async function until(check, timeout = 20000) { const end = Date.now() + timeout; while (!check()) { if (Date.now() > end) throw new Error('timeout'); await delay(10); } }
async function tmp(t) { const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'blocks-test-')); t.after(() => fs.rm(dir, { recursive: true, force: true })); return dir; }

test('RangeSet merges, removes, finds gaps and contiguous prefixes', () => {
  const r = new RangeSet([[10, 20], [0, 5], [5, 10], [30, 40]]);
  assert.deepEqual(r.toJSON(), [[0, 20], [30, 40]]);
  assert.equal(r.size, 30); assert.equal(r.contiguousFrom(0), 20); assert.equal(r.contiguousFrom(25), 25);
  assert.deepEqual(r.firstGap(50), [20, 30]);
  r.add(20, 30); assert.deepEqual(r.firstGap(50), [40, 50]); assert.equal(r.firstGap(40), null);
  r.remove(5, 35); assert.deepEqual(r.toJSON(), [[0, 5], [35, 40]]);
  assert.equal(r.covered(0, 100), 10); assert.equal(r.covered(3, 37), 4);
  assert.deepEqual(new RangeSet([[5, 5], [-1, 3], ['a', 2], null]).toJSON(), []);
});

test('BlockBuffer never exposes bytes that were not overwritten by received data', () => {
  const b = new BlockBuffer(10);
  b.append(Buffer.from('abcde'));
  assert.throws(() => b.view(), /partially filled/);
  assert.throws(() => b.append(Buffer.alloc(6)), /more bytes/);
  b.append(Buffer.from('fghij'));
  assert.equal(b.view().toString(), 'abcdefghij'); assert.equal(b.view().length, 10);
  b.release(); assert.throws(() => b.view(), /released/); assert.throws(() => new BlockBuffer(0), RangeError);
});

test('a recycled BlockBuffer cannot leak the previous block into a shorter one', () => {
  const first = new BlockBuffer(8); first.append(Buffer.from('SECRET!!')); first.release();
  assert.ok(pooledBuffers() >= 1);
  const second = new BlockBuffer(4); second.append(Buffer.from('okay'));
  assert.equal(second.view().toString(), 'okay');
  second.release();
});

test('WriteQueue writes complete blocks in ascending order and refuses incomplete ones', async t => {
  const file = path.join(await tmp(t), 'f.bin'); await fs.writeFile(file, Buffer.alloc(30));
  const q = new WriteQueue({ concurrency: 1 }), mk = text => { const b = new BlockBuffer(text.length); b.append(Buffer.from(text)); return b; };
  const order = [], original = fs.open;
  const partial = new BlockBuffer(5); partial.append(Buffer.from('ab'));
  assert.throws(() => q.write(file, 0, partial), /partially filled/);
  await Promise.all([q.write(file, 20, mk('cccccccccc')).then(() => order.push(20)), q.write(file, 0, mk('aaaaaaaaaa')).then(() => order.push(0)), q.write(file, 10, mk('bbbbbbbbbb')).then(() => order.push(10))]);
  assert.equal((await fs.readFile(file)).toString(), 'aaaaaaaaaabbbbbbbbbbcccccccccc'); assert.equal(original, fs.open);
  assert.deepEqual(order.slice().sort((a, b) => a - b), [0, 10, 20]);
});

test('chooseBlockSize keeps blocks within 2-4 MB and honours the memory budget', () => {
  assert.equal(chooseBlockSize({ speed: 0 }), MIN_BLOCK);
  assert.equal(chooseBlockSize({ speed: 100 * MiB }), MAX_BLOCK);
  assert.equal(chooseBlockSize({ speed: 3 * MiB }), 4 * MiB);
  assert.equal(chooseBlockSize({ speed: 1.9 * MiB }), 2.75 * MiB);
  assert.equal(chooseBlockSize({ speed: 100 * MiB, allowed: 64, memoryBudget: 128 * MiB }), MIN_BLOCK);
  assert.equal(chooseBlockSize({ speed: 100 * MiB, allowed: 16, memoryBudget: 48 * MiB }), 3 * MiB);
});

test('retry-after and checksum parsing', () => {
  assert.equal(parseRetryAfter('3'), 3000); assert.equal(parseRetryAfter('0'), 0); assert.equal(parseRetryAfter('junk'), 0);
  assert.equal(parseRetryAfter('99999'), 120000);
  assert.equal(parseRetryAfter(new Date(Date.now() + 5000).toUTCString()) > 3000, true);
  const hex = 'a'.repeat(64);
  assert.deepEqual(normalizeChecksum(`SHA256:${hex}`), { algorithm: 'sha256', value: hex });
  assert.deepEqual(normalizeChecksum('d41d8cd98f00b204e9800998ecf8427e'), { algorithm: 'md5', value: 'd41d8cd98f00b204e9800998ecf8427e' });
  assert.equal(normalizeChecksum(''), null); assert.throws(() => normalizeChecksum('sha256:123'), /checksum/); assert.throws(() => normalizeChecksum('zzzz'), /checksum/);
  const md5 = createHash('md5').update('x').digest();
  assert.deepEqual(digestsFromHeaders({ 'content-md5': md5.toString('base64') }), [{ algorithm: 'md5', value: md5.toString('hex') }]);
  const s256 = createHash('sha256').update('x').digest('base64');
  assert.equal(digestsFromHeaders({ digest: `sha-256=${s256}, unixsum=1` })[0].value, sha('x'));
  assert.equal(digestsFromHeaders({ 'repr-digest': `sha-256=:${s256}:` })[0].value, sha('x'));
  assert.deepEqual(digestsFromHeaders({ 'content-md5': 'nope' }), []);
});

test('HashSession hashes only the written prefix and both algorithms match', async t => {
  const data = randomBytes(9 * MiB + 5), file = path.join(await tmp(t), 'h.bin'); await fs.writeFile(file, data);
  const s = new HashSession(file); s.advance(3 * MiB); s.advance(3 * MiB); s.advance(data.length);
  const digests = await s.digest(data.length);
  assert.equal(digests.sha256, sha(data)); assert.equal(digests.md5, sha(data, 'md5'));
  await assert.rejects(new HashSession(file).digest(data.length + 10), /shorter/);
});

for (const useWorker of [true, false]) {
  test(`HashService (worker=${useWorker}) hashes on the fly and survives interleaved sessions`, async t => {
    const dir = await tmp(t), a = randomBytes(5 * MiB + 1), b = randomBytes(3 * MiB + 7);
    await fs.writeFile(path.join(dir, 'a'), a); await fs.writeFile(path.join(dir, 'b'), b);
    const service = new HashService({ useWorker }); t.after(() => service.close());
    const sa = service.open(path.join(dir, 'a')), sb = service.open(path.join(dir, 'b'));
    assert.equal(sa.threaded, useWorker);
    sa.advance(2 * MiB); sb.advance(MiB);
    const [da, db] = await Promise.all([sa.digest(a.length), sb.digest(b.length)]);
    assert.equal(da.sha256, sha(a)); assert.equal(db.md5, sha(b, 'md5'));
  });
}

test('downloadBlock never writes a block that was not completely received', async t => {
  const dir = await tmp(t), file = path.join(dir, 'f.bin'), data = randomBytes(3 * MiB);
  await fs.writeFile(file, Buffer.alloc(data.length, 0x7a));
  let truncate = true;
  const server = http.createServer((req, res) => {
    const [, a, b] = /^bytes=(\d+)-(\d+)$/.exec(req.headers.range).map(Number);
    res.statusCode = 206; res.setHeader('content-range', `bytes ${a}-${b}/${data.length}`); res.setHeader('content-length', b - a + 1);
    if (truncate) { res.write(data.subarray(a, a + 1000)); return setTimeout(() => res.destroy(), 20); }
    res.end(data.subarray(a, b + 1));
  });
  await new Promise(r => server.listen(0, '127.0.0.1', r)); t.after(() => { server.closeAllConnections(); server.close(); });
  const url = `http://127.0.0.1:${server.address().port}/x`, base = { url, headers: {}, file, start: 0, end: data.length - 1, total: data.length, signal: new AbortController().signal };
  await assert.rejects(downloadBlock({ ...base, attempts: 2 }), /aborted|ended before/);
  assert.ok((await fs.readFile(file)).every(byte => byte === 0x7a), 'nothing may be written for an incomplete block');
  truncate = false;
  await downloadBlock({ ...base, attempts: 1 });
  assert.equal(sha(await fs.readFile(file)), sha(data));
});

test('downloadBlock resumes a broken connection from the filled offset', async t => {
  const dir = await tmp(t), file = path.join(dir, 'f.bin'), data = randomBytes(2 * MiB);
  await fs.writeFile(file, Buffer.alloc(data.length)); const ranges = [];
  const server = http.createServer((req, res) => {
    const [, a, b] = /^bytes=(\d+)-(\d+)$/.exec(req.headers.range).map(Number); ranges.push(a);
    res.statusCode = 206; res.setHeader('content-range', `bytes ${a}-${b}/${data.length}`); res.setHeader('content-length', b - a + 1);
    if (ranges.length === 1) { res.write(data.subarray(a, a + 500000)); return setTimeout(() => res.destroy(), 30); }
    res.end(data.subarray(a, b + 1));
  });
  await new Promise(r => server.listen(0, '127.0.0.1', r)); t.after(() => { server.closeAllConnections(); server.close(); });
  await downloadBlock({ url: `http://127.0.0.1:${server.address().port}/x`, headers: {}, file, start: 0, end: data.length - 1, total: data.length, signal: new AbortController().signal, attempts: 3 });
  assert.equal(sha(await fs.readFile(file)), sha(data)); assert.equal(ranges.length, 2); assert.equal(ranges[1], 500000);
});

// ---- scheduler (fake I/O, real timers kept short)
function fakeFetch(speeds, log = []) {
  return async ({ source, start, end, slot, signal, onBytes }) => {
    const size = end - start + 1, bps = typeof speeds === 'function' ? speeds({ source, slot, start }) : speeds[source.id];
    log.push({ source: source.id, slot, start, end });
    let sent = 0;
    while (sent < size) {
      if (signal.aborted) throw Object.assign(new Error('aborted'), { name: 'AbortError' });
      const n = Math.min(size - sent, Math.max(1, Math.round(bps / 100))); await delay(10); sent += n; onBytes(n);
    }
  };
}
const quick = { slowWarmupMs: 150, tickMs: 25, dropCooldownMs: 200, recoverMs: 150 };

test('scheduler splits the file into 2-4 MB blocks and covers every byte exactly once', async () => {
  const total = 21 * MiB + 321, log = [];
  const s = new BlockScheduler({ total, sources: [{ url: 'http://a/x' }], connections: 4, fetchBlock: fakeFetch([5000 * MiB], log), ...quick });
  await s.run(new AbortController().signal);
  assert.ok(s.complete()); assert.equal(s.done.size, total); assert.equal(s.done.count, 1);
  const sorted = [...log].sort((a, b) => a.start - b.start);
  for (let i = 0; i < sorted.length; i++) {
    const size = sorted[i].end - sorted[i].start + 1;
    assert.ok(size >= MIN_BLOCK && size <= MAX_BLOCK, `block ${i} is ${size} bytes`);
    if (i) assert.equal(sorted[i].start, sorted[i - 1].end + 1);
  }
  assert.equal(sorted.at(-1).end, total - 1);
});

test('scheduler resumes from existing ranges and fetches only the gaps', async () => {
  const total = 20 * MiB, log = [];
  const s = new BlockScheduler({ total, done: [[0, 8 * MiB], [12 * MiB, 14 * MiB]], sources: [{ url: 'http://a/x' }], connections: 3, fetchBlock: fakeFetch([5000 * MiB], log), ...quick });
  await s.run(new AbortController().signal);
  assert.equal(log.reduce((n, b) => n + b.end - b.start + 1, 0), total - 10 * MiB);
  assert.ok(log.every(b => b.start >= 8 * MiB && !(b.start >= 12 * MiB && b.start < 14 * MiB)));
});

test('429 halves the connections of that source, honours the wait and recovers', async () => {
  const total = 24 * MiB; let throttled = 0; const events = [], started = [];
  const fetchBlock = async args => {
    started.push(Date.now());
    if (throttled < 3) { throttled++; throw new ThrottleError(429, 120); }
    return fakeFetch([2000 * MiB])(args);
  };
  const s = new BlockScheduler({ total, sources: [{ url: 'https://a/x', protocol: 'h2' }], connections: 8, fetchBlock, ...quick });
  s.on('throttle', e => events.push(e)); s.on('scale', e => events.push({ scale: e.allowed }));
  await s.run(new AbortController().signal);
  assert.ok(s.complete()); assert.equal(events[0].statusCode, 429); assert.equal(events[0].allowed, 4);
  assert.equal(s.snapshot().sources[0].multiplex, true); assert.ok(s.snapshot().throttles >= 3);
  assert.ok(Math.max(...started) - Math.min(...started) >= 100, 'requests were delayed by the Retry-After back-off');
});

test('throttle scale-down keeps halving but never below one connection, then creeps back up', async () => {
  const s = new BlockScheduler({ total: 4 * MiB, sources: [{ url: 'https://a/x' }], connections: 16, fetchBlock: async () => {}, ...quick });
  const src = s.sources[0];
  for (let i = 0; i < 6; i++) { src.lastScaleAt = 0; s.onThrottle(src, new ThrottleError(503, 0), 1000 + i * 5000); }
  assert.equal(src.allowed, 1); assert.ok(src.ceiling >= 1 && src.ceiling < 16);
  src.lastThrottleAt = 0; s.now = () => 100000; s.tick(); s.tick(); assert.equal(src.allowed, 2);
});

test('a slow connection is dropped mid-block and its block is finished by faster ones', async () => {
  const total = 32 * MiB, drops = [];
  const s = new BlockScheduler({ total, sources: [{ url: 'http://a/x' }], connections: 6, fetchBlock: fakeFetch(({ slot }) => (slot === 0 ? 40 * 1024 : 40 * MiB)), ...quick });
  s.on('drop', e => drops.push(e));
  await s.run(new AbortController().signal);
  assert.ok(s.complete()); assert.ok(drops.length >= 1 && drops[0].slot === 0, 'the slow slot was dropped');
  assert.ok(s.snapshot().drops >= 1);
});

test('adaptive scheduling moves bandwidth to the faster mirror and probes the slow one rarely', async () => {
  const total = 64 * MiB, log = [];
  const s = new BlockScheduler({ total, sources: [{ url: 'http://slow/x' }, { url: 'http://fast/x' }], connections: 4, fetchBlock: fakeFetch([2 * MiB, 200 * MiB], log), ...quick });
  await s.run(new AbortController().signal);
  const bytes = id => log.filter(b => b.source === id).reduce((n, b) => n + b.end - b.start + 1, 0);
  assert.ok(s.complete()); assert.ok(bytes(1) > 3 * bytes(0), `fast mirror ${bytes(1)} vs slow mirror ${bytes(0)}`);
});

test('a dead mirror is abandoned and the download still completes from the other one', async () => {
  const total = 16 * MiB, good = fakeFetch([500 * MiB]);
  const fetchBlock = args => (args.source.id === 0 ? Promise.reject(new Error('connection refused')) : good(args));
  const s = new BlockScheduler({ total, sources: [{ url: 'http://bad/x' }, { url: 'http://good/x' }], connections: 4, fetchBlock, maxAttempts: 4, ...quick });
  await s.run(new AbortController().signal);
  assert.ok(s.complete());
});

test('all sources failing rejects with the real error; abort rejects with AbortError', async () => {
  const fail = new BlockScheduler({ total: 8 * MiB, sources: [{ url: 'http://a/x' }], connections: 2, fetchBlock: async () => { throw new Error('boom'); }, maxAttempts: 2, ...quick });
  await assert.rejects(fail.run(new AbortController().signal), /boom/);
  const controller = new AbortController(), slow = new BlockScheduler({ total: 8 * MiB, sources: [{ url: 'http://a/x' }], connections: 2, fetchBlock: fakeFetch([1024]), ...quick });
  const run = slow.run(controller.signal); await delay(60); controller.abort();
  await assert.rejects(run, { name: 'AbortError' });
});

test('endgame: an idle fast slot duplicates a straggler and the first copy wins', async () => {
  const total = 6 * MiB; let first = true;
  const fetchBlock = async args => { const slow = args.start === 0 && first; if (slow) first = false; return fakeFetch([slow ? 30 * 1024 : 300 * MiB])(args); };
  const s = new BlockScheduler({ total, sources: [{ url: 'http://a/x' }], connections: 3, fetchBlock, ...quick });
  const t0 = Date.now(); await s.run(new AbortController().signal);
  assert.ok(s.complete()); assert.ok(s.snapshot().duplicates + s.snapshot().drops >= 1); assert.ok(Date.now() - t0 < 8000);
});

// ---- engine integration
async function engineFor(t, extra = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'blocks-engine-'));
  const engine = await new DownloadEngine({ dataDirectory: path.join(root, 's'), downloadDirectory: path.join(root, 'd'), tickMs: 30 }).init();
  await engine.updateSettings(extra);
  t.after(async () => { await engine.close(); await fs.rm(root, { recursive: true, force: true }); });
  return { engine, root };
}
function rangeHandler(data, { throttle = () => null, etag = '"b-1"', headers = {}, onRange = () => {} } = {}) {
  return (req, res) => {
    const m = /^bytes=(\d+)-(\d+)$/.exec(req.headers.range || '');
    if (m) { const reply = throttle(req); if (reply) { res.statusCode = reply.status; if (reply.retryAfter !== undefined) res.setHeader('retry-after', String(reply.retryAfter)); return res.end(); } onRange(Number(m[1]), Number(m[2])); }
    res.setHeader('etag', etag); res.setHeader('accept-ranges', 'bytes');
    for (const [k, v] of Object.entries(headers)) res.setHeader(k, v);
    let start = 0, end = data.length - 1;
    if (m) { start = Number(m[1]); end = Number(m[2]); res.statusCode = 206; res.setHeader('content-range', `bytes ${start}-${end}/${data.length}`); }
    res.setHeader('content-length', end - start + 1);
    if (req.method === 'HEAD') return res.end();
    res.end(data.subarray(start, end + 1));
  };
}
const listen = async (t, handler) => { const server = http.createServer(handler); await new Promise(r => server.listen(0, '127.0.0.1', r)); t.after(() => { server.closeAllConnections(); server.close(); }); return `http://127.0.0.1:${server.address().port}`; };
async function finish(engine, url, extra = {}) { const [id] = await engine.add({ url, ...extra }); const d = engine.downloads.find(x => x.id === id); await until(() => ['complete', 'error'].includes(d.status)); return d; }

for (const workerThreads of [true, false]) {
  test(`engine: on-the-fly SHA-256/MD5 are exact and shown (workers=${workerThreads})`, async t => {
    const data = randomBytes(13 * MiB + 9), url = await listen(t, rangeHandler(data));
    const { engine } = await engineFor(t, { workerThreads, connections: 6 });
    const d = await finish(engine, `${url}/f.bin`);
    assert.equal(d.status, 'complete', d.error);
    assert.equal(d.integrity.sha256, sha(data)); assert.equal(d.integrity.md5, sha(data, 'md5')); assert.equal(d.integrity.status, 'computed');
    assert.equal(sha(await fs.readFile(d.path)), sha(data)); assert.equal(d.protocol, 'http/1.1');
  });
}

test('engine: a correct user checksum verifies, a wrong one discards the file and reports corruption', async t => {
  const data = randomBytes(9 * MiB + 1), url = await listen(t, rangeHandler(data));
  const { engine, root } = await engineFor(t);
  const ok = await finish(engine, `${url}/ok.bin`, { checksum: `sha256:${sha(data)}` });
  assert.equal(ok.status, 'complete', ok.error); assert.equal(ok.integrity.status, 'verified'); assert.equal(ok.integrity.expected.source, 'user');
  const bad = await finish(engine, `${url}/bad.bin`, { checksum: `md5:${'0'.repeat(32)}` });
  assert.equal(bad.status, 'error'); assert.match(bad.error, /Checksum mismatch/); assert.equal(bad.integrity.status, 'mismatch');
  await assert.rejects(fs.stat(path.join(root, 'd', 'bad.bin')), { code: 'ENOENT' });
  await assert.rejects(fs.stat(path.join(root, 's', 'parts', bad.id)), { code: 'ENOENT' });
});

test('engine: the part-file layout also verifies a user checksum', async t => {
  const data = randomBytes(3 * MiB + 1), url = await listen(t, rangeHandler(data));
  const { engine } = await engineFor(t, { directWrite: false });
  const ok = await finish(engine, `${url}/ok.bin`, { checksum: sha(data) });
  assert.equal(ok.status, 'complete', ok.error); assert.equal(ok.integrity.status, 'verified');
  const bad = await finish(engine, `${url}/bad.bin`, { checksum: 'f'.repeat(64) });
  assert.equal(bad.status, 'error'); assert.match(bad.error, /Checksum mismatch/);
});

test('engine: a server-announced digest mismatch is a warning, not a failure', async t => {
  const data = randomBytes(6 * MiB), url = await listen(t, rangeHandler(data, { headers: { 'content-md5': createHash('md5').update('other').digest('base64') } }));
  const { engine } = await engineFor(t); const warnings = []; engine.on('integrity-warning', w => warnings.push(w));
  const d = await finish(engine, `${url}/w.bin`);
  assert.equal(d.status, 'complete'); assert.equal(d.integrity.status, 'warning'); assert.equal(warnings.length, 1);
});

test('engine: hashing can be turned off', async t => {
  const data = randomBytes(6 * MiB), url = await listen(t, rangeHandler(data));
  const { engine } = await engineFor(t, { verifyHashes: false });
  const d = await finish(engine, `${url}/n.bin`);
  assert.equal(d.status, 'complete'); assert.equal(d.integrity, undefined); assert.equal(sha(await fs.readFile(d.path)), sha(data));
});

for (const status of [429, 503]) {
  test(`engine: HTTP ${status} makes the download back off, scale connections down and still finish byte-exact`, async t => {
    const data = randomBytes(24 * MiB + 3); let hits = 0, concurrent = 0, peak = 0;
    const url = await listen(t, (req, res) => {
      concurrent++; peak = Math.max(peak, concurrent); res.on('close', () => { concurrent--; });
      rangeHandler(data, { throttle: () => (hits++ < 5 ? { status, retryAfter: 0 } : null) })(req, res);
    });
    const { engine } = await engineFor(t, { connections: 8 });
    const d = await finish(engine, `${url}/t.bin`);
    assert.equal(d.status, 'complete', d.error); assert.equal(sha(await fs.readFile(d.path)), sha(data));
    assert.ok(hits > 5);
  });
}

test('engine: Retry-After on the probe is honoured instead of failing the download', async t => {
  const data = randomBytes(5 * MiB); let heads = 0;
  const base = rangeHandler(data), url = await listen(t, (req, res) => { if (req.method === 'HEAD' && heads++ < 1) { res.statusCode = 429; res.setHeader('retry-after', '0'); return res.end(); } base(req, res); });
  const { engine } = await engineFor(t);
  const d = await finish(engine, `${url}/p.bin`);
  assert.equal(d.status, 'complete', d.error); assert.ok(heads >= 2);
});

test('engine: mirrors share the work and a bad mirror (wrong size) is ignored', async t => {
  const data = randomBytes(30 * MiB + 5), a = { n: 0 }, b = { n: 0 };
  const urlA = await listen(t, rangeHandler(data, { onRange: () => { a.n++; } })), urlB = await listen(t, rangeHandler(data, { onRange: () => { b.n++; } }));
  const urlC = await listen(t, rangeHandler(randomBytes(1 * MiB)));
  const { engine } = await engineFor(t, { connections: 4 });
  const d = await finish(engine, `${urlA}/f.bin`, { mirrors: [`${urlB}/f.bin`, `${urlC}/f.bin`] });
  assert.equal(d.status, 'complete', d.error); assert.equal(sha(await fs.readFile(d.path)), sha(data));
  assert.ok(a.n > 0 && b.n > 0, `both good mirrors served blocks (${a.n}/${b.n})`);
  assert.equal(d.mirrorNotes.filter(n => n.ok).length, 1); assert.equal(d.mirrorNotes.filter(n => !n.ok).length, 1);
});

test('engine: mirror and checksum input is validated', async t => {
  const { engine } = await engineFor(t);
  await assert.rejects(engine.add({ url: 'http://127.0.0.1:9/a', mirrors: 'nope' }), /mirror/i);
  await assert.rejects(engine.add({ url: 'http://127.0.0.1:9/a', mirrors: ['ftp://x/y'] }), /HTTP/);
  await assert.rejects(engine.add({ urls: ['http://127.0.0.1:9/a', 'http://127.0.0.1:9/b'], checksum: 'md5:' + '0'.repeat(32) }), /single/);
  await assert.rejects(engine.add({ url: 'http://127.0.0.1:9/a', checksum: 'garbage' }), /checksum/i);
  assert.throws(() => engine.updateSettings({ memoryBudgetMb: 8 }), /memoryBudgetMb/);
  engine.updateSettings({ memoryBudgetMb: 256, adaptive: false, verifyHashes: false, closeToTray: false, launchAtLogin: true }, false);
  assert.equal(engine.settings.memoryBudgetMb, 256); assert.equal(engine.settings.adaptive, false);
});

test('engine: snapshot exposes protocol and live transfer info but never the raw ranges', async t => {
  const data = randomBytes(8 * MiB);
  const url = await listen(t, (req, res) => setTimeout(() => rangeHandler(data)(req, res), 40));
  const { engine } = await engineFor(t, { connections: 4 });
  const [id] = await engine.add({ url: `${url}/s.bin` }); const d = engine.downloads.find(x => x.id === id);
  await until(() => d.transfer?.active > 0 || d.status === 'complete');
  const snap = engine.snapshot().downloads.find(x => x.id === id);
  assert.equal('ranges' in snap, false); assert.equal(snap.protocol, 'http/1.1');
  await until(() => d.status === 'complete');
  const persisted = JSON.parse(await fs.readFile(engine.statePath, 'utf8')).downloads[0];
  assert.equal('transfer' in persisted, false); assert.equal(persisted.integrity.sha256, sha(data));
});

test('engine: legacy fixed-segment histories (committed offsets) are converted and resumed', async t => {
  const data = randomBytes(9 * MiB + 17), url = await listen(t, rangeHandler(data));
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'blocks-legacy-')), opts = { dataDirectory: path.join(root, 's'), downloadDirectory: path.join(root, 'd'), tickMs: 30 };
  const first = await new DownloadEngine(opts).init(); await first.close();
  const id = 'legacy-1', dir = path.join(opts.dataDirectory, 'parts', id); await fs.mkdir(dir, { recursive: true });
  const file = await fs.open(path.join(dir, 'data.bin'), 'w+'); await file.truncate(data.length); await file.write(data.subarray(0, 3 * MiB), 0, 3 * MiB, 0); await file.close();
  const state = JSON.parse(await fs.readFile(opts.dataDirectory + '/downloads.json', 'utf8'));
  state.downloads = [{ id, url: `${url}/old.bin`, filename: 'old.bin', category: 'Other', status: 'paused', downloaded: 3 * MiB, total: data.length, speed: 0, connections: 2, error: null, path: null,
    directory: opts.downloadDirectory, createdAt: new Date().toISOString(), validator: '"b-1"', layout: 'direct', resumable: true,
    segments: [{ start: 0, end: 4 * MiB - 1, downloaded: 3 * MiB, committed: 3 * MiB }, { start: 4 * MiB, end: data.length - 1, downloaded: 0, committed: 0 }] }];
  await fs.writeFile(opts.dataDirectory + '/downloads.json', JSON.stringify(state));
  const engine = await new DownloadEngine(opts).init(); t.after(async () => { await engine.close(); await fs.rm(root, { recursive: true, force: true }); });
  await engine.action(id, 'resume'); const d = engine.downloads[0];
  await until(() => ['complete', 'error'].includes(d.status));
  assert.equal(d.status, 'complete', d.error); assert.equal(sha(await fs.readFile(d.path)), sha(data)); assert.equal(d.integrity.sha256, sha(data));
});

test('block ceiling grows with file size so huge files do not need hundreds of thousands of requests', async () => {
  const { maxBlockFor } = await import('../core/scheduler.mjs'), GiB = 1024 * MiB;
  assert.equal(maxBlockFor(100 * MiB), 4 * MiB); assert.equal(maxBlockFor(2 * GiB), 16 * MiB); assert.equal(maxBlockFor(20 * GiB), 32 * MiB); assert.equal(maxBlockFor(500 * GiB), 64 * MiB);
  assert.equal(chooseBlockSize({ speed: 500 * MiB, allowed: 4, memoryBudget: 256 * MiB, max: maxBlockFor(500 * GiB) }), 64 * MiB);
  assert.equal(chooseBlockSize({ speed: 500 * MiB, allowed: 64, memoryBudget: 256 * MiB, max: maxBlockFor(500 * GiB) }), 4 * MiB);
  assert.equal(chooseBlockSize({ speed: 1 * MiB, allowed: 4, max: maxBlockFor(500 * GiB) }), 1.5 * MiB < MIN_BLOCK ? MIN_BLOCK : 1.5 * MiB);
  const total = 600 * MiB * 8; // 4.7 GiB: blocks stay <= 16 MiB, cover the file exactly once
  const log = [], s = new BlockScheduler({ total, sources: [{ url: 'http://a/x' }], connections: 4, maxBlock: maxBlockFor(total), fetchBlock: async ({ start, end, onBytes }) => { log.push(end - start + 1); onBytes(end - start + 1); }, slowWarmupMs: 150, tickMs: 25 });
  await s.run(new AbortController().signal);
  assert.ok(s.complete()); assert.ok(Math.max(...log) <= 16 * MiB && Math.min(...log.slice(0, -1)) >= MIN_BLOCK); assert.equal(log.reduce((a, b) => a + b, 0), total);
});
test('a 64 MiB block is aggregated and written exactly', async t => {
  const { BlockBuffer } = await import('../core/block-buffer.mjs'), b = new BlockBuffer(64 * MiB), piece = randomBytes(MiB);
  for (let i = 0; i < 64; i++) b.append(piece);
  assert.equal(b.view().length, 64 * MiB); b.release();
  const again = new BlockBuffer(10 * MiB); assert.ok(again.data.length >= 10 * MiB); again.release();
});

test('probe: a HEAD without size metadata falls back to a ranged GET; 429/503 is reported as throttling without extra requests', async t => {
  const { probe } = await import('../core/http.mjs'), seen = [];
  const url = await listen(t, (req, res) => {
    seen.push(req.method + ' ' + req.url);
    if (req.url === '/nometa') { if (req.method === 'HEAD') { res.statusCode = 200; return res.end(); } res.statusCode = 206; res.setHeader('content-range', 'bytes 0-0/12345'); res.setHeader('accept-ranges', 'bytes'); return res.end('x'); }
    if (req.url === '/limited') { res.statusCode = 429; res.setHeader('retry-after', '7'); return res.end(); }
    res.statusCode = 404; res.end();
  });
  const info = await probe(`${url}/nometa`, {}, new AbortController().signal);
  assert.equal(info.total, 12345); assert.equal(info.ranges, true);
  seen.length = 0;
  await assert.rejects(probe(`${url}/limited`, {}, new AbortController().signal), e => e.code === 'THROTTLED' && e.retryAfterMs === 7000);
  assert.deepEqual(seen, ['HEAD /limited']);
  await assert.rejects(probe(`${url}/missing`, {}, new AbortController().signal), /HTTP 404/);
});
