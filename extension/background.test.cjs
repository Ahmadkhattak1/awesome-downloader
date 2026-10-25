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

const settle = () =>
  new Promise((resolve) => {
    setTimeout(resolve, 0);
  });

const sabrItem = async (worker, sender) =>
  (await worker.request({ action: 'listForFrame' }, sender)).items.find(
    (value) => value.quality === '1080p',
  );

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

  const worker = harness(
    {},
    {
      onTabMessage(message) {
        sent.push(message.action);

        // The page's player answers the nudge with a fresh streaming request.
        if (message.action === 'primeStream') {
          observeSabrRequest(worker);
        }
      },
    },
  );

  const sender = sabrSender();
  await worker.request(sabrPlayer(), sender);
  const item = await sabrItem(worker, sender);

  const result = await worker.request(
    { action: 'download', item: { ...item, startNow: true } },
    sender,
  );

  assert.equal(result.ok, true);
  assert.ok(sent.includes('primeStream'));
  assert.equal(worker.nativeRequests[0].sabr.requestBody, 'AQID');
});

test('a streaming request copied by the page is used when Chrome hides its body', async () => {
  const sent = [];
  const worker = harness({}, { onTabMessage: (message) => sent.push(message.action) });
  const sender = sabrSender();
  await worker.request(sabrPlayer(), sender);
  // What Chrome reports today: the request is visible, its body is not.
  worker.events.beforeRequest({ requestId: 'hidden', tabId: 8, url: sabrStream() });

  const copied = await worker.request(
    { action: 'sabrRequest', data: { url: sabrStream(), body: 'AQID' } },
    sender,
  );

  assert.equal(copied.ok, true);
  const item = await sabrItem(worker, sender);

  const result = await worker.request(
    { action: 'download', item: { ...item, startNow: true } },
    sender,
  );

  assert.equal(result.ok, true);
  assert.equal(worker.nativeRequests[0].sabr.requestBody, 'AQID');
  assert.equal(worker.nativeRequests[0].sabr.serverAbrStreamingUrl, sabrStream());
  assert.ok(!sent.includes('primeStream'));
});

test('page-copied streaming requests are accepted only from YouTube for SABR URLs', async () => {
  const worker = harness();

  for (const [sender, data] of [
    [
      { id: 'extension-id', tab: { id: 8, url: 'https://example.com/watch?v=wLdZWyLOJCI' } },
      { url: sabrStream(), body: 'AQID' },
    ],
    [sabrSender(), { url: 'https://example.com/videoplayback?sabr=1', body: 'AQID' }],
    [sabrSender(), { url: sabrStream(), body: 'not base64!' }],
  ]) {
    assert.equal((await worker.request({ action: 'sabrRequest', data }, sender)).ok, false);
  }

  assert.doesNotMatch(JSON.stringify(worker.data), /AQID/);
});

test('an ad played in between keeps the main video capture', async () => {
  const sent = [];
  const worker = harness({}, { onTabMessage: (message) => sent.push(message.action) });
  const sender = sabrSender();
  await worker.request(sabrPlayer(), sender);
  observeSabrRequest(worker, { requestId: 'main', body: [1, 2, 3] });
  // A mid-roll ad brings its own player data and streaming requests into the same tab.
  await worker.request(sabrPlayer('adVideo0001'), sender);
  observeSabrRequest(worker, { requestId: 'ad', videoId: 'adVideo0001', body: [9, 9, 9] });
  await worker.request(sabrPlayer(), sender);
  const item = await sabrItem(worker, sender);

  const result = await worker.request(
    { action: 'download', item: { ...item, startNow: true } },
    sender,
  );

  assert.equal(result.ok, true);
  assert.equal(worker.nativeRequests[0].sabr.requestBody, 'AQID');
  assert.equal(worker.nativeRequests[0].sabr.serverAbrStreamingUrl, sabrStream());
  assert.ok(!sent.includes('primeStream'));
});

// "Find page links" in the popup lists every link, including YouTube watch pages.
const popupSender = { id: 'extension-id' };

test('a watch link for the open video downloads through its captured stream', async () => {
  const worker = harness();
  await worker.request(sabrPlayer(), sabrSender());
  observeSabrRequest(worker);

  const result = await worker.request(
    {
      action: 'download',
      tabId: 8,
      item: { url: 'https://www.youtube.com/watch?v=wLdZWyLOJCI', title: 'Captured' },
    },
    popupSender,
  );

  assert.equal(result.ok, true);
  assert.equal(worker.nativeRequests[0].url, sabrStream());
  assert.equal(worker.nativeRequests[0].sabr.videoItag, 137);
  assert.equal(worker.nativeRequests[0].sabr.audioItag, 140);
  assert.equal(worker.nativeRequests[0].outputFormat, 'mp4');
});

test('a watch link for another video is sent to the desktop unchanged', async () => {
  const worker = harness();
  await worker.request(sabrPlayer(), sabrSender());
  const otherVideo = 'https://www.youtube.com/watch?v=abcdefghijk';

  await worker.request({ action: 'download', tabId: 8, item: { url: otherVideo } }, popupSender);

  assert.equal(worker.nativeRequests[0].url, otherVideo);
  assert.equal(worker.nativeRequests[0].sabr, undefined);
});

test('when recovery fails the message says what the extension saw', async () => {
  const worker = harness();
  const sender = sabrSender();
  await worker.request(sabrPlayer(), sender);
  // A streaming request whose body Chrome did not expose cannot be captured.
  worker.events.beforeRequest({ requestId: 'no-body', tabId: 8, url: sabrStream() });
  const item = await sabrItem(worker, sender);

  const rejected = await worker.request(
    { action: 'download', item: { ...item, startNow: true } },
    sender,
  );

  assert.equal(rejected.ok, false);
  assert.match(rejected.error, /requests seen in this tab: 1; without a readable body: 1/);
  assert.equal(worker.nativeRequests.length, 0);
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
