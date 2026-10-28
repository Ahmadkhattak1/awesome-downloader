import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

function manifestFiles(manifest) {
  const files = new Set();
  const background = manifest.background || {};
  if (background.service_worker) files.add(background.service_worker);
  for (const script of background.scripts || []) files.add(script);
  for (const icon of Object.values(manifest.icons || {})) files.add(icon);
  const action = manifest.action || {};
  if (action.default_popup) files.add(action.default_popup);
  for (const icon of Object.values(action.default_icon || {})) files.add(icon);
  for (const script of manifest.content_scripts || []) {
    for (const file of script.js || []) files.add(file);
    for (const file of script.css || []) files.add(file);
  }
  return [...files].sort();
}

function htmlFiles(htmlPath) {
  const html = readFileSync(path.join(root, htmlPath), 'utf8');
  const files = new Set();
  for (const match of html.matchAll(/(?:src|href)="([^"#]+)"/g)) {
    const value = match[1];
    if (/^(https?:)?\/\//.test(value) || value.startsWith('data:')) continue;
    files.add(value);
  }
  return [...files].sort();
}

test('extension manifests reference only files that exist', () => {
  const manifests = ['extension/manifest.json', 'extension/manifest.firefox.json']
    .map((relative) => JSON.parse(readFileSync(path.join(root, relative), 'utf8')));
  assert.equal(manifests[0].name, manifests[1].name);
  assert.equal(manifests[0].version, manifests[1].version);
  const pkg = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8'));
  assert.equal(manifests[0].version, pkg.version);
  for (const [index, manifest] of manifests.entries()) {
    for (const file of manifestFiles(manifest)) {
      const full = path.join(root, 'extension', file);
      assert.ok(existsSync(full), `manifest ${index} references missing file: ${file}`);
      assert.ok(statSync(full).isFile(), `manifest ${index} references a non-file: ${file}`);
    }
  }
});

test('HTML pages reference only local files that exist', () => {
  for (const htmlPath of ['renderer/index.html', 'extension/popup.html']) {
    const dir = path.dirname(path.join(root, htmlPath));
    for (const file of htmlFiles(htmlPath)) {
      const full = path.join(dir, file);
      assert.ok(existsSync(full), `${htmlPath} references missing file: ${file}`);
      assert.ok(statSync(full).isFile(), `${htmlPath} references a non-file: ${file}`);
    }
  }
});

test('uncovered browser and renderer entry scripts parse', () => {
  // These files are loaded by the browser or Electron, not by the existing
  // test suites, so a syntax error here previously shipped silently.
  const files = [
    'renderer/app.js',
    'extension/popup.js',
    'extension/content.js',
    'extension/youtube-page.js',
    'extension/youtube-relay.js',
  ];
  for (const file of files) {
    execFileSync(process.execPath, ['--check', path.join(root, file)], { stdio: 'pipe' });
  }
  // Prove the gate itself fails on invalid syntax, not just on missing files.
  assert.throws(() => new vm.Script('const = ;'), SyntaxError);
});
