import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { unzipSync } from 'fflate';
import packageExtension from '../scripts/package-extension.mjs';

async function writeFiles(directory, files) {
  await Promise.all(
    Object.entries(files).map(async ([relativePath, content]) => {
      await fs.mkdir(path.dirname(path.join(directory, relativePath)), { recursive: true });
      await fs.writeFile(path.join(directory, relativePath), content);
    }),
  );
}

const sampleManifest = {
  manifest_version: 3,
  name: 'Sample',
  version: '1.2.3',
  background: { service_worker: 'background.js' },
  icons: { 16: 'icons/icon16.png' },
  action: { default_popup: 'popup.html' },
  content_scripts: [{ matches: ['https://*/*'], js: ['content.js'] }],
};

test('the store package holds the extension files with manifest.json at the root', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'ad-extension-package-'));
  const extensionDirectory = path.join(root, 'extension');

  await writeFiles(extensionDirectory, {
    'manifest.json': JSON.stringify(sampleManifest),
    'background.js': 'self;',
    'content.js': 'document;',
    'popup.html': '<!doctype html>',
    'icons/icon16.png': 'png',
    'background.test.cjs': 'test',
    'manifest.firefox.json': '{}',
    '.DS_Store': 'finder',
    'icons/.DS_Store': 'finder',
  });

  const { archivePath } = await packageExtension({
    extensionDirectory,
    outputDirectory: path.join(root, 'out'),
  });

  assert.equal(path.basename(archivePath), 'Awesome-Downloader-Extension-1.2.3.zip');

  const entries = unzipSync(new Uint8Array(await fs.readFile(archivePath)));

  assert.deepEqual(Object.keys(entries).sort(), [
    'background.js',
    'content.js',
    'icons/icon16.png',
    'manifest.json',
    'popup.html',
  ]);

  assert.equal(new TextDecoder().decode(entries['background.js']), 'self;');
});

test('a manifest that points at a missing file is refused', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'ad-extension-package-'));
  const extensionDirectory = path.join(root, 'extension');

  await writeFiles(extensionDirectory, {
    'manifest.json': JSON.stringify(sampleManifest),
    'background.js': 'self;',
    'popup.html': '<!doctype html>',
    'icons/icon16.png': 'png',
  });

  await assert.rejects(
    packageExtension({ extensionDirectory, outputDirectory: path.join(root, 'out') }),
    /not packaged: content\.js/,
  );
});

test('the real extension packages with everything its manifest needs', async () => {
  const outputDirectory = await fs.mkdtemp(path.join(os.tmpdir(), 'ad-extension-package-'));
  const { archivePath, files } = await packageExtension({ outputDirectory });

  assert.ok(files.includes('manifest.json'));
  assert.ok(files.includes('background.js'));
  assert.ok(!files.some((file) => file.endsWith('.test.cjs')));
  assert.ok(!files.includes('manifest.firefox.json'));
  assert.ok((await fs.stat(archivePath)).size > 0);
});
