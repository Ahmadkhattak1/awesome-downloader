const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { createUpdateController } = require('../desktop/updater.cjs');

function harness({ packaged = true, active = 0, responses = [] } = {}) {
  const updater = new EventEmitter();
  updater.checkForUpdates = async () => { updater.checked = (updater.checked || 0) + 1; };
  updater.downloadUpdate = async () => { updater.downloaded = (updater.downloaded || 0) + 1; };
  const boxes = [], notifications = [];
  const dialog = { showMessageBox: async (...args) => { boxes.push(args.at(-1)); return { response: responses.shift() ?? 1 }; } };
  let installed = 0;
  const controller = createUpdateController({ autoUpdater: updater, app: { isPackaged: packaged, getVersion: () => '0.1.1' }, dialog, getWindow: () => ({ isDestroyed: () => false, isVisible: () => true }), activeDownloadCount: () => active, notify: (title, body, click) => notifications.push({ title, body, click }), installUpdate: async () => { installed += 1; } });
  return { updater, boxes, notifications, controller, installed: () => installed };
}
const settle = () => new Promise(resolve => setImmediate(resolve));

test('manual check reports when the installed version is current', async () => {
  const h = harness();
  await h.controller.check({ manual: true });
  h.updater.emit('update-not-available', { version: '0.1.1' });
  await settle();
  assert.equal(h.updater.checked, 1);
  assert.equal(h.boxes.at(-1).title, 'No updates available');
});
test('automatic current-version checks stay silent', async () => {
  const h = harness();
  await h.controller.check();
  h.updater.emit('update-not-available', { version: '0.1.1' });
  await settle();
  assert.equal(h.updater.checked, 1);
  assert.equal(h.boxes.length, 0);
});
test('automatic missing-release checks stay silent', async () => {
  const h = harness();
  await h.controller.check();
  h.updater.emit('error', new Error('Unable to find latest version on GitHub (https://github.com/Ahmadkhattak1/awesome-downloader/releases/latest): HTTPError: 406'));
  await settle();
  assert.equal(h.boxes.length, 0);
});
test('the updater schedules silent background checks every six hours', () => {
  const originalInterval = global.setInterval;
  const scheduled = [];
  global.setInterval = (callback, delay) => {
    scheduled.push({ callback, delay });
    return { unref() {} };
  };
  try {
    const h = harness();
    h.controller.start();
    assert.equal(h.updater.checked, undefined);
    assert.equal(scheduled.length, 1);
    assert.equal(scheduled[0].delay, 6 * 60 * 60 * 1000);
  } finally { global.setInterval = originalInterval; }
});
test('a background update uses a notification instead of a dialog', async () => {
  const h = harness();
  await h.controller.check();
  h.updater.emit('update-available', { version: '0.1.2' });
  await settle();
  assert.equal(h.boxes.length, 0);
  assert.equal(h.notifications.length, 1);
});
test('missing GitHub production release is treated as up to date without raw response data', async () => {
  const h = harness();
  await h.controller.check({ manual: true });
  h.updater.emit('error', new Error('Unable to find latest version on GitHub (https://github.com/Ahmadkhattak1/awesome-downloader/releases/latest), please ensure a production release exists: HTTPError: 406\nHeaders: secret-noisy-response'));
  await settle();
  assert.equal(h.boxes.at(-1).title, 'No updates available');
  assert.doesNotMatch(h.boxes.at(-1).detail, /Headers|secret/i);
});
test('real update errors show a short safe explanation', async () => {
  const h = harness();
  await h.controller.check({ manual: true });
  h.updater.emit('error', new Error('ETIMEDOUT with a very long internal response'));
  await settle();
  assert.equal(h.boxes.at(-1).title, 'Could not check for updates');
  assert.match(h.boxes.at(-1).detail, /internet connection/i);
  assert.doesNotMatch(h.boxes.at(-1).detail, /internal response/i);
});
test('available update downloads only after explicit approval', async () => {
  const h = harness({ responses: [0] });
  await h.controller.check({ manual: true });
  h.updater.emit('update-available', { version: '0.1.2' });
  await settle();
  assert.equal(h.boxes.at(-1).title, 'Update available');
  assert.equal(h.updater.downloaded, 1);
});
test('ready update defaults to Later while downloads are active', async () => {
  const h = harness({ active: 2, responses: [1] });
  h.updater.emit('update-downloaded', { version: '0.1.2' });
  await settle();
  assert.equal(h.boxes.at(-1).defaultId, 1);
  assert.match(h.boxes.at(-1).detail, /2 downloads are active/);
  assert.equal(h.installed(), 0);
});
test('development build never contacts GitHub', async () => {
  const h = harness({ packaged: false });
  await h.controller.check({ manual: true });
  assert.equal(h.updater.checked, undefined);
  assert.equal(h.boxes.at(-1).title, 'Updates are unavailable in development');
});
