const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
const path = require('node:path');

const youtubeMedia = require('./youtube-media.js');

// Pass a previous harness's `data` to simulate Chrome restarting the service worker:
// memory is lost, storage.session survives. `onTabMessage` sees messages sent to the page.
function harness(data = {}, { onTabMessage } = {}) {
  const events = {};
  const nativeRequests = [];
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
  browser.tabs.sendMessage = async (tabId, message) => {
    onTabMessage?.(message);
    return { ok: true };
  };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, 'background.js'), 'utf8'), {
    browser,
    // Retry waits run immediately so tests do not sleep.
    setTimeout: (fn) => setImmediate(fn),
    clearTimeout() {},
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
  const h = harness();
  const sender = { id: 'extension-id', tab: { id: 3 } };
  await h.request(
    { action: 'download', item: { url: 'https://example.com/video.mp4', startNow: true } },
    sender,
  );
  assert.equal(h.nativeRequests[0].startNow, true);
  await h.request({ action: 'download', item: { url: 'https://example.com/video.mp4' } }, sender);
  assert.equal(h.nativeRequests[1].startNow, false);
});
test('YouTube menu uses captured player formats without a desktop discovery request', async () => {
  const h = harness();
  const sender = {
    id: 'extension-id',
    tab: { id: 7, url: 'https://www.youtube.com/watch?v=wLdZWyLOJCI' },
  };
  const base = 'https://r1.googlevideo.com/videoplayback?id=asset&expire=9999999999&itag=';
  await h.request(
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
  const result = await h.request({ action: 'listForFrame' }, sender);
  assert.equal(result.items[0].audioUrl, base + 140);
  assert.equal(h.nativeRequests.length, 0);
  await h.request({ action: 'download', item: { ...result.items[0], startNow: true } }, sender);
  assert.equal(h.nativeRequests[0].url, base + 137);
  assert.equal(h.nativeRequests[0].audioUrl, base + 140);
  const other = await h.request(
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
  h,
  { requestId = 'success', videoId = 'wLdZWyLOJCI', body = [1, 2, 3] } = {},
) {
  h.events.beforeRequest({
    requestId,
    tabId: 8,
    url: sabrStream(videoId),
    requestBody: { raw: [{ bytes: Uint8Array.from(body).buffer }] },
  });
  h.events.response({
    requestId,
    tabId: 8,
    url: sabrStream(videoId),
    statusCode: 200,
    type: 'xmlhttprequest',
    responseHeaders: [{ name: 'Content-Type', value: 'application/vnd.yt-ump' }],
  });
}
const settle = () =>
  new Promise((resolve) => {
    setTimeout(resolve, 0);
  });
const sabrItem = async (h, sender) =>
  (await h.request({ action: 'listForFrame' }, sender)).items.find(
    (value) => value.quality === '1080p',
  );
test('captured SABR request context is handed to the desktop with the selected tracks', async () => {
  const h = harness();
  const sender = sabrSender();
  const stream = sabrStream();
  await h.request(sabrPlayer(), sender);
  observeSabrRequest(h);
  // A later in-flight or rejected request must not replace the successful body.
  h.events.beforeRequest({
    requestId: 'pending',
    tabId: 8,
    url: `${stream}&seq=2`,
    requestBody: { raw: [{ bytes: Uint8Array.from([4, 5, 6]).buffer }] },
  });
  const item = (await h.request({ action: 'listForFrame' }, sender)).items.find(
    (value) => value.quality === '1080p',
  );
  assert.ok(item);
  await h.request({ action: 'download', item: { ...item, startNow: true } }, sender);
  assert.equal(h.nativeRequests[0].sabr.videoItag, 137);
  assert.equal(h.nativeRequests[0].sabr.audioItag, 140);
  assert.equal(h.nativeRequests[0].sabr.requestBody, 'AQID');
  assert.equal(h.nativeRequests[0].sabr.serverAbrStreamingUrl, stream);
  h.events.response({ requestId: 'pending', tabId: 8, url: `${stream}&seq=2`, statusCode: 403 });
  await h.request({ action: 'download', item: { ...item, startNow: true } }, sender);
  assert.equal(h.nativeRequests[1].sabr.requestBody, 'AQID');
  h.events.updated(8, { status: 'loading' });
  const rejected = await h.request(
    { action: 'download', item: { ...item, startNow: true } },
    sender,
  );
  assert.equal(rejected.ok, false);
  assert.equal(h.nativeRequests.length, 2);
});
test('a SABR capture survives Chrome stopping the idle service worker', async () => {
  const playing = harness();
  const sender = sabrSender();
  await playing.request(sabrPlayer(), sender);
  observeSabrRequest(playing);
  await settle();
  // Paused video, ~30 s idle: Chrome stops the worker. Opening the menu wakes a new one,
  // and the page's player data is sent again, but no new SABR request is made.
  const restarted = harness(playing.data);
  await restarted.request(sabrPlayer(), sender);
  const item = await sabrItem(restarted, sender);
  const result = await restarted.request(
    { action: 'download', item: { ...item, startNow: true } },
    sender,
  );
  assert.equal(result.ok, true);
  assert.equal(restarted.nativeRequests[0].sabr.requestBody, 'AQID');
  assert.equal(restarted.nativeRequests[0].sabr.serverAbrStreamingUrl, sabrStream());
});
test('a missing capture is recovered automatically by priming the page player', async () => {
  const sent = [];
  const h = harness(
    {},
    {
      onTabMessage(message) {
        sent.push(message.action);
        // The page's player answers the nudge with a fresh streaming request.
        if (message.action === 'primeStream') {
          observeSabrRequest(h);
        }
      },
    },
  );
  const sender = sabrSender();
  await h.request(sabrPlayer(), sender);
  const item = await sabrItem(h, sender);
  const result = await h.request({ action: 'download', item: { ...item, startNow: true } }, sender);
  assert.equal(result.ok, true);
  assert.ok(sent.includes('primeStream'));
  assert.equal(h.nativeRequests[0].sabr.requestBody, 'AQID');
});
test('a streaming request copied by the page is used when Chrome hides its body', async () => {
  const sent = [];
  const h = harness({}, { onTabMessage: (message) => sent.push(message.action) });
  const sender = sabrSender();
  await h.request(sabrPlayer(), sender);
  // What Chrome reports today: the request is visible, its body is not.
  h.events.beforeRequest({ requestId: 'hidden', tabId: 8, url: sabrStream() });
  const copied = await h.request(
    { action: 'sabrRequest', data: { url: sabrStream(), body: 'AQID' } },
    sender,
  );
  assert.equal(copied.ok, true);
  const item = await sabrItem(h, sender);
  const result = await h.request({ action: 'download', item: { ...item, startNow: true } }, sender);
  assert.equal(result.ok, true);
  assert.equal(h.nativeRequests[0].sabr.requestBody, 'AQID');
  assert.equal(h.nativeRequests[0].sabr.serverAbrStreamingUrl, sabrStream());
  assert.ok(!sent.includes('primeStream'));
});
test('page-copied streaming requests are accepted only from YouTube for SABR URLs', async () => {
  const h = harness();
  for (const [sender, data] of [
    [
      { id: 'extension-id', tab: { id: 8, url: 'https://example.com/watch?v=wLdZWyLOJCI' } },
      { url: sabrStream(), body: 'AQID' },
    ],
    [sabrSender(), { url: 'https://example.com/videoplayback?sabr=1', body: 'AQID' }],
    [sabrSender(), { url: sabrStream(), body: 'not base64!' }],
  ]) {
    assert.equal((await h.request({ action: 'sabrRequest', data }, sender)).ok, false);
  }
  assert.doesNotMatch(JSON.stringify(h.data), /AQID/);
});
test('an ad played in between keeps the main video capture', async () => {
  const sent = [];
  const h = harness({}, { onTabMessage: (message) => sent.push(message.action) });
  const sender = sabrSender();
  await h.request(sabrPlayer(), sender);
  observeSabrRequest(h, { requestId: 'main', body: [1, 2, 3] });
  // A mid-roll ad brings its own player data and streaming requests into the same tab.
  await h.request(sabrPlayer('adVideo0001'), sender);
  observeSabrRequest(h, { requestId: 'ad', videoId: 'adVideo0001', body: [9, 9, 9] });
  await h.request(sabrPlayer(), sender);
  const item = await sabrItem(h, sender);
  const result = await h.request({ action: 'download', item: { ...item, startNow: true } }, sender);
  assert.equal(result.ok, true);
  assert.equal(h.nativeRequests[0].sabr.requestBody, 'AQID');
  assert.equal(h.nativeRequests[0].sabr.serverAbrStreamingUrl, sabrStream());
  assert.ok(!sent.includes('primeStream'));
});
test('when recovery fails the message says what the extension saw', async () => {
  const h = harness();
  const sender = sabrSender();
  await h.request(sabrPlayer(), sender);
  // A streaming request whose body Chrome did not expose cannot be captured.
  h.events.beforeRequest({ requestId: 'no-body', tabId: 8, url: sabrStream() });
  const item = await sabrItem(h, sender);
  const rejected = await h.request(
    { action: 'download', item: { ...item, startNow: true } },
    sender,
  );
  assert.equal(rejected.ok, false);
  assert.match(rejected.error, /requests seen in this tab: 1; without a readable body: 1/);
  assert.equal(h.nativeRequests.length, 0);
});
test('a stored SABR capture is never reused for a different video', async () => {
  const playing = harness();
  await playing.request(sabrPlayer(), sabrSender());
  observeSabrRequest(playing);
  await settle();
  // After a restart, an in-page navigation to another video reports new player data
  // without a previous player to compare against.
  const restarted = harness(playing.data);
  const other = sabrSender('abcdefghijk');
  await restarted.request(sabrPlayer('abcdefghijk'), other);
  const item = await sabrItem(restarted, other);
  const rejected = await restarted.request(
    { action: 'download', item: { ...item, startNow: true } },
    other,
  );
  assert.equal(rejected.ok, false);
  assert.match(rejected.error, /Could not capture this YouTube video's stream/);
  assert.equal(restarted.nativeRequests.length, 0);
});
test('closing or reloading a tab removes its stored SABR capture', async () => {
  const playing = harness();
  await playing.request(sabrPlayer(), sabrSender());
  observeSabrRequest(playing);
  await settle();
  assert.match(JSON.stringify(playing.data), /AQID/);
  playing.events.updated(8, { status: 'loading' });
  await settle();
  assert.doesNotMatch(JSON.stringify(playing.data), /AQID/);
});
test('observing a video-only leaf never erases its master audio pairing', async () => {
  const h = harness();
  const sender = { id: 'extension-id', tab: { id: 3 } };
  const url = 'https://example.com/video.m3u8';
  await h.request(
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
  await h.request({ action: 'remember', items: [{ url, format: 'HLS' }] }, sender);
  const item = (await h.request({ action: 'listForFrame' }, sender)).items[0];
  assert.equal(item.audioUrl, 'https://example.com/audio.m3u8');
  assert.equal(item.masterUrl, 'https://example.com/master.m3u8');
});
test('frame list is restricted to its sender tab and excludes non-media links', async () => {
  const h = harness();
  await h.request(
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
  await h.request(
    { action: 'remember', items: [{ url: 'https://private.example/other.mp4' }] },
    { id: 'extension-id', tab: { id: 4 } },
  );
  const result = await h.request(
    { action: 'listForFrame', tabId: 4 },
    { id: 'extension-id', tab: { id: 3 } },
  );
  assert.equal(result.items.length, 2);
  assert.equal(result.items[0].url, 'https://example.com/a.mp4');
  assert.equal(result.items[1].unsupported, true);
  assert.equal(
    await h.request({ action: 'listForFrame' }, { id: 'foreign', tab: { id: 3 } }),
    undefined,
  );
  assert.equal((await h.request({ action: 'listForFrame' }, { id: 'extension-id' })).ok, false);
});

test('request credentials stay out of storage and cannot cross tab or URL boundaries', async () => {
  const h = harness();
  const url = 'https://example.com/video.mp4';
  h.events.requestHeaders({
    tabId: 3,
    url,
    requestHeaders: [{ name: 'Cookie', value: 'session=test-only' }],
  });
  await h.request({ action: 'download', item: { url } }, { id: 'extension-id', tab: { id: 3 } });
  assert.equal(h.nativeRequests[0].requestHeaders.cookie, 'session=test-only');
  await h.request({ action: 'download', item: { url } }, { id: 'extension-id', tab: { id: 4 } });
  assert.equal(h.nativeRequests[1].requestHeaders, undefined);
  assert.equal(JSON.stringify(h.data).includes('session=test-only'), false);
  h.events.updated(3, { status: 'loading' });
  await h.request({ action: 'download', item: { url } }, { id: 'extension-id', tab: { id: 3 } });
  assert.equal(h.nativeRequests[2].requestHeaders, undefined);
});

test('individual HLS media fragments are not listed as complete videos', async () => {
  const h = harness();
  const sender = { id: 'extension-id', tab: { id: 3 } };
  await h.request(
    {
      action: 'remember',
      items: ['a.m4s', 'a.ts', 'init.mp4', 'movie.mp4'].map((name) => ({
        url: `https://example.com/${name}`,
      })),
    },
    sender,
  );
  const result = await h.request({ action: 'listForFrame' }, sender);
  assert.equal(result.items.length, 1);
  assert.equal(result.items[0].url, 'https://example.com/movie.mp4');
});
test('media cache is bounded, deduplicated, and cleared on navigation', async () => {
  const h = harness();
  const sender = { id: 'extension-id', tab: { id: 9 } };
  const items = Array.from({ length: 120 }, (_, i) => ({ url: `https://example.com/${i}.mp4` }));
  await h.request({ action: 'remember', items: items.slice(0, 80) }, sender);
  await h.request({ action: 'remember', items: items.slice(60) }, sender);
  let result = await h.request({ action: 'listForFrame' }, sender);
  assert.equal(result.items.length, 100);
  assert.equal(new Set(result.items.map((i) => i.url)).size, 100);
  h.events.updated(9, { status: 'loading' });
  result = await h.request({ action: 'listForFrame' }, sender);
  assert.equal(result.items.length, 0);
});
