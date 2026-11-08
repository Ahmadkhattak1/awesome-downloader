import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { Readable } from 'node:stream';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomBytes, createHash } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import ffmpegPath from 'ffmpeg-static';
import { DownloadEngine, safeFilename } from '../core/engine.mjs';
import { startBridge } from '../core/bridge.mjs';
import { probe, retryAfter, transientStatus } from '../core/http.mjs';

async function fixture(t, options = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'awesome-download-test-'));
  const data = randomBytes(3 * 1024 * 1024 + 37);
  const ranges = [];
  const server = http.createServer((req, res) => {
    if (options.intercept?.(req, res)) return;
    if (req.url === '/redirect') { res.writeHead(302, { location: '/file.bin' }); return res.end(); }
    if (req.url === '/missing') { res.writeHead(404); return res.end(); }
    if (req.url === '/head-zero' && req.method === 'HEAD') {
      res.writeHead(200, { 'content-length': '0', etag: '"fixture-1"' });
      return res.end();
    }
    const noRange = req.url === '/plain';
    res.setHeader('etag', options.etag || '"fixture-1"');
    if (options.disposition) res.setHeader('content-disposition', options.disposition);
    if (!noRange) res.setHeader('accept-ranges', 'bytes');
    let start = 0, end = data.length - 1;
    if (req.headers.range && req.url === '/ignore-range') { res.setHeader('content-length', data.length); return res.end(data); }
    if (req.headers.range && !noRange) {
      [, start, end] = /^bytes=(\d+)-(\d+)$/.exec(req.headers.range).map(Number);
      ranges.push([start, end]);
      res.statusCode = 206; res.setHeader('content-range', `bytes ${start}-${end}/${data.length}`);
    }
    res.setHeader('content-length', end - start + 1);
    if (req.method === 'HEAD') return res.end();
    if (options.slow) {
      let offset = start;
      const interval = setInterval(() => {
        if (offset > end) { clearInterval(interval); res.end(); return; }
        const until = Math.min(end + 1, offset + 16384); res.write(data.subarray(offset, until)); offset = until;
      }, 5);
      res.on('close', () => clearInterval(interval));
    } else res.end(data.subarray(start, end + 1));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const engine = await new DownloadEngine({ dataDirectory: path.join(root, 'state'), downloadDirectory: path.join(root, 'downloads'), tickMs: 30 }).init();
  t.after(async () => { await engine.close(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); await fs.rm(root, { recursive: true, force: true }); });
  return { engine, data, ranges, root, url: `http://127.0.0.1:${server.address().port}` };
}

test('truncated sequential response never publishes a completed file', async t => {
  const methods = [];
  let bodyBytesSent = 0;
  const f = await fixture(t, { intercept(req, res) {
    methods.push(req.method);
    res.setHeader('content-length', '100000');
    if (req.method === 'HEAD') { res.end(); return true; }
    res.write(Buffer.alloc(100), () => {
      bodyBytesSent += 100;
      setTimeout(() => res.destroy(), 5);
    });
    return true;
  } });
  await f.engine.add({ url: f.url + '/truncated' });
  const d = f.engine.downloads[0];
  await until(() => d.status === 'error');
  assert.equal(methods[0], 'HEAD', 'metadata discovery must succeed before transfer');
  assert.ok(methods.includes('GET'), 'must exercise the transfer, not an earlier discovery failure');
  assert.ok(bodyBytesSent >= 100, 'the fixture must actually deliver a partial response');
  assert.equal(d.connections, 1, 'this regression must use the sequential transfer path');
  assert.equal(d.path, null);
  assert.notEqual(d.status, 'complete');
  const files = await fs.readdir(path.join(f.root, 'downloads')).catch(error => {
    if (error.code === 'ENOENT') return [];
    throw error;
  });
  assert.deepEqual(files, []);
});

test('canceling an unstarted browser review never requests media', async t => {
  let requests = 0;
  const f = await fixture(t, { intercept() { requests++; return false; } });
  const [id] = await f.engine.add({ url: f.url + '/file.bin', reviewOnly: true, reuseActive: true });
  await f.engine.action(id, 'cancel');
  await delay(80);
  assert.equal(requests, 0);
  assert.equal(f.engine.downloads.find(d => d.id === id).status, 'cancelled');
});

test('canceling discovery during Retry-After prevents every later retry', async t => {
  const controller = new AbortController();
  let requests = 0;
  const f = await fixture(t, { intercept(req, res) {
    requests++;
    res.writeHead(503, { 'retry-after': '1' });
    res.end();
    setTimeout(() => controller.abort(), 20);
    return true;
  } });
  await assert.rejects(probe(f.url + '/file.bin', {}, controller.signal), { name: 'AbortError' });
  await delay(1100);
  assert.equal(requests, 1);
});

test('permanent discovery rejection does not consume transient retry budget', async t => {
  const methods = [];
  const f = await fixture(t, { intercept(req, res) {
    methods.push(req.method);
    res.writeHead(403);
    res.end();
    return true;
  } });
  await assert.rejects(probe(f.url + '/file.bin', {}, new AbortController().signal), /HTTP 403/);
  assert.deepEqual(methods, ['HEAD', 'GET'], 'one HEAD and one compatibility GET, with no retries');
});

test('repeated concurrent browser clicks reuse one active download but allow retry after cancel',async t=>{
  const f=await fixture(t);
  const request={url:f.url+'/file.bin',queueOnly:true,reuseActive:true};
  const ids=await Promise.all([f.engine.add(request),f.engine.add(request),f.engine.add(request)]);
  assert.equal(new Set(ids.flat()).size,1);assert.equal(f.engine.downloads.length,1);
  await f.engine.action(ids[0][0],'cancel');
  const retry=await f.engine.add(request);
  assert.notEqual(retry[0],ids[0][0]);
});

test('review prompt supports Download Later and cancellation without transferring bytes',async t=>{
  const f=await fixture(t),request={url:f.url+'/file.bin',reviewOnly:true,reuseActive:true};
  const [id]=await f.engine.add(request);
  assert.deepEqual(await f.engine.add(request),[id]);
  await f.engine.reviewDownload({id,queueOnly:true});
  await delay(40);
  const d=f.engine.downloads.find(d=>d.id===id);
  assert.equal(d.status,'paused');assert.equal(d.needsReview,false);assert.equal(d.downloaded,0);
  const [cancelId]=await f.engine.add({...request,url:f.url+'/plain'});
  await f.engine.action(cancelId,'remove');
  assert.equal(f.engine.downloads.some(d=>d.id===cancelId),false);
});

test('browser SABR reuse identifies video and quality rather than expiring URL',async t=>{
  const f=await fixture(t);
  const sabr={videoId:'wLdZWyLOJCI',serverAbrStreamingUrl:'https://r1.googlevideo.com/videoplayback?sabr=1',videoPlaybackUstreamerConfig:'AQID',audioItag:140,videoItag:137,formats:[
    {itag:137,mimeType:'video/mp4',qualityLabel:'1080p'},
    {itag:136,mimeType:'video/mp4',qualityLabel:'720p'},
    {itag:140,mimeType:'audio/mp4',audioQuality:'AUDIO_QUALITY_MEDIUM'}]};
  const request={url:sabr.serverAbrStreamingUrl,sabr,outputFormat:'mp4',queueOnly:true,reuseActive:true};
  const first=await f.engine.add(request);
  assert.deepEqual(await f.engine.add({...request,url:request.url+'&new=1',sabr:{...sabr,serverAbrStreamingUrl:request.url+'&new=1'}}),first);
  assert.notDeepEqual(await f.engine.add({...request,sabr:{...sabr,videoItag:136}}),first);
});
async function until(check, timeout = 8000) {
  const deadline = Date.now() + timeout;
  while (!check()) { if (Date.now() > deadline) throw new Error('Timed out waiting for download state.'); await delay(15); }
}
const digest = b => createHash('sha256').update(b).digest('hex');

test('paired tracks keep ranged transfers and skip the unranged fallback', async t => {
  const f = await fixture(t);
  const [id] = await f.engine.add({ url: `${f.url}/video.bin`, audioUrl: `${f.url}/audio.bin`, queueOnly: true });
  const d = f.engine.downloads.find(item => item.id === id);
  const modes = [];
  f.engine.transfer = async (_download, info, _segment, _file, _headers, _signal, _url, allowUnrangedFallback) => {
    modes.push({ ranges: info.ranges, allowUnrangedFallback: Boolean(allowUnrangedFallback) });
    throw new Error('stop after inspecting paired-track transfer mode');
  };
  await assert.rejects(
    f.engine.runPairedTracks(d, {}, new AbortController().signal),
    /stop after inspecting paired-track transfer mode/
  );
  assert.deepEqual(modes, [
    { ranges: true, allowUnrangedFallback: false },
    { ranges: true, allowUnrangedFallback: false }
  ]);
});

test('fallback response is destroyed when resetting the parts directory fails', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'awesome-download-cleanup-test-'));
  const engine = new DownloadEngine({ dataDirectory: path.join(root, 'state'), downloadDirectory: path.join(root, 'downloads') });
  const response = Readable.from([Buffer.from('payload')]);
  response.statusCode = 200;
  response.headers = { 'content-length': '7' };
  const originalRm = fs.rm;
  fs.rm = async () => { throw Object.assign(new Error('directory is locked'), { code: 'EPERM' }); };
  try {
    await assert.rejects(
      engine.downloadUnranged({ segments: [] }, path.join(root, 'parts'), {}, new AbortController().signal, response, 'http://example.test/file'),
      { code: 'EPERM' }
    );
    assert.equal(response.destroyed, true);
  } finally {
    fs.rm = originalRm;
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('parallel ranged transfers reconstruct exact bytes and preserve existing filenames', async t => {
  const f = await fixture(t);
  await fs.mkdir(path.join(f.root, 'downloads')); await fs.writeFile(path.join(f.root, 'downloads', 'file.bin'), 'existing');
  const [id] = await f.engine.add({ url: `${f.url}/redirect` });
  const d = f.engine.downloads.find(x => x.id === id);
  await until(() => ['complete', 'error'].includes(d.status));
  assert.equal(d.status, 'complete', d.error); assert.ok(f.ranges.length > 1);
  assert.equal(digest(await fs.readFile(d.path)), digest(f.data));
  assert.equal(await fs.readFile(path.join(f.root, 'downloads', 'file.bin'), 'utf8'), 'existing');
  assert.equal(d.filename, 'file (1).bin');
});
test('malformed extended filename falls back to the plain content-disposition filename', async t => {
  const f = await fixture(t, { disposition: `attachment; filename="report.pdf"; filename*=UTF-8''report%ZZ.pdf` });
  await f.engine.add({ url: `${f.url}/opaque` });
  const d = f.engine.downloads[0];
  await until(() => ['complete', 'error'].includes(d.status));
  assert.equal(d.status, 'complete', d.error);
  assert.equal(d.filename, 'report.pdf');
});
test('pause then resume from saved partial bytes produces exact output', async t => {
  const f = await fixture(t, { slow: true });
  const [id] = await f.engine.add({ url: `${f.url}/file.bin` }); const d = f.engine.downloads[0];
  await until(() => d.downloaded > 150000); await f.engine.action(id, 'pause');
  assert.equal(d.status, 'paused'); const partial = d.downloaded; assert.ok(partial > 0 && partial < f.data.length);
  const priorRanges = f.ranges.length;
  await f.engine.action(id, 'resume'); await until(() => ['complete', 'error'].includes(d.status));
  assert.equal(d.status, 'complete', d.error); assert.equal(digest(await fs.readFile(d.path)), digest(f.data)); assert.equal(d.notice, null);
  assert.ok(f.ranges.slice(priorRanges).some(([start]) => start % Math.floor(f.data.length / d.segments.length) !== 0));
});
test('non-range server downloads sequentially and queue/scheduled history survives restart', async t => {
  const f = await fixture(t);
  await f.engine.add({ url: `${f.url}/plain` }); const d = f.engine.downloads[0];
  await until(() => ['complete', 'error'].includes(d.status)); assert.equal(d.status, 'complete', d.error);
  assert.equal(digest(await fs.readFile(d.path)), digest(f.data)); assert.equal(d.connections, 1);
  await f.engine.add({ url: `${f.url}/file.bin`, scheduledAt: new Date(Date.now() + 60000).toISOString() });
  await f.engine.close();
  const restored = await new DownloadEngine({ dataDirectory: path.join(f.root, 'state'), downloadDirectory: path.join(f.root, 'downloads') }).init();
  t.after(() => restored.close()); assert.equal(restored.downloads[1].status, 'scheduled'); assert.equal(restored.downloads[0].status, 'complete');
  await restored.close();
});
test('direct files whose CDN rejects or omits HEAD metadata use a ranged GET probe', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'awesome-download-probe-test-'));
  const data = randomBytes(4097);
  const server = http.createServer((req, res) => {
    if (req.method === 'HEAD') { res.writeHead(403); return res.end(); }
    if (req.headers.range !== 'bytes=0-0') { res.writeHead(416); return res.end(); }
    res.writeHead(206, {
      'accept-ranges': 'bytes',
      'content-range': `bytes 0-0/${data.length}`,
      'content-length': '1',
      etag: '"probe-1"'
    });
    res.end(data.subarray(0, 1));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); await fs.rm(root, { recursive: true, force: true }); });
  const info = await probe(`http://127.0.0.1:${server.address().port}/coursera.mp4`, {}, new AbortController().signal);
  assert.equal(info.total, data.length);
  assert.equal(info.ranges, true);
  assert.equal(info.validator, '"probe-1"');
});
test('probe retries transient HEAD failures and honours Retry-After', async t => {
  let headRequests = 0;
  const f = await fixture(t, { intercept: (req, res) => {
    if (req.method !== 'HEAD') return false;
    headRequests++;
    if (headRequests === 1) {
      res.writeHead(503, { 'retry-after': '1' });
      res.end();
      return true;
    }
    return false;
  } });
  const started = Date.now();
  const info = await probe(`${f.url}/file.bin`, {}, new AbortController().signal);
  assert.equal(info.total, f.data.length);
  assert.equal(headRequests, 2);
  assert.ok(Date.now() - started >= 900, 'probe must not retry before Retry-After');
});

