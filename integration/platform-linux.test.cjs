const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { writeNativeHostLauncher } = require('../desktop/native-host-launcher.cjs');
const { nativeHostManifestPath, registerBrowser, prepareNativeHost } = require('../desktop/browser-registration.cjs');
const { findExecutable } = require('../desktop/browser-setup.cjs');

const linux = { skip: process.platform === 'win32' };

test('Linux native host launcher runs Electron as Node with a quoted path', linux, async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'awesome-launcher-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const executable = path.join(root, "Electron App's Folder", 'electron');
  const launcher = await writeNativeHostLauncher(root, executable);
  assert.equal(launcher, path.join(root, 'native-host.sh'));
  const content = await fs.readFile(launcher, 'utf8');
  assert.match(content, /^#!\/bin\/sh\n/);
  assert.match(content, /export ELECTRON_RUN_AS_NODE=1/);
  assert.ok(content.includes(`'\\''`), 'single quotes in the executable path are escaped');
  assert.ok(content.includes('native-host.cjs'), 'the launcher targets the bundled connector');
  const mode = (await fs.stat(launcher)).mode & 0o777;
  assert.equal(mode, 0o755);
});

test('Windows native host launcher escapes percent signs for batch files', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'awesome-launcher-win-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const launcher = await writeNativeHostLauncher(root, 'C:\\Program Files\\100%\\Awesome Downloader.exe', 'win32');
  assert.equal(launcher, path.join(root, 'native-host.cmd'));
  const content = await fs.readFile(launcher, 'utf8');
  assert.ok(content.includes('100%%'), 'percent signs are doubled');
  assert.ok(content.includes('ELECTRON_RUN_AS_NODE=1'));
});

test('Linux native messaging manifests live in the browser config directories', () => {
  const configHome = '/home/example/.config';
  const home = '/home/example';
  assert.equal(nativeHostManifestPath('Chrome', { configHome, home }),
    '/home/example/.config/google-chrome/NativeMessagingHosts/com.awesome.downloader.json');
  assert.equal(nativeHostManifestPath('Chromium', { configHome, home }),
    '/home/example/.config/chromium/NativeMessagingHosts/com.awesome.downloader.json');
  assert.equal(nativeHostManifestPath('Edge', { configHome, home }),
    '/home/example/.config/microsoft-edge/NativeMessagingHosts/com.awesome.downloader.json');
  assert.equal(nativeHostManifestPath('Firefox', { configHome, home }),
    '/home/example/.mozilla/native-messaging-hosts/com.awesome.downloader.json');
  assert.equal(nativeHostManifestPath('Unknown', { configHome, home }), null);
});

test('Linux registration writes a valid native messaging manifest', linux, async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'awesome-register-'));
  const previousConfig = process.env.XDG_CONFIG_HOME;
  process.env.XDG_CONFIG_HOME = path.join(root, 'config');
  t.after(async () => {
    if (previousConfig === undefined) delete process.env.XDG_CONFIG_HOME;
    else process.env.XDG_CONFIG_HOME = previousConfig;
    await fs.rm(root, { recursive: true, force: true });
  });
  const integrationRoot = path.join(root, 'browser');
  await fs.mkdir(path.join(integrationRoot, 'integration'), { recursive: true });
  await fs.writeFile(path.join(integrationRoot, 'integration', 'native-host.cjs'), '');
  await writeNativeHostLauncher(path.join(integrationRoot, 'integration'), '/opt/Awesome Downloader/awesome-downloader');
  const extensionId = 'a'.repeat(32);
  const result = await registerBrowser({ browser: 'Chrome', extensionId }, { dataDirectory: path.join(root, 'data'), integrationRoot });
  assert.equal(result.manifestPath, path.join(root, 'config', 'google-chrome', 'NativeMessagingHosts', 'com.awesome.downloader.json'));
  const manifest = JSON.parse(await fs.readFile(result.manifestPath, 'utf8'));
  assert.equal(manifest.name, 'com.awesome.downloader');
  assert.equal(manifest.type, 'stdio');
  assert.equal(manifest.path, path.join(integrationRoot, 'integration', 'native-host.sh'));
  assert.deepEqual(manifest.allowed_origins, [`chrome-extension://${extensionId}/`]);
  const mode = (await fs.stat(manifest.path)).mode & 0o777;
  assert.equal(mode, 0o755, 'browsers can execute the host launcher');
});

test('Linux prepares the native host without a C# compiler', linux, async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'awesome-prepare-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const integrationRoot = path.join(root, 'browser');
  const folder = path.join(integrationRoot, 'integration');
  await fs.mkdir(folder, { recursive: true });
  await fs.writeFile(path.join(folder, 'native-host.cjs'), '');
  await prepareNativeHost(integrationRoot, '/usr/bin/electron');
  const launcher = path.join(folder, 'native-host.sh');
  assert.equal((await fs.stat(launcher)).mode & 0o777, 0o755);
  assert.equal(await fs.readFile(path.join(folder, 'runtime-path.txt'), 'utf8'), '/usr/bin/electron');
  assert.match(await fs.readFile(launcher, 'utf8'), /exec '\/usr\/bin\/electron'/);
});

test('Linux browser lookup finds executables on PATH', linux, async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'awesome-path-'));
  const previousPath = process.env.PATH;
  t.after(async () => {
    process.env.PATH = previousPath;
    await fs.rm(root, { recursive: true, force: true });
  });
  const executable = path.join(root, 'google-chrome');
  await fs.writeFile(executable, '#!/bin/sh\n', { mode: 0o755 });
  process.env.PATH = `${root}${path.delimiter}${previousPath}`;
  assert.equal(await findExecutable(['google-chrome']), executable);
  assert.equal(await findExecutable(['missing-browser-command']), null);
});
