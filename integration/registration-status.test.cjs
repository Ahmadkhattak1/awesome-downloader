const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { registrationStatus, hostPath } = require('../desktop/browser-registration.cjs');

async function setup(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'reg-test-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const dataDirectory = path.join(root, 'data'), integrationRoot = path.join(root, 'bi');
  await fs.mkdir(path.join(integrationRoot, 'integration'), { recursive: true }); await fs.mkdir(path.join(dataDirectory, 'NativeMessaging'), { recursive: true });
  return { dataDirectory, integrationRoot, root };
}
const ID = 'a'.repeat(32);
async function manifest({ dataDirectory, integrationRoot }, overrides = {}) {
  const file = path.join(dataDirectory, 'NativeMessaging', 'Chrome.json'), host = await hostPath(integrationRoot);
  await fs.writeFile(file, JSON.stringify({ name: 'com.awesome.downloader', path: host, type: 'stdio', allowed_origins: [`chrome-extension://${ID}/`], ...overrides }));
  return file;
}

test('connector launcher falls back to the .cmd file when the .exe could not be built', async t => {
  const o = await setup(t);
  assert.equal(await hostPath(o.integrationRoot), null);
  await fs.writeFile(path.join(o.integrationRoot, 'integration', 'native-host.cmd'), '@echo off');
  assert.equal(path.basename(await hostPath(o.integrationRoot)), 'native-host.cmd');
  await fs.writeFile(path.join(o.integrationRoot, 'integration', 'native-host.exe'), 'x');
  assert.equal(path.basename(await hostPath(o.integrationRoot)), 'native-host.exe');
});

test('status pinpoints why Chrome reports "native messaging host not found"', async t => {
  const o = await setup(t);
  await fs.writeFile(path.join(o.integrationRoot, 'integration', 'native-host.exe'), 'x');
  await fs.writeFile(path.join(o.dataDirectory, 'known-extensions.json'), JSON.stringify({ Chrome: [ID] }));
  const chrome = async query => (await registrationStatus(o, { query })).find(s => s.browser === 'Chrome');
  assert.equal((await chrome(async () => null)).problem, 'browser registry entry is missing');
  const file = await manifest(o);
  const ok = await chrome(async key => (key.includes('Chrome') ? file : null));
  assert.equal(ok.healthy, true); assert.equal(ok.problem, '');
  assert.equal((await chrome(async () => path.join(o.root, 'gone.json'))).problem, 'connector manifest is missing');
  await manifest(o, { path: path.join(o.root, 'old-install', 'native-host.exe') });
  assert.equal((await chrome(async () => file)).problem, 'connector program moved or missing');
  await manifest(o, { allowed_origins: ['chrome-extension://' + 'b'.repeat(32) + '/'] });
  assert.equal((await chrome(async () => file)).problem, 'extension ID changed');
  const none = (await registrationStatus({ ...o, dataDirectory: path.join(o.root, 'empty') }, { query: async () => null })).find(s => s.browser === 'Edge');
  assert.equal(none.problem, 'not connected');
});