test('probe retries transient ranged discovery failures and honours Retry-After', async t => {
  let rangedRequests = 0;
  const f = await fixture(t, { intercept: (req, res) => {
    if (req.method === 'HEAD') {
      res.writeHead(405);
      res.end();
      return true;
    }
    if (req.method === 'GET' && req.headers.range) {
      rangedRequests++;
      if (rangedRequests === 1) {
        res.writeHead(503, { 'retry-after': '1' });
        res.end();
        return true;
      }
    }
    return false;
  } });
  const started = Date.now();
  const info = await probe(`${f.url}/file.bin`, {}, new AbortController().signal);
  assert.equal(info.total, f.data.length);
  assert.equal(info.ranges, true);
  assert.equal(rangedRequests, 2);
  assert.ok(Date.now() - started >= 900, 'probe must not retry before Retry-After');
});

test('probe stops after its bounded transient retry budget', async t => {
  let headRequests = 0, rangedRequests = 0;
  const f = await fixture(t, { intercept: (req, res) => {
    if (req.method === 'HEAD') {
      headRequests++;
      res.writeHead(503);
      res.end();
      return true;
    }
    if (req.method === 'GET' && req.headers.range) rangedRequests++;
    return false;
  } });
  await assert.rejects(
    probe(`${f.url}/file.bin`, {}, new AbortController().signal),
    /HTTP 503 after 4 probe attempts/
  );
  assert.equal(headRequests, 4);
  assert.equal(rangedRequests, 0);
});

