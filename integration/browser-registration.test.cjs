const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { browserInfo, registerBrowser, connectInstalledBrowsers } = require('../desktop/browser-registration.cjs');

const extensionId = 'abcdefghijklmnopabcdefghijklmnop';

test('Brave uses its own Windows registry key, profile and executable', () => {
  assert.equal(browserInfo.Brave.registryRoot, 'BraveSoftware\\Brave-Browser');
  assert.equal(browserInfo.Brave.userData, 'BraveSoftware/Brave-Browser/User Data');
  assert.equal(browserInfo.Brave.executable, 'BraveSoftware/Brave-Browser/Application/brave.exe');
  assert.equal(browserInfo.Brave.extensionsUrl, 'brave://extensions/');
  // Existing browsers keep their exact values.
  assert.equal(browserInfo.Chrome.registryRoot, 'Google\\Chrome');
  assert.equal(browserInfo.Edge.registryRoot, 'Microsoft\\Edge');
});

async function tempFixture() {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), 'awesome-brave-'));
  const dataDirectory = path.join(base, 'data');
  const integrationRoot = path.join(base, 'integration-root');
  await fs.mkdir(path.join(integrationRoot, 'integration'), { recursive: true });
  await fs.mkdir(path.join(integrationRoot, 'extension'), { recursive: true });
  await fs.writeFile(path.join(integrationRoot, 'integration', 'native-host.exe'), '');
  return { base, dataDirectory, integrationRoot };
}

function stubExec(calls) {
  return async (command, args) => {
    calls.push([command, ...args]);
    if (args[0] === 'QUERY') {
      const error = new Error('key not found');
      error.code = 1;
      throw error;
    }
    return { stdout: '' };
  };
}

test('registerBrowser writes a Brave manifest and registry key', async () => {
  const { dataDirectory, integrationRoot } = await tempFixture();
  const calls = [];
  const result = await registerBrowser(
    { browser: 'Brave', extensionId },
    { dataDirectory, integrationRoot, execFn: stubExec(calls) },
  );
  assert.equal(result.manifestPath, path.join(dataDirectory, 'NativeMessaging', 'Brave.json'));
  const manifest = JSON.parse(await fs.readFile(result.manifestPath, 'utf8'));
  assert.equal(manifest.name, 'com.awesome.downloader');
  assert.deepEqual(manifest.allowed_origins, [`chrome-extension://${extensionId}/`]);
  assert.equal(manifest.path, path.join(integrationRoot, 'integration', 'native-host.exe'));
  const add = calls.find((call) => call[1] === 'ADD');
  assert.ok(add, 'expected a registry ADD call');
  assert.ok(add.join(' ').includes('BraveSoftware\\Brave-Browser\\NativeMessagingHosts\\com.awesome.downloader'));
  assert.ok(add.includes(result.manifestPath));
});

test('connectInstalledBrowsers discovers a Brave profile', async () => {
  const { dataDirectory, integrationRoot } = await tempFixture();
  const localAppData = path.join(integrationRoot, '..', 'local-app-data');
  const profile = path.join(localAppData, 'BraveSoftware', 'Brave-Browser', 'User Data', 'Default');
  await fs.mkdir(profile, { recursive: true });
  await fs.writeFile(path.join(profile, 'Preferences'), JSON.stringify({
    extensions: { settings: { [extensionId]: { path: path.join(integrationRoot, 'extension') } } },
  }));
  const calls = [];
  const results = await connectInstalledBrowsers({
    dataDirectory, integrationRoot, localAppData, execFn: stubExec(calls),
  });
  assert.deepEqual(results, [{ browser: 'Brave', connected: true }]);
  const manifest = JSON.parse(await fs.readFile(path.join(dataDirectory, 'NativeMessaging', 'Brave.json'), 'utf8'));
  assert.deepEqual(manifest.allowed_origins, [`chrome-extension://${extensionId}/`]);
});
