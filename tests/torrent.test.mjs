import { test } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomBytes, createHash } from 'node:crypto';
import WebTorrent from 'webtorrent';
import { DownloadEngine } from '../core/engine.mjs';
import { parseMagnet, parseTorrentFile, torrentSource } from '../core/torrent.mjs';

const digest = value => createHash('sha256').update(value).digest('hex');
const sha1 = value => createHash('sha1').update(value).digest('hex');
async function until(predicate, timeout = 20000) {
  const started = Date.now();
  while (Date.now() - started < timeout) { if (predicate()) return; await new Promise(resolve => setTimeout(resolve, 25)); }
  throw new Error('condition was not met in time');
}

// An independent encoder: the parser must not be validated against itself.
function bencode(value) {
  if (typeof value === 'number') return Buffer.from(`i${value}e`);
  if (Buffer.isBuffer(value)) return Buffer.concat([Buffer.from(`${value.length}:`), value]);
  if (typeof value === 'string') { const bytes = Buffer.from(value); return Buffer.concat([Buffer.from(`${bytes.length}:`), bytes]); }
  if (Array.isArray(value)) return Buffer.concat([Buffer.from('l'), ...value.map(bencode), Buffer.from('e')]);
  return Buffer.concat([Buffer.from('d'), ...Object.keys(value).sort().flatMap(key => [bencode(key), bencode(value[key])]), Buffer.from('e')]);
}

function buildTorrent({ name = 'sample.bin', files = [{ length: 2048 }], pieceLength = 16384 } = {}) {
  const total = files.reduce((sum, file) => sum + file.length, 0);
  const pieces = randomBytes(20 * Math.max(1, Math.ceil(total / pieceLength)));
  const info = files.some(file => file.path)
    ? { files: files.map(file => ({ length: file.length, path: file.path.split('/') })), name, 'piece length': pieceLength, pieces }
    : { length: files[0].length, name, 'piece length': pieceLength, pieces };
  return { info, buffer: bencode({ announce: 'http://tracker.example.test/announce', info }) };
}

const BASE32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
function toBase32(hex) {
  let bits = 0, accumulator = 0, output = '';
  for (const digit of hex) {
    accumulator = (accumulator << 4) | parseInt(digit, 16); bits += 4;
    while (bits >= 5) { bits -= 5; output += BASE32[(accumulator >> bits) & 31]; }
  }
  if (bits > 0) output += BASE32[(accumulator << (5 - bits)) & 31];
  return output;
}

test('magnet links expose their info hash, display name, trackers and size', () => {
  const hash = 'c12fe1c06bba254a9dc9f519b335aa7c1367a88a';
  const parsed = parseMagnet(`magnet:?xt=urn:btih:${hash.toUpperCase()}&dn=Ubuntu%2026.04&tr=udp%3A%2F%2Ftracker.example.test%3A80&tr=http%3A%2F%2Fbackup.example.test&xl=2048`);
  assert.equal(parsed.infoHash, hash);
  assert.equal(parsed.name, 'Ubuntu 26.04');
  assert.deepEqual(parsed.trackers, ['udp://tracker.example.test:80', 'http://backup.example.test']);
  assert.equal(parsed.length, 2048);
  assert.match(parsed.magnet, /^magnet:\?xt=urn:btih:/);
});

test('base32 magnet info hashes decode to the same hex hash', () => {
  const hash = '0123456789abcdef0123456789abcdef01234567';
  const parsed = parseMagnet(`magnet:?xt=urn:btih:${toBase32(hash)}`);
  assert.equal(parsed.infoHash, hash);
  assert.equal(parsed.name, `torrent-${hash.slice(0, 8)}`);
  assert.equal(parsed.length, null);
});

test('invalid magnets are rejected before any network work', () => {
  assert.throws(() => parseMagnet('https://example.test/file.torrent'), /magnet:\?/i);
  assert.throws(() => parseMagnet('magnet:?dn=missing-hash'), /info hash/i);
  assert.throws(() => parseMagnet('magnet:?xt=urn:btih:not-a-hash'), /invalid info hash/i);
  assert.throws(() => parseMagnet(`magnet:?xt=urn:btih:${'a'.repeat(41)}`), /invalid info hash/i);
});

test('torrent files expose name, files, total size and a matching info hash', () => {
  const { info, buffer } = buildTorrent({ name: 'bundle', files: [{ length: 1024, path: 'a.bin' }, { length: 2048, path: 'nested/b.bin' }] });
  const parsed = parseTorrentFile(buffer);
  assert.equal(parsed.name, 'bundle');
  assert.equal(parsed.length, 3072);
  assert.deepEqual(parsed.files, [{ path: 'a.bin', length: 1024 }, { path: 'nested/b.bin', length: 2048 }]);
  assert.equal(parsed.infoHash, sha1(bencode(info)));
  assert.ok(parsed.magnet.includes(parsed.infoHash));
  assert.deepEqual(parsed.trackers, ['http://tracker.example.test/announce']);
});

test('a single-file torrent keeps the file name as its only file', () => {
  const { buffer } = buildTorrent({ name: 'single.iso', files: [{ length: 4096 }] });
  const parsed = parseTorrentFile(buffer);
  assert.deepEqual(parsed.files, [{ path: 'single.iso', length: 4096 }]);
  assert.equal(parsed.length, 4096);
});

