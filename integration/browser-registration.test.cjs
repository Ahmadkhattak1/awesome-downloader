const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const { registerBrowser, connectInstalledBrowsers, prepareNativeHost } = require('../desktop/browser-registration.cjs');
const id = 'abcdefghijklmnopabcdefghijklmnop';

async function macFixture(t) {
  // Spaces mirror "/Applications/Awesome Downloader.app" and "Application Support".
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'mac registration '));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const home = path.join(root, 'home'), dataDirectory = path.join(root, 'data dir'), integrationRoot = path.join(root, 'Browser Integration');
  await fs.mkdir(path.join(integrationRoot, 'integration'), { recursive: true });
  await fs.mkdir(path.join(integrationRoot, 'extension'), { recursive: true });
  await fs.writeFile(path.join(integrationRoot, 'integration', 'native-host.cjs'), 'process.stdout.write(JSON.stringify({node:process.env.ELECTRON_RUN_AS_NODE,script:process.argv[1]}))');
  return { root, home, dataDirectory, integrationRoot };
}
test('macOS native host launcher runs the app runtime as Node from a path with spaces', { skip: process.platform === 'win32' }, async t => {
  const { integrationRoot } = await macFixture(t);
  await prepareNativeHost(integrationRoot, process.execPath, 'darwin');
  const launcher = path.join(integrationRoot, 'integration', 'native-host');
  assert.equal((await fs.stat(launcher)).mode & 0o111, 0o111);
  const { stdout } = await promisify(execFile)(launcher, ['chrome-extension://' + id + '/']);
  const result = JSON.parse(stdout);
  assert.equal(result.node, '1');
  assert.equal(await fs.realpath(result.script), await fs.realpath(path.join(integrationRoot, 'integration', 'native-host.cjs')));
});
test('macOS registration writes the per-user manifest and backs up a changed one', async t => {
  const { home, dataDirectory, integrationRoot } = await macFixture(t);
  await prepareNativeHost(integrationRoot, process.execPath, 'darwin');
  const manifestPath = path.join(home, 'Library', 'Application Support', 'Google', 'Chrome', 'NativeMessagingHosts', 'com.awesome.downloader.json');
  await fs.mkdir(path.dirname(manifestPath), { recursive: true });
  await fs.writeFile(manifestPath, '{"stale":true}');
  const result = await registerBrowser({ browser: 'Chrome', extensionId: id }, { dataDirectory, integrationRoot, platform: 'darwin', home });
  assert.equal(result.manifestPath, manifestPath);
  const manifest = JSON.parse(await fs.readFile(manifestPath, 'utf8'));
  assert.equal(manifest.path, path.join(integrationRoot, 'integration', 'native-host'));
  assert.deepEqual(manifest.allowed_origins, [`chrome-extension://${id}/`]);
  const backups = await fs.readdir(path.join(dataDirectory, 'NativeMessaging'));
  assert.equal(backups.filter(name => name.endsWith('.bak')).length, 1);
  assert.deepEqual(await fs.readdir(path.dirname(manifestPath)), ['com.awesome.downloader.json']);
});
test('macOS browser scan finds the unpacked extension in Chrome and Edge profiles', async t => {
  const { home, dataDirectory, integrationRoot } = await macFixture(t);
  await prepareNativeHost(integrationRoot, process.execPath, 'darwin');
  const support = path.join(home, 'Library', 'Application Support');
  for (const [browser, profile] of [['Google/Chrome', 'Default'], ['Microsoft Edge', 'Profile 1']]) {
    await fs.mkdir(path.join(support, browser, profile), { recursive: true });
    const settings = { extensions: { settings: { [id]: { path: path.join(integrationRoot, 'extension') } } } };
    await fs.writeFile(path.join(support, browser, profile, 'Preferences'), JSON.stringify(settings));
  }
  const results = await connectInstalledBrowsers({ dataDirectory, integrationRoot, platform: 'darwin', home });
  assert.deepEqual(results, [{ browser: 'Chrome', connected: true }, { browser: 'Edge', connected: true }]);
  const edge = JSON.parse(await fs.readFile(path.join(support, 'Microsoft Edge', 'NativeMessagingHosts', 'com.awesome.downloader.json'), 'utf8'));
  assert.deepEqual(edge.allowed_origins, [`chrome-extension://${id}/`]);
});
