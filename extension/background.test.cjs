const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
const path = require('node:path');

const youtubeMedia = require('./youtube-media.js');

function harness() {
  const events = {};
  const nativeRequests = [];
  const data = {};

  const event = (name) => ({
    addListener(fn) {
      events[name] = fn;
    },
  });

  const storage = {
    async get(key) {
      return structuredClone({ [key]: data[key] });
    },
    async set(value) {
      Object.assign(data, structuredClone(value));
    },
  };

  const browser = {
    runtime: {
      id: 'extension-id',
      onMessage: event('message'),
      onInstalled: event('installed'),
      async sendNativeMessage(host, payload) {
        nativeRequests.push(structuredClone(payload));
        return { ok: true };
      },
    },
    storage: { session: storage, local: storage },
    webRequest: {
      onHeadersReceived: event('response'),
      onBeforeRequest: event('beforeRequest'),
      onBeforeSendHeaders: event('requestHeaders'),
    },
    tabs: { onRemoved: event('removed'), onUpdated: event('updated') },
    contextMenus: { onClicked: event('context'), removeAll: () => Promise.resolve(), create() {} },
    downloads: { onCreated: event('download') },
    action: {},
  };

  browser.tabs.sendMessage = async () => ({ ok: true });

  vm.runInNewContext(fs.readFileSync(path.join(__dirname, 'background.js'), 'utf8'), {
    browser,
    URL,
    URLSearchParams,
    Uint8Array,
    btoa: (value) => Buffer.from(value, 'binary').toString('base64'),
    youtubeMedia,
  });

  return {
    events,
    data,
    nativeRequests,
    request(message, sender) {
      return new Promise((resolve) => {
        const accepted = events.message(message, sender, resolve);

        if (accepted !== true) {
          resolve(undefined);
        }
      });
    },
  };
}

test('video selection forwards explicit one-click download intent', async () => {
  const worker = harness();
  const sender = { id: 'extension-id', tab: { id: 3 } };

  await worker.request(
    { action: 'download', item: { url: 'https://example.com/video.mp4', startNow: true } },
    sender,
  );

  assert.equal(worker.nativeRequests[0].startNow, true);

  await worker.request(
    { action: 'download', item: { url: 'https://example.com/video.mp4' } },
    sender,
  );

  assert.equal(worker.nativeRequests[1].startNow, false);
});

test('YouTube menu uses captured player formats without a desktop discovery request', async () => {
  const worker = harness();

  const sender = {
    id: 'extension-id',
    tab: { id: 7, url: 'https://www.youtube.com/watch?v=wLdZWyLOJCI' },
  };

  const base = 'https://r1.googlevideo.com/videoplayback?id=asset&expire=9999999999&itag=';

  await worker.request(
    {
      action: 'playerResponse',
      data: {
        videoId: 'wLdZWyLOJCI',
        title: 'Captured',
        formats: [
          { itag: 137, url: base + 137, mimeType: 'video/mp4', height: 1080 },
          { itag: 140, url: base + 140, mimeType: 'audio/mp4' },
        ],
      },
    },
    sender,
  );

  const result = await worker.request({ action: 'listForFrame' }, sender);
  assert.equal(result.items[0].audioUrl, base + 140);
  assert.equal(worker.nativeRequests.length, 0);

  await worker.request(
    { action: 'download', item: { ...result.items[0], startNow: true } },
    sender,
  );

  assert.equal(worker.nativeRequests[0].url, base + 137);
  assert.equal(worker.nativeRequests[0].audioUrl, base + 140);

  const other = await worker.request(
    { action: 'listForFrame' },
    { ...sender, tab: { ...sender.tab, url: 'https://www.youtube.com/watch?v=abcdefghijk' } },
  );

  assert.equal(other.items.length, 0);
});

const sabrStream = (videoId = 'wLdZWyLOJCI') =>
  `https://r1.googlevideo.com/videoplayback?id=${videoId}-asset&sabr=1&expire=9999999999`;

