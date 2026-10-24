import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { DownloadEngine } from '../core/engine.mjs';
import { parseHls, scopedHeaders } from '../core/hls.mjs';

test('HLS parser resolves real variants and segment/init URLs', () => {
  const master = parseHls('#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=100000,RESOLUTION=640x360\nlow/index.m3u8\n#EXT-X-STREAM-INF:BANDWIDTH=900000,RESOLUTION=1920x1080\nhigh/index.m3u8', 'https://example.com/master.m3u8');
  assert.equal(master.variants[0].resolution, '1920x1080');
  assert.equal(master.variants[0].url, 'https://example.com/high/index.m3u8');
  const media = parseHls('#EXTM3U\n#EXT-X-MAP:URI="init.mp4"\n#EXTINF:4,\na.m4s\n#EXTINF:5,\nb.m4s\n#EXT-X-ENDLIST', 'https://example.com/v/index.m3u8');
  assert.equal(media.duration, 9); assert.equal(media.extension, '.mp4');
  assert.deepEqual(media.urls, ['https://example.com/v/init.mp4', 'https://example.com/v/a.m4s', 'https://example.com/v/b.m4s']);
});
test('HLS rejects unsupported formats and selects the associated audio group', () => {
  assert.throws(() => parseHls('#EXTM3U\n#EXT-X-KEY:METHOD=AES-128,URI="key"\n#EXTINF:3,\na.ts\n#EXT-X-ENDLIST', 'https://example.com/a'), /Encrypted/);
  assert.throws(() => parseHls('#EXTM3U\n#EXTINF:3,\na.ts', 'https://example.com/a'), /Live/);
  assert.throws(() => parseHls('#EXTM3U\n#EXT-X-BYTERANGE:100@0\na.ts\n#EXT-X-ENDLIST', 'https://example.com/a'), /byte-range/);
  const paired = parseHls('#EXTM3U\n#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="sound",URI="audio.m3u8"\n#EXT-X-STREAM-INF:BANDWIDTH=3,AUDIO="sound"\nv.m3u8', 'https://example.com/a');
  assert.equal(paired.variants[0].audioUrl,'https://example.com/audio.m3u8');
  assert.deepEqual(scopedHeaders({ cookie: 'private', authorization: 'Bearer private', referer: 'https://page.test' }, 'https://a.test/a', 'https://b.test/b'), { referer: 'https://page.test' });
});
test('HLS VOD downloads in parallel, resumes completed segments, and assembles exact byte order', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'awesome-hls-test-'));
  const pieces = Array.from({ length: 6 }, (_, i) => Buffer.alloc(256 * 1024, i + 1));
  const server = http.createServer((req, res) => {
    if (req.url === '/master.m3u8') return res.end('#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=900000,RESOLUTION=1280x720\n/video.m3u8');
    if (req.url === '/video.m3u8') return res.end('#EXTM3U\n' + pieces.map((_, i) => `#EXTINF:5,\n/${i}.ts`).join('\n') + '\n#EXT-X-ENDLIST');
    const index = Number.parseInt(req.url.slice(1));
    if (!pieces[index]) { res.writeHead(404); return res.end(); }
    res.setHeader('content-length', pieces[index].length);
    let pos = 0;
    const timer = setInterval(() => { const chunk = pieces[index].subarray(pos, pos + 16384); pos += chunk.length; res.write(chunk); if (pos === pieces[index].length) { clearInterval(timer); res.end(); } }, 10);
    res.on('close', () => clearInterval(timer));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const engine = await new DownloadEngine({ dataDirectory: path.join(root, 'state'), downloadDirectory: path.join(root, 'out'), tickMs: 20 }).init();
  t.after(async () => { await engine.close(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); await fs.rm(root, { recursive: true, force: true }); });
  await engine.updateSettings({ connections: 2 });
  const [id] = await engine.add({ url: `http://127.0.0.1:${server.address().port}/master.m3u8` });
  const d = engine.downloads[0];
  const until = async check => { const end = Date.now() + 8000; while (!check()) { if (Date.now() > end) throw new Error('HLS timeout: ' + d.error); await delay(10); } };
  await until(() => d.downloaded > 600000 || d.status === 'error');
  assert.notEqual(d.status, 'error', d.error); await engine.action(id, 'pause');
  assert.equal(d.status, 'paused'); assert.ok(d.segments.some(s => s.done));
  await engine.action(id, 'resume'); await until(() => ['complete', 'error'].includes(d.status));
  assert.equal(d.status, 'complete', d.error); assert.equal(d.filename, 'master.ts');
  assert.deepEqual(await fs.readFile(d.path), Buffer.concat(pieces)); assert.equal(d.duration, 30);
});
