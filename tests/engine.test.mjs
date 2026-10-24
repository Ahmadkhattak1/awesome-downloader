import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomBytes, createHash } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { DownloadEngine, safeFilename } from '../core/engine.mjs';
import { startBridge } from '../core/bridge.mjs';

async function fixture(t, options = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'awesome-download-test-'));
  const data = randomBytes(3 * 1024 * 1024 + 37);
  const ranges = [];
  const server = http.createServer((req, res) => {
    if (req.url === '/redirect') { res.writeHead(302, { location: '/file.bin' }); return res.end(); }
    if (req.url === '/missing') { res.writeHead(404); return res.end(); }
    const noRange = req.url === '/plain';
    res.setHeader('etag', options.etag || '"fixture-1"');
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
test('pause then resume from saved partial bytes produces exact output', async t => {
  const f = await fixture(t, { slow: true });
  const [id] = await f.engine.add({ url: `${f.url}/file.bin` }); const d = f.engine.downloads[0];
  await until(() => d.downloaded > 150000); await f.engine.action(id, 'pause');
  assert.equal(d.status, 'paused'); const partial = d.downloaded; assert.ok(partial > 0 && partial < f.data.length);
  const priorRanges = f.ranges.length;
  await f.engine.action(id, 'resume'); await until(() => ['complete', 'error'].includes(d.status));
  assert.equal(d.status, 'complete', d.error); assert.equal(digest(await fs.readFile(d.path)), digest(f.data));
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
test('invalid batches fail atomically; reserved Windows names are sanitized', async t => {
  const f = await fixture(t);
  await assert.rejects(f.engine.add({ urls: [`${f.url}/file.bin`, 'file:///C:/secret'] })); assert.equal(f.engine.downloads.length, 0);
  assert.equal(safeFilename('../../CON.exe'), 'download_CON.exe');
  await assert.rejects(f.engine.add({ url: `${f.url}/stream.mpd` }), /muxing engine/);
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

test('server ignoring ranges fails without publishing corrupt files', async t => {
  const f = await fixture(t);
  await f.engine.add({ url: `${f.url}/ignore-range` }); const d = f.engine.downloads[0];
  await until(() => d.status === 'error'); assert.match(d.error, /instead of a byte range/);
  assert.equal(d.path, null);
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