const sabrSender = (videoId = 'wLdZWyLOJCI') => ({
  id: 'extension-id',
  tab: { id: 8, url: `https://www.youtube.com/watch?v=${videoId}` },
});

const sabrPlayer = (videoId = 'wLdZWyLOJCI') => ({
  action: 'playerResponse',
  data: {
    videoId,
    title: 'Captured',
    sabr: true,
    sabrUrl: sabrStream(videoId),
    ustreamerConfig: 'AQID',
    clientName: 1,
    clientVersion: '2.20261022.00.00',
    formats: [
      {
        itag: 137,
        mimeType: 'video/mp4; codecs="avc1"',
        height: 1080,
        qualityLabel: '1080p',
        bitrate: 3000000,
        lastModified: '1',
        approxDurationMs: '10000',
      },
      {
        itag: 140,
        mimeType: 'audio/mp4; codecs="mp4a.40.2"',
        audioQuality: 'AUDIO_QUALITY_MEDIUM',
        bitrate: 128000,
        lastModified: '1',
        approxDurationMs: '10000',
      },
    ],
  },
});

// What the page's SABR POST looks like to webRequest while a video plays.
function observeSabrRequest(
  worker,
  { requestId = 'success', videoId = 'wLdZWyLOJCI', body = [1, 2, 3] } = {},
) {
  worker.events.beforeRequest({
    requestId,
    tabId: 8,
    url: sabrStream(videoId),
    requestBody: { raw: [{ bytes: Uint8Array.from(body).buffer }] },
  });

  worker.events.response({
    requestId,
    tabId: 8,
    url: sabrStream(videoId),
    statusCode: 200,
    type: 'xmlhttprequest',
    responseHeaders: [{ name: 'Content-Type', value: 'application/vnd.yt-ump' }],
  });
}

test('captured SABR request context is handed to the desktop with the selected tracks', async () => {
  const worker = harness();
  const sender = sabrSender();
  const stream = sabrStream();
  await worker.request(sabrPlayer(), sender);
  observeSabrRequest(worker);

  // A later in-flight or rejected request must not replace the successful body.
  worker.events.beforeRequest({
    requestId: 'pending',
    tabId: 8,
    url: `${stream}&seq=2`,
    requestBody: { raw: [{ bytes: Uint8Array.from([4, 5, 6]).buffer }] },
  });

  const item = (await worker.request({ action: 'listForFrame' }, sender)).items.find(
    (value) => value.quality === '1080p',
  );

  assert.ok(item);
  await worker.request({ action: 'download', item: { ...item, startNow: true } }, sender);
  assert.equal(worker.nativeRequests[0].sabr.videoItag, 137);
  assert.equal(worker.nativeRequests[0].sabr.audioItag, 140);
  assert.equal(worker.nativeRequests[0].sabr.requestBody, 'AQID');
  assert.equal(worker.nativeRequests[0].sabr.serverAbrStreamingUrl, stream);

  worker.events.response({
    requestId: 'pending',
    tabId: 8,
    url: `${stream}&seq=2`,
    statusCode: 403,
  });

  await worker.request({ action: 'download', item: { ...item, startNow: true } }, sender);
  assert.equal(worker.nativeRequests[1].sabr.requestBody, 'AQID');
  worker.events.updated(8, { status: 'loading' });

  const rejected = await worker.request(
    { action: 'download', item: { ...item, startNow: true } },
    sender,
  );

  assert.equal(rejected.ok, false);
  assert.equal(worker.nativeRequests.length, 2);
});

test('observing a video-only leaf never erases its master audio pairing', async () => {
  const worker = harness();
  const sender = { id: 'extension-id', tab: { id: 3 } };
  const url = 'https://example.com/video.m3u8';

  await worker.request(
    {
      action: 'remember',
      items: [
        {
          url,
          format: 'HLS',
          quality: '720p',
          audioUrl: 'https://example.com/audio.m3u8',
          masterUrl: 'https://example.com/master.m3u8',
          codecs: 'avc1,mp4a',
        },
      ],
    },
    sender,
  );

  await worker.request({ action: 'remember', items: [{ url, format: 'HLS' }] }, sender);
  const item = (await worker.request({ action: 'listForFrame' }, sender)).items[0];
  assert.equal(item.audioUrl, 'https://example.com/audio.m3u8');
  assert.equal(item.masterUrl, 'https://example.com/master.m3u8');
});

