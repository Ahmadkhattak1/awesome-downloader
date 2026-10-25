const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');

const {
  registerBrowser,
  connectInstalledBrowsers,
  prepareNativeHost,
} = require('../desktop/browser-registration.cjs');

const { encodeMessage } = require('./native-host.cjs');

const chromeId = 'a'.repeat(32);
const secondId = 'b'.repeat(32);

async function fixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'ad-registration-'));
  const integrationRoot = path.join(root, 'BrowserIntegration');
  await fs.mkdir(path.join(integrationRoot, 'integration'), { recursive: true });
  await fs.mkdir(path.join(integrationRoot, 'extension'), { recursive: true });
  await fs.writeFile(path.join(integrationRoot, 'extension', 'manifest.firefox.json'), '{}');

  await fs.copyFile(
    path.join(__dirname, 'native-host.cjs'),
    path.join(integrationRoot, 'integration', 'native-host.cjs'),
  );

  return {
    root,
    integrationRoot,
    home: path.join(root, 'home'),
    dataDirectory: path.join(root, 'data'),
  };
}

const hostsFolder = (home, browser) =>
  path.join(home, 'Library', 'Application Support', browser, 'NativeMessagingHosts');

test(
  'macOS connector script runs native-host.cjs with the bundled runtime',
  {
    skip: process.platform === 'win32',
  },
  async () => {
    const { root, integrationRoot } = await fixture();
    // Paths with spaces and quotes must survive the generated shell script.
    const runtimeFolder = path.join(root, "it's a runtime");
    await fs.mkdir(runtimeFolder);
    const runtime = path.join(runtimeFolder, 'node');
    await fs.symlink(process.execPath, runtime);
    await prepareNativeHost(integrationRoot, runtime, 'darwin');
    const script = path.join(integrationRoot, 'integration', 'native-host.sh');
    assert.equal((await fs.stat(script)).mode.toString(8).slice(-3), '755');
    const child = spawn(script, [], { stdio: ['pipe', 'pipe', 'inherit'] });
    const output = [];
    child.stdout.on('data', (chunk) => output.push(chunk));
    child.stdin.end(encodeMessage({ action: 'unknown' }));

    await new Promise((resolve) => {
      child.on('close', resolve);
    });

    const reply = Buffer.concat(output);

    assert.deepEqual(JSON.parse(reply.subarray(4, 4 + reply.readUInt32LE(0)).toString('utf8')), {
      ok: false,
      error: 'Unsupported native action.',
    });
  },
);

test('macOS registration writes per-browser manifests and backs up replacements', async () => {
  const { integrationRoot, home, dataDirectory } = await fixture();
  await prepareNativeHost(integrationRoot, process.execPath, 'darwin');
  const options = { dataDirectory, integrationRoot, platform: 'darwin', home };
  const chrome = await registerBrowser({ browser: 'Chrome', extensionId: chromeId }, options);

  assert.equal(
    chrome.manifestPath,
    path.join(hostsFolder(home, 'Google/Chrome'), 'com.awesome.downloader.json'),
  );

  assert.deepEqual(JSON.parse(await fs.readFile(chrome.manifestPath, 'utf8')), {
    name: 'com.awesome.downloader',
    description: 'Awesome Downloader browser bridge',
    path: path.join(integrationRoot, 'integration', 'native-host.sh'),
    type: 'stdio',
    allowed_origins: [`chrome-extension://${chromeId}/`],
  });

  await registerBrowser({ browser: 'Chrome', extensionId: secondId }, options);

  const backups = (await fs.readdir(path.join(dataDirectory, 'NativeMessaging'))).filter((name) =>
    name.startsWith('Chrome.json.'),
  );

  assert.equal(backups.length, 1);

  assert.deepEqual(await fs.readdir(hostsFolder(home, 'Google/Chrome')), [
    'com.awesome.downloader.json',
  ]);

  const edge = await registerBrowser({ browser: 'Edge', extensionId: chromeId }, options);
  assert.equal(path.dirname(edge.manifestPath), hostsFolder(home, 'Microsoft Edge'));

  const firefox = await registerBrowser(
    { browser: 'Firefox', extensionId: 'downloader@example.com' },
    options,
  );

  assert.equal(path.dirname(firefox.manifestPath), hostsFolder(home, 'Mozilla'));

  assert.deepEqual(JSON.parse(await fs.readFile(firefox.manifestPath, 'utf8')).allowed_extensions, [
    'downloader@example.com',
  ]);
});

test('macOS automatic connection finds the extension in every Chrome profile', async () => {
  const { integrationRoot, home, dataDirectory } = await fixture();
  await prepareNativeHost(integrationRoot, process.execPath, 'darwin');
  const chromeRoot = path.join(home, 'Library', 'Application Support', 'Google', 'Chrome');

  for (const [profile, id] of [
    ['Default', chromeId],
    ['Profile 1', secondId],
  ]) {
    await fs.mkdir(path.join(chromeRoot, profile), { recursive: true });

    await fs.writeFile(
      path.join(chromeRoot, profile, 'Preferences'),
      JSON.stringify({
        extensions: { settings: { [id]: { path: path.join(integrationRoot, 'extension') } } },
      }),
    );
  }

  const results = await connectInstalledBrowsers({
    dataDirectory,
    integrationRoot,
    platform: 'darwin',
    home,
  });

  assert.deepEqual(results, [{ browser: 'Chrome', connected: true }]);

  const manifest = JSON.parse(
    await fs.readFile(
      path.join(hostsFolder(home, 'Google/Chrome'), 'com.awesome.downloader.json'),
      'utf8',
    ),
  );

  assert.deepEqual(manifest.allowed_origins.sort(), [
    `chrome-extension://${chromeId}/`,
    `chrome-extension://${secondId}/`,
  ]);
});

test('registration refuses platforms without a native messaging location', async () => {
  const { integrationRoot, home, dataDirectory } = await fixture();

  await assert.rejects(
    registerBrowser(
      { browser: 'Chrome', extensionId: chromeId },
      { dataDirectory, integrationRoot, platform: 'linux', home },
    ),
    /Windows and macOS/,
  );
});
