const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
const path = require('node:path');

function harness({ accept = true, stored = {} } = {}) {
  const events = {}, native = [], calls = [], data = { ...stored };
  const event = name => ({ addListener(fn) { events[name] = fn; } });
  const storage = { async get(keys) { const out = {}; for (const k of [].concat(typeof keys === 'string' ? [keys] : keys)) if (k in data) out[k] = data[k]; return out; }, async set(v) { Object.assign(data, v); } };
  const browser = { runtime: { id: 'x', onMessage: event('message'), onInstalled: event('installed'), async sendNativeMessage(host, payload) { native.push(payload); if (!accept) throw new Error('Desktop app is not running'); return { ok: true }; } },
    storage: { session: storage, local: storage }, webRequest: { onHeadersReceived: event('response'), onBeforeRequest: event('b'), onBeforeSendHeaders: event('h') }, tabs: { onRemoved: event('r'), onUpdated: event('u') },
    contextMenus: { onClicked: event('context'), async removeAll() {}, create(item) { calls.push(['menu', item.id]); } },
    downloads: { onCreated: event('download'), async pause(id) { calls.push(['pause', id]); }, async cancel(id) { calls.push(['cancel', id]); }, async resume(id) { calls.push(['resume', id]); } }, action: { async setBadgeText() {} } };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, 'background.js'), 'utf8'), { browser, URL, URLSearchParams, Uint8Array, btoa: v => Buffer.from(v, 'binary').toString('base64'), youtubeMedia: require('./youtube-media.js') });
  return { events, native, calls, data };
}
const dl = (url, extra = {}) => ({ id: 5, url, finalUrl: url, filename: 'C:\\Users\\me\\Downloads\\' + new URL(url).pathname.split('/').pop(), tabId: 1, ...extra });

test('every http(s) file type is taken over by default and the browser copy is canceled after acceptance', async () => {
  const h = harness();
  for (const name of ['a.zip', 'b.exe', 'c.pdf', 'd.mkv', 'e.iso', 'f.unknownext']) { h.calls.length = 0; await h.events.download(dl('https://files.example.com/' + name)); assert.equal(h.calls.map(c => c[0]).join(), 'pause,cancel', name); }
  assert.equal(h.native.length, 6); assert.equal(h.native[0].filename, 'a.zip');
});

test('browser keeps the download when the desktop app refuses or is not running', async () => {
  const h = harness({ accept: false });
  await h.events.download(dl('https://files.example.com/a.zip'));
  assert.equal(h.calls.map(c => c[0]).join(), 'pause,resume'); assert.match(h.data.lastError, /kept/);
});

test('blob/data/file downloads, other extensions and excluded sites or types are left alone', async () => {
  const h = harness({ stored: { interceptExclude: 'bank.example, .pdf  *.corp.test' } });
  for (const item of [dl('blob:https://a.example/123', { filename: 'x.bin' }), dl('https://files.example.com/a.zip', { byExtensionId: 'other' }), dl('https://www.bank.example/statement.zip'), dl('https://files.example.com/doc.PDF'), dl('https://x.corp.test/a.zip')]) {
    h.calls.length = 0; await h.events.download(item); assert.equal(h.calls.length, 0, item.url);
  }
  await h.events.download(dl('https://files.example.com/ok.zip')); assert.equal(h.calls.length, 2);
});

test('interception can be switched off and is on after a fresh install', async () => {
  const off = harness({ stored: { interceptDownloads: false } });
  await off.events.download(dl('https://files.example.com/a.zip')); assert.equal(off.calls.length, 0);
  const fresh = harness(); await fresh.events.installed(); assert.equal(fresh.data.interceptDownloads, true);
  assert.ok(fresh.calls.some(c => c[1] === 'awesome-page-video'));
});

test('page-video extraction request reaches the desktop app; DASH/mkv/flv are recognised as media', async () => {
  const h = harness(), sender = { id: 'x', tab: { id: 3, url: 'https://site.example/watch/9' } };
  await new Promise(resolve => h.events.message({ action: 'download', item: { url: 'https://site.example/watch/9', extract: true } }, sender, resolve));
  assert.equal(h.native[0].extract, true); assert.equal(h.native[0].url, 'https://site.example/watch/9');
  for (const u of ['https://c.example/a.mpd', 'https://c.example/a.mkv', 'https://c.example/a.flv']) h.events.response({ url: u, tabId: 3, statusCode: 200, type: 'xmlhttprequest', responseHeaders: [] });
  await new Promise(r => setTimeout(r, 30));
  const list = await new Promise(resolve => h.events.message({ action: 'listForFrame' }, sender, resolve));
  assert.deepEqual([...list.items.map(i => i.url)].sort(), ['https://c.example/a.flv', 'https://c.example/a.mkv', 'https://c.example/a.mpd']);
});