test('frame list is restricted to its sender tab and excludes non-media links', async () => {
  const worker = harness();

  await worker.request(
    {
      action: 'remember',
      items: [
        { url: 'https://example.com/a.mp4' },
        { url: 'https://example.com/page' },
        { url: 'https://example.com/a.mpd' },
      ],
    },
    { id: 'extension-id', tab: { id: 3 } },
  );

  await worker.request(
    { action: 'remember', items: [{ url: 'https://private.example/other.mp4' }] },
    { id: 'extension-id', tab: { id: 4 } },
  );

  const result = await worker.request(
    { action: 'listForFrame', tabId: 4 },
    { id: 'extension-id', tab: { id: 3 } },
  );

  assert.equal(result.items.length, 2);
  assert.equal(result.items[0].url, 'https://example.com/a.mp4');
  assert.equal(result.items[1].unsupported, true);

  assert.equal(
    await worker.request({ action: 'listForFrame' }, { id: 'foreign', tab: { id: 3 } }),
    undefined,
  );

  assert.equal(
    (await worker.request({ action: 'listForFrame' }, { id: 'extension-id' })).ok,
    false,
  );
});

test('request credentials stay out of storage and cannot cross tab or URL boundaries', async () => {
  const worker = harness();
  const url = 'https://example.com/video.mp4';

  worker.events.requestHeaders({
    tabId: 3,
    url,
    requestHeaders: [{ name: 'Cookie', value: 'session=test-only' }],
  });

  await worker.request(
    { action: 'download', item: { url } },
    { id: 'extension-id', tab: { id: 3 } },
  );

  assert.equal(worker.nativeRequests[0].requestHeaders.cookie, 'session=test-only');

  await worker.request(
    { action: 'download', item: { url } },
    { id: 'extension-id', tab: { id: 4 } },
  );

  assert.equal(worker.nativeRequests[1].requestHeaders, undefined);
  assert.equal(JSON.stringify(worker.data).includes('session=test-only'), false);
  worker.events.updated(3, { status: 'loading' });

  await worker.request(
    { action: 'download', item: { url } },
    { id: 'extension-id', tab: { id: 3 } },
  );

  assert.equal(worker.nativeRequests[2].requestHeaders, undefined);
});

test('individual HLS media fragments are not listed as complete videos', async () => {
  const worker = harness();
  const sender = { id: 'extension-id', tab: { id: 3 } };

  await worker.request(
    {
      action: 'remember',
      items: ['a.m4s', 'a.ts', 'init.mp4', 'movie.mp4'].map((name) => ({
        url: `https://example.com/${name}`,
      })),
    },
    sender,
  );

  const result = await worker.request({ action: 'listForFrame' }, sender);
  assert.equal(result.items.length, 1);
  assert.equal(result.items[0].url, 'https://example.com/movie.mp4');
});

test('media cache is bounded, deduplicated, and cleared on navigation', async () => {
  const worker = harness();
  const sender = { id: 'extension-id', tab: { id: 9 } };

  const items = Array.from({ length: 120 }, (_, index) => ({
    url: `https://example.com/${index}.mp4`,
  }));

  await worker.request({ action: 'remember', items: items.slice(0, 80) }, sender);
  await worker.request({ action: 'remember', items: items.slice(60) }, sender);
  let result = await worker.request({ action: 'listForFrame' }, sender);
  assert.equal(result.items.length, 100);
  assert.equal(new Set(result.items.map((item) => item.url)).size, 100);
  worker.events.updated(9, { status: 'loading' });
  result = await worker.request({ action: 'listForFrame' }, sender);
  assert.equal(result.items.length, 0);
});
