import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { setTimeout as delay } from 'node:timers/promises';
import { DownloadEngine } from '../core/engine.mjs';
import { categoryFor, extensionForMime, withExtension, looksLikeWebPage } from '../core/filetypes.mjs';
import { validFormatSelector, extractError } from '../core/extract.mjs';
const require = createRequire(import.meta.url);

async function until(check, timeout = 15000) { const end = Date.now() + timeout; while (!check()) { if (Date.now() > end) throw new Error('timeout'); await delay(10); } }
async function setup(t, { ytdlp, ffmpeg } = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'extract-test-'));
  const script = async (name, body) => { const file = path.join(root, name); await fs.writeFile(file, body); return file; };
  if (ytdlp) process.env.AWESOME_YTDLP = await script('yt-dlp.cjs', ytdlp);
  if (ffmpeg) process.env.AWESOME_FFMPEG = await script('ffmpeg.cjs', ffmpeg);
  const engine = await new DownloadEngine({ dataDirectory: path.join(root, 's'), downloadDirectory: path.join(root, 'd'), tickMs: 30 }).init();
  t.after(async () => { await engine.close(); delete process.env.AWESOME_YTDLP; delete process.env.AWESOME_FFMPEG; await fs.rm(root, { recursive: true, force: true }); });
  return { engine, root };
}
async function serve(t, handler) { const server = http.createServer(handler); await new Promise(r => server.listen(0, '127.0.0.1', r)); t.after(() => { server.closeAllConnections(); server.close(); }); return `http://127.0.0.1:${server.address().port}`; }
async function finish(engine, input) { const [id] = await engine.add(input); const d = engine.downloads.find(x => x.id === id); await until(() => ['complete', 'error'].includes(d.status)); return d; }

const FAKE_YTDLP = `
const a = process.argv.slice(2), out = a[a.indexOf('-o') + 1], dir = require('path').dirname(out), fs = require('fs');
if (process.env.FAKE_MODE === 'unsupported') { console.error('ERROR: Unsupported URL: https://x'); process.exit(1); }
if (process.env.FAKE_MODE === 'drm') { console.error('ERROR: [generic] This video is DRM protected'); process.exit(1); }
const fmtIndex = a.indexOf('-f'), merge = a.indexOf('--merge-output-format'), audio = a.indexOf('--audio-format');
const ext = audio >= 0 ? a[audio + 1] : (merge >= 0 ? a[merge + 1].split('/')[0] : 'mp4');
console.log('ADTITLE:My: Great/Video'); console.log('ADDURATION:12');
console.log('ADPROGRESS:' + JSON.stringify({ status: 'downloading', downloaded_bytes: 500, total_bytes: 1000, speed: 100, filename: 'a' }));
fs.writeFileSync(out.replace('%(ext)s', ext), Buffer.alloc(1000, 7));
fs.writeFileSync(process.env.FAKE_ARGS || require('os').devNull, JSON.stringify(a));
console.log('ADPROGRESS:' + JSON.stringify({ status: 'finished', downloaded_bytes: 1000, total_bytes: 1000, filename: 'a' }));
`;
const html = '<html><body>watch</body></html>';

test('file type tables cover many formats and map MIME types to extensions', () => {
  for (const [name, category] of [['a.mkv', 'Video'], ['a.FLV', 'Video'], ['a.opus', 'Audio'], ['a.heic', 'Images'], ['a.xz', 'Archives'], ['a.epub', 'Documents'], ['a.msix', 'Programs'], ['a.xyz', 'Other']]) assert.equal(categoryFor(name), category, name);
  assert.equal(extensionForMime('application/pdf; charset=binary'), 'pdf'); assert.equal(extensionForMime('video/x-matroska'), 'mkv'); assert.equal(extensionForMime('application/x-unknown'), '');
  assert.equal(withExtension('report', 'application/pdf'), 'report.pdf'); assert.equal(withExtension('report.txt', 'application/pdf'), 'report.txt'); assert.equal(withExtension('blob', 'application/x-unknown'), 'blob');
  assert.equal(looksLikeWebPage('text/html; charset=utf-8'), true); assert.equal(looksLikeWebPage('video/mp4'), false);
  assert.equal(validFormatSelector('bv*[height<=1080]+ba/b'), true); assert.equal(validFormatSelector('--exec calc'), false); assert.equal(validFormatSelector('a;b'), false);
  assert.equal(extractError('ERROR: This video is DRM protected').code, 'DRM'); assert.equal(extractError('ERROR: Unsupported URL: x').code, 'UNSUPPORTED');
});

test('downloads of any file type get the right name and category from Content-Type', async t => {
  const { engine } = await setup(t);
  const url = await serve(t, (req, res) => { const types = { '/doc': 'application/pdf', '/pic': 'image/png', '/clip': 'video/x-matroska', '/blob': 'application/x-unknown' }; res.setHeader('content-type', types[req.url] || 'application/octet-stream'); res.setHeader('accept-ranges', 'none'); res.end(Buffer.alloc(2048, 1)); });
  for (const [route, name, category] of [['doc', 'doc.pdf', 'Documents'], ['pic', 'pic.png', 'Images'], ['clip', 'clip.mkv', 'Video'], ['blob', 'blob', 'Other']]) {
    const d = await finish(engine, { url: `${url}/${route}` });
    assert.equal(d.status, 'complete', d.error); assert.equal(d.filename, name); assert.equal(d.category, category);
  }
});

