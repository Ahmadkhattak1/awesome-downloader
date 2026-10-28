import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const rendererHtml = join(repositoryRoot, 'renderer', 'index.html');
const rendererScript = join(repositoryRoot, 'renderer', 'app.js');

function runSyntaxCheck(filePath) {
  return spawnSync(process.execPath, ['--check', filePath], {
    cwd: repositoryRoot,
    encoding: 'utf8',
  });
}

function diagnostics(result) {
  return [result.error?.message, result.stdout, result.stderr]
    .filter(Boolean)
    .join('\n');
}

test('renderer entry point references the local deferred app script', () => {
  assert.ok(existsSync(rendererHtml), 'renderer/index.html must exist');
  assert.ok(existsSync(rendererScript), 'renderer/app.js must exist');

  const html = readFileSync(rendererHtml, 'utf8');
  assert.match(
    html,
    /<script\b(?=[^>]*\bsrc=["']app\.js["'])(?=[^>]*\bdefer\b)[^>]*>\s*<\/script>/i,
    'renderer/index.html must load the checked local app.js script with defer',
  );
});

test('renderer JavaScript passes the Node syntax checker', () => {
  const result = runSyntaxCheck(rendererScript);

  assert.equal(
    result.error,
    undefined,
    `could not start the renderer syntax check: ${diagnostics(result)}`,
  );
  assert.equal(
    result.status,
    0,
    `renderer/app.js contains a syntax error:\n${diagnostics(result)}`,
  );
});

test('the syntax-check gate rejects malformed JavaScript in an isolated fixture', t => {
  const fixtureDirectory = mkdtempSync(
    join(tmpdir(), 'awesome-downloader-renderer-syntax-'),
  );

  t.after(() => {
    rmSync(fixtureDirectory, { recursive: true, force: true });
  });

  const malformedFixture = join(fixtureDirectory, 'invalid-renderer.js');
  writeFileSync(malformedFixture, 'const = ;\n', 'utf8');

  const result = runSyntaxCheck(malformedFixture);

  assert.equal(
    result.error,
    undefined,
    `could not start the syntax checker: ${diagnostics(result)}`,
  );
  assert.notEqual(
    result.status,
    0,
    'the syntax checker must fail for malformed JavaScript',
  );
});
