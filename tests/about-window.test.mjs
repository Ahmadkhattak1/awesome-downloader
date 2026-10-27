import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const require = createRequire(import.meta.url);
const { buildAboutInfo, diagnosticsText, LINKS } = require('../desktop/about-window.cjs');
const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');

test('About info carries version, runtime, license and third-party notices', () => {
  const info = buildAboutInfo({ version: '1.2.3', versions: { electron: '44', chrome: '140', node: '22', v8: '14' }, root, dataDirectory: 'C:\\data', packaged: true });
  assert.equal(info.version, '1.2.3'); assert.equal(info.runtime.Electron, '44'); assert.match(info.license, /MIT/);
  assert.ok(info.thirdParty.length > 10); assert.ok(info.links.every(l => l.url.startsWith('https://')) && info.links === LINKS);
  assert.match(diagnosticsText(info), /Awesome Downloader 1\.2\.3\nElectron: 44/);
  assert.equal(buildAboutInfo({ version: '1', root: path.join(root, 'nope') }).license, '');
});