test('a web page address is resolved by yt-dlp into the best video, named after its title', async t => {
  const { engine, root } = await setup(t, { ytdlp: FAKE_YTDLP }); process.env.FAKE_ARGS = path.join(root, 'args.json');
  t.after(() => { delete process.env.FAKE_ARGS; delete process.env.FAKE_MODE; });
  const url = await serve(t, (req, res) => { res.setHeader('content-type', 'text/html; charset=utf-8'); res.end(html); });
  await fs.access(process.env.AWESOME_YTDLP);
  const d = await finish(engine, { url: `${url}/watch?v=1`, referer: `${url}/` });
  assert.equal(d.status, 'complete', d.error); assert.equal(d.kind, 'extract'); assert.equal(d.category, 'Video');
  assert.match(d.filename, /^My.*Great.*Video\.mp4$/); assert.equal((await fs.stat(d.path)).size, 1000);
  const args = JSON.parse(await fs.readFile(process.env.FAKE_ARGS, 'utf8'));
  assert.ok(args.includes('--no-playlist') && args.includes('--ffmpeg-location') && args.includes('bv*+ba/b'));
  assert.equal(args[args.indexOf('--referer') + 1], `${url}/`);
});

test('explicit extraction with chosen quality and container (mkv / mp3)', async t => {
  const { engine } = await setup(t, { ytdlp: FAKE_YTDLP });
  const url = await serve(t, (req, res) => res.end('x'));
  const video = await finish(engine, { url: `${url}/page`, extract: true, extractFormat: 'bv*[height<=720]+ba/b', outputFormat: 'mkv' });
  assert.equal(video.status, 'complete', video.error); assert.match(video.filename, /\.mkv$/);
  const audio = await finish(engine, { url: `${url}/page2`, extract: true, outputFormat: 'mp3' });
  assert.equal(audio.status, 'complete', audio.error); assert.match(audio.filename, /\.mp3$/); assert.equal(audio.category, 'Audio');
  await assert.rejects(engine.add({ url: `${url}/p`, extract: true, extractFormat: '--exec calc' }), /selector/);
  await assert.rejects(engine.add({ url: `${url}/p`, extract: true, outputFormat: 'exe' }), /output format/);
});

test('a page without any video is saved as a normal file; DRM is refused with a clear message', async t => {
  const { engine } = await setup(t, { ytdlp: FAKE_YTDLP }); t.after(() => { delete process.env.FAKE_MODE; });
  const url = await serve(t, (req, res) => { res.setHeader('content-type', 'text/html'); res.end(html); });
  process.env.FAKE_MODE = 'unsupported';
  const saved = await finish(engine, { url: `${url}/article.html` });
  assert.equal(saved.status, 'complete', saved.error); assert.equal(saved.filename, 'article.html'); assert.equal((await fs.readFile(saved.path, 'utf8')), html);
  process.env.FAKE_MODE = 'drm';
  const drm = await finish(engine, { url: `${url}/movie`, extract: true });
  assert.equal(drm.status, 'error'); assert.match(drm.error, /DRM/);
});

test('DASH manifests are copied by ffmpeg into one file', async t => {
  const ffmpeg = `const a = process.argv.slice(2), out = a[a.length - 1], fs = require('fs');
if (!a.includes('-i') || !/\\.mpd/.test(a[a.indexOf('-i') + 1])) process.exit(2);
console.log('total_size=4096'); fs.writeFileSync(out, Buffer.alloc(4096, 3));`;
  const { engine } = await setup(t, { ffmpeg });
  const url = await serve(t, (req, res) => { res.setHeader('content-type', 'application/dash+xml'); res.end('<MPD/>'); });
  const d = await finish(engine, { url: `${url}/show/manifest.mpd` });
  assert.equal(d.status, 'complete', d.error); assert.equal(d.kind, 'stream'); assert.equal(d.filename, 'manifest.mkv'); assert.equal(d.category, 'Video');
  const mp4 = await finish(engine, { url: `${url}/show/other.mpd`, outputFormat: 'mp4' });
  assert.equal(mp4.status, 'complete', mp4.error); assert.equal(mp4.filename, 'other.mp4');
});

test('native host forwards extraction requests and still rejects unsafe ones', () => {
  const { sanitizeRequest } = require('../integration/native-host.cjs');
  const ok = sanitizeRequest({ action: 'download', url: 'https://site.example/watch/1', extract: true, extractFormat: 'bv*+ba/b', outputFormat: 'mkv' });
  assert.equal(ok.extract, true); assert.equal(ok.outputFormat, 'mkv'); assert.equal(ok.extractFormat, 'bv*+ba/b');
  assert.equal(sanitizeRequest({ action: 'download', url: 'https://a.example/x.mpd', outputFormat: 'mkv' }).outputFormat, 'mkv');
  assert.throws(() => sanitizeRequest({ action: 'download', url: 'https://a.example/x', outputFormat: 'mkv' }), /output format/);
  assert.throws(() => sanitizeRequest({ action: 'download', url: 'https://a.example/x', extract: true, extractFormat: '--exec calc' }), /selector/);
});
