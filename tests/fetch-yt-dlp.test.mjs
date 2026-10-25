import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import fetchYtDlp, { YT_DLP_RELEASE } from '../scripts/fetch-yt-dlp.mjs';

const binary = Buffer.from('#!/bin/sh\necho yt-dlp\n');
const pinned = (bytes) => createHash('sha256').update(bytes).digest('hex');

const release = {
  version: '2000.01.01',
  darwin: { asset: 'yt-dlp_macos', target: 'yt-dlp', sha256: pinned(binary) },
};

function fakeDownload(bytes, requested = []) {
  return async (url) => {
    requested.push(url);
    return { ok: true, status: 200, arrayBuffer: async () => bytes };
  };
}

test('the pinned yt-dlp is saved as an executable and reused when it matches', async () => {
  const vendorDirectory = await fs.mkdtemp(path.join(os.tmpdir(), 'ad-yt-dlp-'));
  const requested = [];
  const options = { platform: 'darwin', vendorDirectory, release };

  const first = await fetchYtDlp({ ...options, download: fakeDownload(binary, requested) });

  assert.deepEqual(requested, [
    'https://github.com/yt-dlp/yt-dlp/releases/download/2000.01.01/yt-dlp_macos',
  ]);

  assert.equal(first.downloaded, true);
  assert.deepEqual(await fs.readFile(path.join(vendorDirectory, 'yt-dlp')), binary);

  // Windows has no Unix execute bits; Node reports every file there as 666.
  if (process.platform !== 'win32') {
    assert.equal((await fs.stat(first.target)).mode.toString(8).slice(-3), '755');
  }

  const second = await fetchYtDlp({ ...options, download: fakeDownload(binary, requested) });

  assert.equal(second.downloaded, false);
  assert.equal(requested.length, 1);
});

test('a download that does not match the pinned checksum is never saved', async () => {
  const vendorDirectory = await fs.mkdtemp(path.join(os.tmpdir(), 'ad-yt-dlp-'));

  await assert.rejects(
    fetchYtDlp({
      platform: 'darwin',
      vendorDirectory,
      release,
      download: fakeDownload(Buffer.from('tampered')),
    }),
    /expected/,
  );

  assert.deepEqual(await fs.readdir(vendorDirectory), []);
});

test('only Windows and macOS builds are pinned', async () => {
  assert.deepEqual(Object.keys(YT_DLP_RELEASE).sort(), ['darwin', 'version', 'win32']);

  await assert.rejects(fetchYtDlp({ platform: 'linux', release }), /No yt-dlp build is pinned/);
});
