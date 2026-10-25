import { test } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { isDownloadableUrl } from '../core/http.mjs';
import { DownloadEngine } from '../core/engine.mjs';

test('isDownloadableUrl detects common downloadable file extensions', () => {
  const downloadable = [
    'https://example.com/files/archive.zip',
    'https://example.com/files/archive.rar',
    'https://example.com/files/archive.7z',
    'https://example.com/files/disk.iso',
    'https://example.com/files/setup.exe',
    'https://example.com/files/installer.msi',
    'https://example.com/video/movie.mp4?source=cdn#t=10',
    'https://example.com/video/clip.mkv',
    'https://example.com/audio/track.mp3',
    'https://example.com/audio/song.flac',
    'https://example.com/docs/manual.pdf',
    'https://example.com/docs/sheet.xlsx',
    'https://www.youtube.com/watch?v=dQw4w9WgXcQ',
    'https://youtu.be/dQw4w9WgXcQ',
    'https://www.youtube.com/shorts/abcdef12345'
  ];

  for (const url of downloadable) {
    assert.equal(isDownloadableUrl(url), true, `Expected ${url} to be downloadable`);
  }
});

test('isDownloadableUrl rejects non-downloadable links and non-URL text', () => {
  const rejected = [
    '',
    '   ',
    'plain text copied to clipboard',
    'C:\\Users\\Public\\Downloads\\file.zip',
    'file:///C:/Users/Public/file.zip',
    'ftp://example.com/file.zip',
    'https://user:pass@example.com/file.zip',
    'https://example.com/index.html',
    'https://example.com/about-us',
    'https://example.com/blog/article-name/'
  ];

  for (const item of rejected) {
    assert.equal(isDownloadableUrl(item), false, `Expected ${item} to be rejected`);
  }
});

test('engine settings validate and persist monitorClipboard setting', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'awesome-clipboard-test-'));
  const engine = await new DownloadEngine({
    dataDirectory: path.join(root, 'state'),
    downloadDirectory: path.join(root, 'downloads'),
    tickMs: 30
  }).init();

  t.after(async () => {
    await engine.close();
    await fs.rm(root, { recursive: true, force: true });
  });

  assert.equal(engine.settings.monitorClipboard, false);
  assert.equal(engine.snapshot().settings.monitorClipboard, false);

  await engine.updateSettings({ monitorClipboard: true });
  assert.equal(engine.settings.monitorClipboard, true);
  assert.equal(engine.snapshot().settings.monitorClipboard, true);

  await engine.updateSettings({ monitorClipboard: false });
  assert.equal(engine.settings.monitorClipboard, false);

  assert.throws(() => engine.updateSettings({ monitorClipboard: 'yes' }), /Invalid monitorClipboard/);
  assert.throws(() => engine.updateSettings({ monitorClipboard: 1 }), /Invalid monitorClipboard/);
});