test('malformed and unsafe torrent payloads are rejected', () => {
  assert.throws(() => parseTorrentFile(Buffer.from('not a torrent')), /torrent/i);
  assert.throws(() => parseTorrentFile(Buffer.from('d4:infod4:name4:testeee')), /torrent|piece|info|size/i);
  const { info } = buildTorrent();
  const unsafe = bencode({ info: { ...info, files: [{ length: 1, path: ['..', 'escape.bin'] }] } });
  assert.throws(() => parseTorrentFile(unsafe), /unsafe path|invalid file/i);
});

test('torrentSource accepts magnets, data URLs and ignores ordinary URLs', () => {
  const hash = '89abcdef0123456789abcdef0123456789abcdef';
  assert.equal(torrentSource(`magnet:?xt=urn:btih:${hash}`)?.infoHash, hash);
  const { info, buffer } = buildTorrent();
  const fromData = torrentSource(`data:application/x-bittorrent;base64,${buffer.toString('base64')}`);
  assert.equal(fromData?.infoHash, sha1(bencode(info)));
  assert.equal(torrentSource('https://example.test/file.zip'), null);
  assert.equal(torrentSource(undefined), null);
});

test('a magnet downloads through the engine and completes with exact bytes', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'awesome-torrent-'));
  const seeder = new WebTorrent({ dht: false, tracker: false, lsd: false });
  const data = randomBytes(256 * 1024);
  const seeded = await new Promise((resolve, reject) => {
    try { seeder.seed(data, { name: 'sample.bin' }, resolve); } catch (error) { reject(error); }
  });
  const seederPort = seeder.torrentPort;
  assert.ok(seederPort, 'the seeder must listen for peer connections');

  // Local swarm: point the engine's client at the seeder as soon as it has metadata,
  // so the transfer needs no tracker or DHT.
  const leecher = new WebTorrent({ dht: false, tracker: false, lsd: false });
  const engineClient = {
    add: (...args) => {
      const torrent = leecher.add(...args);
      // No tracker or DHT here: dial the seeder directly until a wire exists.
      const dial = (attempt = 0) => {
        if (torrent.destroyed || torrent.numPeers > 0 || attempt > 20) return;
        try { torrent.addPeer(`127.0.0.1:${seederPort}`); } catch { /* retry below */ }
        setTimeout(() => dial(attempt + 1), 300).unref?.();
      };
      dial();
      return torrent;
    }
  };
  const engine = await new DownloadEngine({
    dataDirectory: path.join(root, 'state'), downloadDirectory: path.join(root, 'downloads'),
    tickMs: 20, torrentClient: engineClient
  }).init();
  const settle = client => new Promise(resolve => {
    const timer = setTimeout(resolve, 2000); timer.unref?.();
    try { client.destroy(() => { clearTimeout(timer); resolve(); }); } catch { clearTimeout(timer); resolve(); }
  });
  t.after(async () => {
    await Promise.race([engine.close(), new Promise(resolve => setTimeout(resolve, 5000))]);
    await Promise.all([settle(seeder), settle(leecher)]);
    await fs.rm(root, { recursive: true, force: true });
  });

  const [id] = await engine.add({ urls: [seeded.magnetURI] });
  const d = engine.downloads.find(item => item.id === id);
  assert.equal(d.kind, 'torrent');
  assert.equal(d.infoHash, seeded.infoHash);
  await until(() => ['complete', 'error'].includes(d.status), 30000);
  assert.equal(d.status, 'complete', d.error);
  assert.equal(d.total, data.length);
  assert.equal(d.progress, 1);
  assert.equal(d.path, path.join(root, 'downloads', 'sample.bin'));
  assert.equal(digest(await fs.readFile(d.path)), digest(data));
});

test('torrent adds validate their source and dedupe an active transfer', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'awesome-torrent-'));
  const client = new WebTorrent({ dht: false, tracker: false, lsd: false });
  const engine = await new DownloadEngine({
    dataDirectory: path.join(root, 'state'), downloadDirectory: path.join(root, 'downloads'),
    tickMs: 20, torrentClient: client
  }).init();
  t.after(async () => {
    await engine.close();
    // An injected client belongs to this test; without destroying it the swarm
    // sockets keep the whole test process alive.
    await new Promise(resolve => {
      const timer = setTimeout(resolve, 2000); timer.unref?.();
      try { client.destroy(() => { clearTimeout(timer); resolve(); }); } catch { clearTimeout(timer); resolve(); }
    });
    await fs.rm(root, { recursive: true, force: true });
  });

  await assert.rejects(() => engine.add({ urls: ['magnet:?xt=urn:btih:nothex'] }), /info hash/i);
  await assert.rejects(() => engine.add({ torrent: 'bm90IGEgdG9ycmVudA==' }), /torrent/i);

  const hash = 'abcdef0123456789abcdef0123456789abcdef01';
  const [first] = await engine.add({ urls: [`magnet:?xt=urn:btih:${hash}&dn=Cool%20Archive`] });
  const [second] = await engine.add({ magnet: `magnet:?xt=urn:btih:${hash}&dn=Cool%20Archive`, reuseActive: true });
  assert.equal(first, second);
  const d = engine.downloads.find(item => item.id === first);
  assert.equal(d.filename, 'Cool Archive');
  assert.equal(d.category, 'Other');
  await engine.action(first, 'cancel');
  assert.equal(d.status, 'cancelled');
});