test('probe stops rather than violating a long Retry-After cooldown', async t => {
  let headRequests = 0;
  const f = await fixture(t, { intercept: (req, res) => {
    if (req.method !== 'HEAD') return false;
    headRequests++;
    res.writeHead(429, { 'retry-after': '3600' });
    res.end();
    return true;
  } });
  await assert.rejects(
    probe(`${f.url}/file.bin`, {}, new AbortController().signal),
    /longer cooldown.*3600 seconds/
  );
  assert.equal(headRequests, 1);
});

test('misleading zero-length HEAD metadata falls back to GET and downloads the real file', async t => {
  const f = await fixture(t);
  const [id] = await f.engine.add({ url: `${f.url}/head-zero` });
  const d = f.engine.downloads.find(item => item.id === id);
  await until(() => ['complete', 'error'].includes(d.status));
  assert.equal(d.status, 'complete', d.error);
  assert.equal(d.total, f.data.length);
  assert.ok(f.ranges.some(([start, end]) => start === 0 && end === 0));
  assert.equal(digest(await fs.readFile(d.path)), digest(f.data));
});
test('a zero-length HEAD confirmed by a 416 range response remains a valid empty file', async t => {
  const requests = [];
  const f = await fixture(t, { intercept(req, res) {
    if (req.url !== '/empty') return false;
    requests.push([req.method, req.headers.range || null]);
    if (req.method === 'HEAD') {
      res.writeHead(200, { 'content-length': '0', etag: '"empty-1"' });
      res.end();
    } else if (req.headers.range === 'bytes=0-0') {
      res.writeHead(416, { 'content-range': 'bytes */0' });
      res.end();
    } else {
      res.writeHead(500);
      res.end();
    }
    return true;
  } });
  const [id] = await f.engine.add({ url: `${f.url}/empty` });
  const d = f.engine.downloads.find(item => item.id === id);
  await until(() => ['complete', 'error'].includes(d.status));
  assert.equal(d.status, 'complete', d.error);
  assert.equal(d.total, 0);
  assert.equal((await fs.stat(d.path)).size, 0);
  assert.deepEqual(requests, [['HEAD', null], ['GET', 'bytes=0-0']]);
});
test('a failed zero-length HEAD is not converted to an empty-file success', async t => {
  const server = http.createServer((req, res) => {
    if (req.method === 'HEAD') res.writeHead(403, { 'content-length': '0' });
    else res.writeHead(416, { 'content-range': 'bytes */0' });
    res.end();
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
  await assert.rejects(
    probe(`http://127.0.0.1:${server.address().port}/forbidden`, {}, new AbortController().signal),
    /Server returned HTTP 403\./
  );
});
test('probe fallback to ranged GET reports actual failure status when HEAD returned 200 without metadata', async t => {
  const server = http.createServer((req, res) => {
    if (req.method === 'HEAD') { res.writeHead(200); return res.end(); }
    res.writeHead(404);
    res.end();
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
  await assert.rejects(
    probe(`http://127.0.0.1:${server.address().port}/notfound.mp4`, {}, new AbortController().signal),
    /Server returned HTTP 404\./
  );
});
test('invalid batches fail atomically; reserved Windows names are sanitized', async t => {
  const f = await fixture(t);
  await assert.rejects(f.engine.add({ urls: [`${f.url}/file.bin`, 'file:///C:/secret'] })); assert.equal(f.engine.downloads.length, 0);
  assert.equal(safeFilename('../../CON.exe'), 'download_CON.exe');
  await assert.rejects(f.engine.add({ url: `${f.url}/stream.mpd` }), /muxing engine/);
});
test('long filenames retain their extension and automatic category', async t => {
  const f = await fixture(t);
  const original = `${'a'.repeat(200)}.pdf`;
  const shortened = safeFilename(original);
  assert.equal(shortened.length, 180);
  assert.ok(shortened.endsWith('.pdf'));
  await f.engine.add({ url: `${f.url}/opaque`, filename: original, queueOnly: true });
  assert.equal(f.engine.downloads[0].filename, shortened);
  assert.equal(f.engine.downloads[0].category, 'Documents');
});
test('bridge requires token and rejects web origins before enqueuing', async t => {
  const f = await fixture(t); const bridge = await startBridge(f.engine, { dataDirectory: path.join(f.root, 'state'), port: 0 });
  t.after(() => bridge.close()); const endpoint = `http://127.0.0.1:${bridge.port}/downloads`;
  const { token } = JSON.parse(await fs.readFile(path.join(f.root, 'state', 'bridge.json'), 'utf8'));
  assert.equal((await fetch(endpoint, { method: 'POST', body: '{}' })).status, 401);
  const headers = { 'content-type': 'application/json', authorization: `Bearer ${token}` };
  assert.equal((await fetch(endpoint, { method: 'POST', headers: { ...headers, origin: 'https://example.com' }, body: '{}' })).status, 403);
  const response = await fetch(endpoint, { method: 'POST', headers, body: JSON.stringify({ url: `${f.url}/file.bin` }) });
  assert.equal(response.status, 201); assert.equal((await response.json()).ids.length, 1);
});

test('resume explains a restart when the file changed on the server', async t => {
  const options = { slow: true }, f = await fixture(t, options);
  const [id] = await f.engine.add({ url: `${f.url}/file.bin` }); const d = f.engine.downloads[0];
  await until(() => d.downloaded > 150000); await f.engine.action(id, 'pause');
  options.etag = '"fixture-2"';
  await f.engine.action(id, 'resume'); await until(() => d.notice || d.status === 'error');
  assert.match(d.notice, /changed on the server; restarted from the beginning/);
  await until(() => ['complete', 'error'].includes(d.status));
  assert.equal(d.status, 'complete', d.error); assert.equal(digest(await fs.readFile(d.path)), digest(f.data));
  assert.match(f.engine.snapshot().downloads[0].notice, /changed on the server/);
});

test('resume explains a restart when the server does not support ranges', async t => {
  const f = await fixture(t, { slow: true });
  const [id] = await f.engine.add({ url: `${f.url}/plain` }); const d = f.engine.downloads[0];
  await until(() => d.downloaded > 150000); await f.engine.action(id, 'pause');
  await f.engine.action(id, 'resume'); await until(() => ['complete', 'error'].includes(d.status));
  assert.equal(d.status, 'complete', d.error); assert.match(d.notice, /does not support resuming/);
});

test('restart recovers paused offsets from actual disk files', async t => {
  const f = await fixture(t, { slow: true });
  const [id] = await f.engine.add({ url: `${f.url}/file.bin` });
  await until(() => f.engine.downloads[0].downloaded > 100000);
  await f.engine.close();
  const restored = await new DownloadEngine({ dataDirectory: path.join(f.root, 'state'), downloadDirectory: path.join(f.root, 'downloads'), tickMs: 30 }).init();
  try {
    assert.equal(restored.downloads[0].status, 'paused');
    await restored.action(id, 'resume');
    await until(() => ['complete', 'error'].includes(restored.downloads[0].status));
    const d = restored.downloads[0]; assert.equal(d.status, 'complete', d.error);
    assert.equal(digest(await fs.readFile(d.path)), digest(f.data));
  } finally { await restored.close(); }
});

test('server ignoring ranges falls back to its full response and preserves exact bytes', async t => {
  const f = await fixture(t);
  await f.engine.add({ url: `${f.url}/ignore-range` });
  const d = f.engine.downloads[0];
  await until(() => ['complete', 'error'].includes(d.status));
  assert.equal(d.status, 'complete', d.error);
  assert.equal(d.connections, 1);
  assert.equal(digest(await fs.readFile(d.path)), digest(f.data));
});

test('HTTP 416 on a ranged request retries as one plain GET', async t => {
  let rangedRequests = 0, plainRequests = 0;
  const f = await fixture(t, { intercept: (req, res) => {
    if (req.method !== 'GET') return false;
    if (req.headers.range) {
      rangedRequests++;
      res.writeHead(416);
      res.end();
      return true;
    }
    plainRequests++;
    return false;
  } });
  await f.engine.add({ url: `${f.url}/file.bin` });
  const d = f.engine.downloads[0];
  await until(() => ['complete', 'error'].includes(d.status));
  assert.equal(d.status, 'complete', d.error);
  assert.ok(rangedRequests > 0);
  assert.equal(plainRequests, 1);
  assert.equal(d.connections, 1);
  assert.equal(digest(await fs.readFile(d.path)), digest(f.data));
});

test('permanent HTTP failures on byte ranges fail without retrying', async t => {
  const requests = new Map();
  const f = await fixture(t, { intercept: (req, res) => {
    if (req.method !== 'GET' || !req.headers.range) return false;
    requests.set(req.headers.range, (requests.get(req.headers.range) || 0) + 1);
    res.writeHead(403); res.end(); return true;
  } });
  await f.engine.add({ url: `${f.url}/file.bin` }); const d = f.engine.downloads[0];
  await until(() => d.status === 'error'); assert.match(d.error, /HTTP 403/);
  assert.ok(requests.size > 0); assert.deepEqual([...requests.values()].filter(n => n > 1), []);
});

test('503 with Retry-After waits as instructed, then completes the range', async t => {
  let failed = null, failedAt = 0, retriedAt = 0;
  const f = await fixture(t, { intercept: (req, res) => {
    if (req.method !== 'GET' || !req.headers.range) return false;
    if (!failed) { failed = req.headers.range; failedAt = Date.now(); res.writeHead(503, { 'retry-after': '1' }); res.end(); return true; }
    if (req.headers.range === failed && !retriedAt) retriedAt = Date.now();
    return false;
  } });
  await f.engine.add({ url: `${f.url}/file.bin` }); const d = f.engine.downloads[0];
  await until(() => ['complete', 'error'].includes(d.status));
  assert.equal(d.status, 'complete', d.error); assert.equal(digest(await fs.readFile(d.path)), digest(f.data));
  assert.ok(retriedAt - failedAt >= 900, `retried after ${retriedAt - failedAt}ms`);
});

test('long server cooldown stops without issuing an early retry', async t => {
  const requests=new Map();
  const f=await fixture(t,{intercept:(req,res)=>{
    if(req.method!=='GET'||!req.headers.range)return false;
    requests.set(req.headers.range,(requests.get(req.headers.range)||0)+1);
    res.writeHead(429,{'retry-after':'3600'});res.end();return true;
  }});
  await f.engine.add({url:`${f.url}/file.bin`});const d=f.engine.downloads[0];
  await until(()=>d.status==='error');
  assert.match(d.error,/3600 seconds/);
  assert.ok(requests.size>0);assert.ok([...requests.values()].every(count=>count===1));
  assert.equal(d.path,null);
});

test('cancel interrupts a Retry-After wait immediately', async t => {
  let throttled = false;
  const f = await fixture(t, { intercept: (req, res) => {
    if (req.method !== 'GET' || !req.headers.range) return false;
    throttled = true; res.writeHead(429, { 'retry-after': '30' }); res.end(); return true;
  } });
  const [id] = await f.engine.add({ url: `${f.url}/file.bin` }); const d = f.engine.downloads[0];
  await until(() => throttled && d.status === 'downloading'); await delay(100);
  const started = Date.now(); await f.engine.action(id, 'cancel');
  assert.equal(d.status, 'cancelled'); assert.ok(Date.now() - started < 2000);
});

test('Retry-After preserves server cooldowns and excludes unsupported protocol responses', () => {
  const now = Date.parse('2026-01-01T00:00:00Z');
  assert.equal(retryAfter('5', now), 5000);
  assert.equal(retryAfter('Thu, 01 Jan 2026 00:00:10 GMT', now), 10000);
  assert.equal(retryAfter('Wed, 31 Dec 2025 23:59:00 GMT', now), 0);
  assert.equal(retryAfter('3600', now), 3600000);
  assert.deepEqual([501,505,600].map(transientStatus),[false,false,false]);
  assert.equal(retryAfter('soon', now), null); assert.equal(retryAfter(undefined, now), null);
  assert.deepEqual([408, 429, 500, 503].map(transientStatus), [true, true, true, true]);
  assert.deepEqual([400, 403, 404, 410, 416].map(transientStatus), [false, false, false, false, false]);
});

test('cancel releases queue capacity and removes partial files', async t => {
  const f = await fixture(t, { slow: true });
  await f.engine.updateSettings({ maxConcurrent: 1 });
  const [first, second] = await f.engine.add({ urls: [`${f.url}/a.bin`, `${f.url}/b.bin`] });
  await until(() => f.engine.downloads[0].downloaded > 80000);
  assert.equal(f.engine.downloads[1].status, 'queued');
  await f.engine.action(first, 'cancel'); assert.equal(f.engine.downloads[0].status, 'cancelled');
  assert.equal(f.engine.downloads[0].downloaded, 0);
  await assert.rejects(fs.stat(path.join(f.root, 'state', 'parts', first)), { code: 'ENOENT' });
  await until(() => f.engine.downloads.find(d => d.id === second).status === 'complete');
});

test('scheduled downloads start when due and settings reject invalid changes atomically', async t => {
  const f = await fixture(t);
  const before = { ...f.engine.settings };
  assert.throws(() => f.engine.updateSettings({ maxConcurrent: 1, connections: -1 }));
  assert.deepEqual(f.engine.settings, before);
  await f.engine.add({ url: `${f.url}/file.bin`, scheduledAt: new Date(Date.now() + 120).toISOString() });
  assert.equal(f.engine.downloads[0].status, 'scheduled');
  await until(() => f.engine.downloads[0].status === 'complete');
});

test('Windows startup is enabled by default and only accepts a boolean setting', async t => {
  const f = await fixture(t);
  assert.equal(f.engine.settings.startWithWindows, true);
  assert.throws(() => f.engine.updateSettings({ startWithWindows: 'yes' }), /Invalid startWithWindows/);
  await f.engine.updateSettings({ startWithWindows: false });
  assert.equal(f.engine.settings.startWithWindows, false);
});

test('browser review persists pending intent and starts only after confirmation', async t => {
  const f = await fixture(t);
  const [id] = await f.engine.add({ url: `${f.url}/file.bin`, reviewOnly: true });
  const d = f.engine.downloads[0]; await delay(80);
  assert.equal(d.status, 'paused'); assert.equal(d.downloaded, 0); assert.equal(d.needsReview, true);
  await assert.rejects(f.engine.action(id, 'resume'), /Confirm/);
  await f.engine.reviewDownload({ id, filename: 'confirmed.bin', directory: path.join(f.root, 'chosen'), category: 'Other', description: 'Reviewed by user' });
  await until(() => ['complete', 'error'].includes(d.status));
  assert.equal(d.status, 'complete', d.error); assert.equal(d.needsReview, false);
  assert.equal(d.description, 'Reviewed by user'); assert.equal(path.dirname(d.path), path.join(f.root, 'chosen'));
  assert.equal(digest(await fs.readFile(d.path)), digest(f.data));
});

test('global rate cap bounds combined segment throughput', async t => {
  const f = await fixture(t);
  await f.engine.updateSettings({ speedLimitKbps: 1024 });
  const start = Date.now(); await f.engine.add({ url: `${f.url}/file.bin` });
  const d = f.engine.downloads[0]; await until(() => ['complete', 'error'].includes(d.status), 12000);
  assert.equal(d.status, 'complete', d.error);
  assert.ok(Date.now() - start >= 2400, 'aggregate bandwidth should be limited, not each connection separately');
});

test('request credentials are excluded from history and UI snapshots', async t => {
  const f = await fixture(t);
  await f.engine.add({ url: `${f.url}/file.bin`, reviewOnly: true, headers: { cookie: 'session=private-fixture', authorization: 'Bearer private-fixture' } });
  assert.doesNotMatch(JSON.stringify(f.engine.snapshot()), /private-fixture/);
  assert.doesNotMatch(await fs.readFile(path.join(f.root, 'state', 'downloads.json'), 'utf8'), /private-fixture/);
});

test('plain fallback after a cross-origin redirect never forwards request credentials', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'awesome-download-two-origin-test-'));
  const data = randomBytes(3 * 1024 * 1024 + 37);
  const credentials = { cookie: 'session=synthetic-fixture', authorization: 'Bearer synthetic-fixture', origin: 'https://origin-a.example', referer: 'https://origin-a.example/private?page=1' };
  const seen = { head: null, ranged: null, plain: null };
  let plainRequests = 0;
  const target = http.createServer((req, res) => {
    if (req.method === 'HEAD') {
      seen.head = { ...req.headers };
      res.writeHead(200, { 'accept-ranges': 'bytes', 'content-length': data.length, etag: '"two-origin-1"' });
      return res.end();
    }
    if (req.headers.range) {
      seen.ranged = { ...req.headers };
      res.writeHead(416);
      return res.end();
    }
    plainRequests++;
    seen.plain = { ...req.headers };
    res.writeHead(200, { 'content-length': data.length });
    res.end(data);
  });
  await new Promise(resolve => target.listen(0, '127.0.0.1', resolve));
  const seenAtRedirector = [];
  const redirector = http.createServer((req, res) => {
    seenAtRedirector.push({ ...req.headers });
    res.writeHead(302, { location: `http://127.0.0.1:${target.address().port}/file.bin` });
    res.end();
  });
  await new Promise(resolve => redirector.listen(0, '127.0.0.1', resolve));
  const engine = await new DownloadEngine({ dataDirectory: path.join(root, 'state'), downloadDirectory: path.join(root, 'downloads'), tickMs: 30 }).init();
  t.after(async () => {
    await engine.close();
    for (const server of [target, redirector]) { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
    await fs.rm(root, { recursive: true, force: true });
  });
  await engine.add({ url: `http://127.0.0.1:${redirector.address().port}/file.bin`, headers: credentials });
  const d = engine.downloads[0];
  await until(() => ['complete', 'error'].includes(d.status));
  assert.equal(d.status, 'complete', d.error);
  assert.ok(seenAtRedirector.length > 0);
  assert.ok(seenAtRedirector.every(h => h.authorization === credentials.authorization && h.cookie === credentials.cookie));
  assert.ok(seen.head && seen.ranged && seen.plain);
  assert.equal(plainRequests, 1);
  for (const phase of ['head', 'ranged', 'plain']) {
    assert.equal(seen[phase].authorization, undefined, `${phase} request leaked authorization to the redirected origin`);
    assert.equal(seen[phase].cookie, undefined, `${phase} request leaked cookie to the redirected origin`);
    assert.equal(seen[phase].origin, undefined, `${phase} request leaked origin to the redirected origin`);
    assert.equal(seen[phase].referer, undefined, `${phase} request leaked referer to the redirected origin`);
  }
  assert.equal(digest(await fs.readFile(d.path)), digest(data));
});

// Holds a full-response fallback body until every sibling range worker has been
// served its failure, so mixed-outcome tests cannot pass on siblings that were
// silently aborted before requesting. Bounded: on deadline the held headers are
// flushed and the body is cut instead of released (a mid-stream server failure),
// and the timer is always cleared.
function heldFallbackBody(data, res, state) {
  const deadline = Date.now() + 2000;
  let timer = null;
  const stop = () => { if (timer !== null) { clearTimeout(timer); timer = null; } };
  res.on('close', stop);
  const poll = () => {
    if (state.siblingsForbidden >= state.expectedSiblings) { stop(); res.end(data); return; }
    if (Date.now() > deadline) {
      stop();
      res.flushHeaders();
      timer = setTimeout(() => { timer = null; res.destroy(); }, 20);
      return;
    }
    timer = setTimeout(poll, 5);
  };
  poll();
}

test('a full-response fallback completes exact bytes when sibling range workers fail', async t => {
  const state = { siblingsForbidden: 0, expectedSiblings: 0 };
  let fullResponses = 0;
  const f = await fixture(t, { intercept: (req, res) => {
    if (req.method !== 'GET' || !req.headers.range) return false;
    const start = Number(/^bytes=(\d+)-/.exec(req.headers.range)[1]);
    if (start === 0) {
      fullResponses++;
      res.writeHead(200, { 'content-length': f.data.length });
      heldFallbackBody(f.data, res, state);
      return true;
    }
    state.siblingsForbidden++;
    res.writeHead(403);
    res.end();
    return true;
  } });
  // One worker per segment; every non-first worker must actually be served a 403.
  state.expectedSiblings = Math.min(f.engine.settings.connections, Math.ceil(f.data.length / (512 * 1024))) - 1;
  assert.ok(state.expectedSiblings > 0);
  const [id] = await f.engine.add({ url: `${f.url}/file.bin` });
  const d = f.engine.downloads[0];
  await until(() => ['complete', 'error'].includes(d.status));
  assert.equal(d.status, 'complete', d.error);
  assert.equal(fullResponses, 1);
  assert.equal(state.siblingsForbidden, state.expectedSiblings);
  assert.equal(d.connections, 1);
  assert.equal(d.error, null);
  assert.equal(digest(await fs.readFile(d.path)), digest(f.data));
  await assert.rejects(fs.stat(path.join(f.root, 'state', 'parts', id)), { code: 'ENOENT' });
});

test('a fallback body held for a missing sibling is destroyed on deadline, never released', async t => {
  const state = { siblingsForbidden: 0, expectedSiblings: 0 };
  let fullResponses = 0;
  const f = await fixture(t, { intercept: (req, res) => {
    if (req.method !== 'GET' || !req.headers.range) return false;
    const start = Number(/^bytes=(\d+)-/.exec(req.headers.range)[1]);
    if (start === 0) {
      fullResponses++;
      res.writeHead(200, { 'content-length': f.data.length });
      heldFallbackBody(f.data, res, state);
      return true;
    }
    state.siblingsForbidden++;
    res.writeHead(403);
    res.end();
    return true;
  } });
  // Demand one more sibling failure than the segments can produce: the barrier
  // must time out and cut the response instead of hanging or completing.
  state.expectedSiblings = Math.min(f.engine.settings.connections, Math.ceil(f.data.length / (512 * 1024)));
  const started = Date.now();
  await f.engine.add({ url: `${f.url}/file.bin` });
  const d = f.engine.downloads[0];
  await until(() => d.status === 'error');
  assert.ok(Date.now() - started < 6000, `held fallback took ${Date.now() - started}ms to fail`);
  assert.match(d.error, /aborted/);
  assert.equal(fullResponses, 1);
  assert.equal(state.siblingsForbidden, state.expectedSiblings - 1);
  assert.equal(d.path, null);
  const leftover = await fs.readdir(path.join(f.root, 'downloads')).catch(e => e.code === 'ENOENT' ? [] : Promise.reject(e));
  assert.deepEqual(leftover, []);
});

test('cancelling while the full-response fallback streams leaves no completed file', async t => {
  const f = await fixture(t, { intercept: (req, res) => {
    if (req.method !== 'GET' || !req.headers.range) return false;
    const start = Number(/^bytes=(\d+)-/.exec(req.headers.range)[1]);
    if (start !== 0) { res.writeHead(403); res.end(); return true; }
    res.writeHead(200, { 'content-length': f.data.length });
    let offset = 0;
    const interval = setInterval(() => {
      if (offset >= f.data.length) { clearInterval(interval); res.end(); return; }
      const until = Math.min(f.data.length, offset + 16384);
      res.write(f.data.subarray(offset, until));
      offset = until;
    }, 5);
    res.on('close', () => clearInterval(interval));
    return true;
  } });
  const [id] = await f.engine.add({ url: `${f.url}/file.bin` });
  const d = f.engine.downloads[0];
  await until(() => d.downloaded > 100000);
  await f.engine.action(id, 'cancel');
  assert.equal(d.status, 'cancelled');
  assert.equal(d.path, null);
  await assert.rejects(fs.stat(path.join(f.root, 'state', 'parts', id)), { code: 'ENOENT' });
  const leftover = await fs.readdir(path.join(f.root, 'downloads')).catch(e => e.code === 'ENOENT' ? [] : Promise.reject(e));
  assert.deepEqual(leftover, []);
});

test('a truncated full-response fallback fails instead of saving a partial file', async t => {
  const f = await fixture(t, { intercept: (req, res) => {
    if (req.method !== 'GET') return false;
    if (req.headers.range) { res.writeHead(416); res.end(); return true; }
    res.writeHead(200, { 'content-length': f.data.length });
    // Advertise the full length, then cut the connection halfway through.
    res.write(f.data.subarray(0, f.data.length >> 1), () => res.socket.destroy());
    return true;
  } });
  await f.engine.add({ url: `${f.url}/file.bin` });
  const d = f.engine.downloads[0];
  await until(() => d.status === 'error');
  assert.match(d.error, /aborted/);
  assert.equal(d.path, null);
  const leftover = await fs.readdir(path.join(f.root, 'downloads')).catch(e => e.code === 'ENOENT' ? [] : Promise.reject(e));
  assert.deepEqual(leftover, []);
});

test('restarting mid-fallback discards the partial body and resumes to exact bytes', async t => {
  let slow = true;
  const f = await fixture(t, { intercept: (req, res) => {
    if (req.method !== 'GET') return false;
    if (req.headers.range) { res.writeHead(416); res.end(); return true; }
    res.writeHead(200, { 'content-length': f.data.length });
    if (!slow) { res.end(f.data); return true; }
    let offset = 0;
    const interval = setInterval(() => {
      if (offset >= f.data.length) { clearInterval(interval); res.end(); return; }
      const until = Math.min(f.data.length, offset + 16384);
      res.write(f.data.subarray(offset, until));
      offset = until;
    }, 5);
    res.on('close', () => clearInterval(interval));
    return true;
  } });
  const [id] = await f.engine.add({ url: `${f.url}/file.bin` });
  await until(() => f.engine.downloads[0].downloaded > 100000);
  await f.engine.action(id, 'pause');
  assert.equal(f.engine.downloads[0].status, 'paused');
  const partial = f.engine.downloads[0].downloaded;
  assert.ok(partial > 0 && partial < f.data.length);
  await f.engine.close();
  slow = false;
  const restored = await new DownloadEngine({ dataDirectory: path.join(f.root, 'state'), downloadDirectory: path.join(f.root, 'downloads'), tickMs: 30 }).init();
  try {
    assert.equal(restored.downloads[0].status, 'paused');
    await restored.action(id, 'resume');
    await until(() => ['complete', 'error'].includes(restored.downloads[0].status));
    const d = restored.downloads[0];
    assert.equal(d.status, 'complete', d.error);
    assert.match(d.notice, /changed on the server; restarted from the beginning/);
    assert.equal(digest(await fs.readFile(d.path)), digest(f.data));
  } finally { await restored.close(); }
});

const execFileAsync = promisify(execFile);
// Tiny valid tracks generated with the bundled ffmpeg, so the paired-download
// fixture muxes real media instead of empty or synthetic byte strings.
test('paired tracks mux real media from a range-only server', async t => {
  const mediaDir = await fs.mkdtemp(path.join(os.tmpdir(), 'awesome-download-media-'));
  const videoPath = path.join(mediaDir, 'video.mp4'), audioPath = path.join(mediaDir, 'audio.m4a');
  await execFileAsync(ffmpegPath, ['-nostdin', '-v', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc=duration=1:size=128x96:rate=5', '-pix_fmt', 'yuv420p', '-c:v', 'libx264', videoPath]);
  await execFileAsync(ffmpegPath, ['-nostdin', '-v', 'error', '-y', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=1', '-c:a', 'aac', audioPath]);
  const video = await fs.readFile(videoPath), audio = await fs.readFile(audioPath);
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'awesome-download-paired-test-'));
  const seen = { videoRanges: 0, audioRanges: 0 };
  // Range-only tracks: a valid 206 for the requested range, HTTP 403 without one.
  const serve = (body, tag, counter) => (req, res) => {
    res.setHeader('etag', tag);
    res.setHeader('accept-ranges', 'bytes');
    if (req.method === 'HEAD') { res.setHeader('content-length', body.length); return res.end(); }
    const match = /^bytes=(\d+)-(\d+)$/.exec(req.headers.range || '');
    if (!match) { res.statusCode = 403; return res.end('Range header required'); }
    const start = Number(match[1]), end = Number(match[2]);
    counter();
    res.statusCode = 206;
    res.setHeader('content-range', `bytes ${start}-${end}/${body.length}`);
    res.setHeader('content-length', end - start + 1);
    res.end(body.subarray(start, end + 1));
  };
  const videoServer = http.createServer(serve(video, '"pair-video-1"', () => seen.videoRanges++));
  const audioServer = http.createServer(serve(audio, '"pair-audio-1"', () => seen.audioRanges++));
  for (const server of [videoServer, audioServer]) await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const engine = await new DownloadEngine({ dataDirectory: path.join(root, 'state'), downloadDirectory: path.join(root, 'downloads'), tickMs: 30 }).init();
  t.after(async () => {
    await engine.close();
    for (const server of [videoServer, audioServer]) { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
    await fs.rm(root, { recursive: true, force: true });
    await fs.rm(mediaDir, { recursive: true, force: true });
  });
  await engine.add({ url: `http://127.0.0.1:${videoServer.address().port}/video.mp4`, audioUrl: `http://127.0.0.1:${audioServer.address().port}/audio.m4a` });
  const d = engine.downloads[0];
  await until(() => ['complete', 'error'].includes(d.status));
  assert.equal(d.status, 'complete', d.error);
  // Paired tracks must keep ranged transfers: this server rejects plain GETs.
  assert.ok(seen.videoRanges > 0, 'video track must use a ranged request');
  assert.ok(seen.audioRanges > 0, 'audio track must use a ranged request');
  // Both tracks must be fully consumed; a zero-byte part used to reach FFmpeg.
  assert.equal(d.segments[0].downloaded, video.length);
  assert.equal(d.segments[1].downloaded, audio.length);
  // The muxed output must decode: an empty video part used to fail this step.
  await execFileAsync(ffmpegPath, ['-nostdin', '-v', 'error', '-i', d.path, '-f', 'null', '-']);
});
