/* Downloads require extension UI messages; page player metadata is bounded and sanitized. */
if (typeof importScripts === 'function') {
  importScripts('hls.js', 'youtube-media.js');
}

const api = globalThis.browser || chrome;
const HOST = 'com.awesome.downloader';
const CACHE_KEY = 'mediaByTab';
// Chrome stops an idle service worker after about 30 seconds, so a capture made while the
// video played must outlive it. storage.session is memory-only (never written to disk) and
// is not readable by content scripts.
const SABR_KEY = 'sabrByTab';
let serial = Promise.resolve();
// Credentials stay in worker memory and are used only for the selected observed URL.
const requestContext = new Map();
// Captured SABR requests are kept per tab and per stream: an ad or preview played in the
// same tab must not replace the main video's capture.
const youtubePlayers = new Map();
const youtubeObserved = new Map();
const youtubeSabrObserved = new Map();
const youtubeSabrSeed = new Map();
const youtubeSabrStats = new Map();
const SABR_CAPTURES_PER_TAB = 5;
const SABR_RETRY_POLLS = 40;
const SABR_RETRY_INTERVAL_MS = 250;

function clearSabrCapture(tabId) {
  youtubeSabrObserved.delete(tabId);
  youtubeSabrStats.delete(tabId);

  for (const [id, seed] of youtubeSabrSeed) {
    if (seed.tabId === tabId) {
      youtubeSabrSeed.delete(id);
    }
  }

  updateSession(SABR_KEY, ({ [tabId]: removed, ...others }) => others).catch(() => {});
}

// The googlevideo `id` parameter names the media asset, so it tells streams apart.
const sabrStream = (value) => {
  try {
    return new URL(value).searchParams.get('id') || '';
  } catch {
    return '';
  }
};

function sabrStats(tabId) {
  let stats = youtubeSabrStats.get(tabId);

  if (!stats) {
    stats = { seen: 0, withoutBody: 0, fromPage: 0 };
    youtubeSabrStats.set(tabId, stats);

    if (youtubeSabrStats.size > 50) {
      youtubeSabrStats.delete(youtubeSabrStats.keys().next().value);
    }
  }

  return stats;
}

const watchVideoId = (value) => {
  try {
    const page = new URL(value);

    if (!['www.youtube.com', 'youtube.com', 'm.youtube.com'].includes(page.hostname)) {
      return null;
    }

    const id = page.searchParams.get('v') || /^\/shorts\/([\w-]{11})/.exec(page.pathname)?.[1];
    return /^[\w-]{11}$/.test(id || '') ? id : null;
  } catch {
    return null;
  }
};

// Each capture records its stream and the video the tab was showing.
async function rememberSabrCapture(tabId, seed) {
  const capture = {
    ...seed,
    stream: sabrStream(seed.url),
    videoId: youtubePlayers.get(tabId)?.videoId,
  };

  const key = capture.stream || capture.url;
  let captures = youtubeSabrObserved.get(tabId);

  if (!captures) {
    captures = new Map();
    youtubeSabrObserved.set(tabId, captures);

    if (youtubeSabrObserved.size > 50) {
      youtubeSabrObserved.delete(youtubeSabrObserved.keys().next().value);
    }
  }

  captures.delete(key);
  captures.set(key, capture);

  for (const old of [...captures.keys()].slice(0, -SABR_CAPTURES_PER_TAB)) {
    captures.delete(old);
  }

  // The page address names the main video even while an ad plays, and a worker woken by
  // this request has not yet seen the page's player data.
  try {
    capture.videoId = watchVideoId((await api.tabs.get(tabId)).url) || capture.videoId;
  } catch {
    // The tab may already be gone; keep the video ID from the player data.
  }

  await updateSession(SABR_KEY, (map) => {
    // Re-adding the key moves it to the end, so the oldest captures are dropped first.
    const { [key]: replaced, ...others } = map[tabId] || {};

    const stored = Object.fromEntries(
      Object.entries({ ...others, [key]: capture }).slice(-SABR_CAPTURES_PER_TAB),
    );

    return { ...map, [tabId]: stored };
  });
}

// Prefer the capture of the player's own stream; fall back to one recorded on its page.
function matchingCapture(captures, player) {
  const newest = [...captures].reverse();
  const stream = sabrStream(player.sabrUrl);
  return (
    (stream && newest.find((capture) => capture.stream === stream)) ||
    newest.find((capture) => capture.videoId === player.videoId)
  );
}

async function sabrCapture(tabId, player) {
  const found = matchingCapture(youtubeSabrObserved.get(tabId)?.values() || [], player);

  if (found) {
    return found;
  }

  // After a worker restart, only session storage still has the earlier captures.
  await serial;
  const stored = (await api.storage.session.get(SABR_KEY))[SABR_KEY]?.[tabId];
  return matchingCapture(Object.values(stored || {}), player);
}

// Instead of asking the user to play the video, have the page's player request its stream
// again and wait for that request to be captured.
async function waitForSabrCapture(tabId, player) {
  await api.tabs.sendMessage(tabId, { action: 'primeStream' }).catch(() => {});

  for (let attempt = 0; attempt < SABR_RETRY_POLLS; attempt += 1) {
    await new Promise((resolve) => {
      setTimeout(resolve, SABR_RETRY_INTERVAL_MS);
    });

    const captured = await sabrCapture(tabId, player);

    if (captured) {
      return captured;
    }
  }

  return undefined;
}

function bytesBase64(bytes) {
  let binary = '';
  const view = new Uint8Array(bytes);

  for (let offset = 0; offset < view.length; offset += 8192) {
    binary += String.fromCharCode(...view.subarray(offset, offset + 8192));
  }

  return btoa(binary);
}

api.webRequest.onBeforeRequest?.addListener(
  (details) => {
    const url = globalThis.youtubeMedia?.sabrUrl(details.url);
    const raw = details.requestBody?.raw;

    if (!url || details.tabId < 0) {
      return;
    }

    const stats = sabrStats(details.tabId);
    stats.seen += 1;
    let size = 0;

    for (const part of Array.isArray(raw) ? raw : []) {
      if (!part.bytes) {
        size = 0;
        break;
      }

      size += part.bytes.byteLength;
    }

    if (!size || size > 262144) {
      stats.withoutBody += 1;
      return;
    }

    const bytes = new Uint8Array(size);
    let offset = 0;

    for (const part of raw) {
      bytes.set(new Uint8Array(part.bytes), offset);
      offset += part.bytes.byteLength;
    }

    youtubeSabrSeed.set(details.requestId, {
      tabId: details.tabId,
      url,
      requestBody: bytesBase64(bytes),
    });

    if (youtubeSabrSeed.size > 100) {
      youtubeSabrSeed.delete(youtubeSabrSeed.keys().next().value);
    }
  },
  { urls: ['https://*.googlevideo.com/videoplayback*', 'https://googlevideo.com/videoplayback*'] },
  ['requestBody'],
);

function rememberRequest(details) {
  if (details.tabId < 0 || !httpUrl(details.url)) {
    return;
  }

  let tab = requestContext.get(details.tabId);

  if (!tab) {
    tab = new Map();
    requestContext.set(details.tabId, tab);

    if (requestContext.size > 50) {
      requestContext.delete(requestContext.keys().next().value);
    }
  }

  const headers = {};

  for (const header of details.requestHeaders || []) {
    const name = header.name.toLowerCase();

    if (
      ['cookie', 'authorization', 'user-agent', 'referer', 'origin'].includes(name) &&
      typeof header.value === 'string' &&
      header.value.length <= 16384 &&
      !/[\r\n]/.test(header.value)
    ) {
      headers[name] = header.value;
    }
  }

  tab.set(details.url, headers);

  if (tab.size > 100) {
    tab.delete(tab.keys().next().value);
  }
}

api.webRequest.onBeforeSendHeaders?.addListener(
  rememberRequest,
  { urls: ['http://*/*', 'https://*/*'] },
  ['requestHeaders', ...(globalThis.browser ? [] : ['extraHeaders'])],
);

function httpUrl(value) {
  try {
    const parsed = new URL(value);
    return ['http:', 'https:'].includes(parsed.protocol) && !parsed.username && !parsed.password
      ? parsed.href
      : null;
  } catch {
    return null;
  }
}

function unsupported(url, mime = '') {
  return /\.mpd(?:[?#]|$)/i.test(url) || /dash\+xml/i.test(mime);
}

function isFragment(url) {
  return /\.(m4s|ts|aac)(?:[?#]|$)/i.test(url) || /\/init[^/]*\.mp4(?:[?#]|$)/i.test(url);
}

const hlsSeen = new Map();
let hlsActive = 0;

async function discoverHls(tabId, url) {
  if (tabId < 0 || hlsActive >= 8) {
    return;
  }

  let seen = hlsSeen.get(tabId);

  if (!seen) {
    seen = new Set();
    hlsSeen.set(tabId, seen);

    if (hlsSeen.size > 50) {
      hlsSeen.delete(hlsSeen.keys().next().value);
    }
  }

  if (seen.has(url) || seen.size >= 20) {
    return;
  }

  seen.add(url);
  hlsActive += 1;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 10000);

  try {
    const response = await fetch(url, { signal: controller.signal, credentials: 'omit' });

    if (!response.ok) {
      throw new Error('Manifest fetch failed.');
    }

    const reader = response.body.getReader();
    let size = 0;
    const chunks = [];

    while (true) {
      const { done, value } = await reader.read();

      if (done) {
        break;
      }

      size += value.length;

      if (size > 1048576) {
        await reader.cancel();
        throw new Error('Manifest too large.');
      }

      chunks.push(value);
    }

    const bytes = new Uint8Array(size);
    let offset = 0;

    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.length;
    }

    const variants = globalThis.parseHlsMaster(
      new TextDecoder().decode(bytes),
      response.url || url,
    );

    let title = '';

    try {
      title = (await api.tabs.get(tabId)).title || '';
    } catch {
      // The tab may already be gone; the variants are still worth listing.
    }

    if (hlsSeen.get(tabId) === seen) {
      await remember(
        tabId,
        variants.map((item) => ({ ...item, title })),
      );
    }
  } catch {
    // Unreachable, oversized or invalid manifests are simply not listed.
  } finally {
    clearTimeout(timer);
    hlsActive -= 1;
  }
}

function nativeSend(payload) {
  return new Promise((resolve, reject) => {
    // Chrome callbacks retain useful runtime.lastError diagnostics.
    if (!globalThis.browser) {
      chrome.runtime.sendNativeMessage(HOST, payload, (result) => {
        if (chrome.runtime.lastError) {
          reject(new Error(chrome.runtime.lastError.message));
        } else if (!result?.ok) {
          reject(new Error(result?.error || 'The desktop app did not accept this download.'));
        } else {
          resolve(result);
        }
      });
    } else {
      browser.runtime
        .sendNativeMessage(HOST, payload)
        .then(
          (result) =>
            result?.ok
              ? resolve(result)
              : reject(new Error(result?.error || 'Desktop rejected download.')),
          reject,
        );
    }
  });
}

// The highest-quality video choice the in-page menu would offer for the video open in
// this tab (H.264 first within a quality), or undefined if that video is not open there.
async function bestYoutubeChoice(tabId, videoId) {
  if (youtubePlayers.get(tabId)?.videoId !== videoId) {
    await api.tabs.sendMessage(tabId, { action: 'refreshPlayer' }).catch(() => {});
  }

  const player = youtubePlayers.get(tabId);

  if (player?.videoId !== videoId) {
    return undefined;
  }

  const height = (choice) => Number.parseInt(choice.quality, 10) || 0;

  return globalThis.youtubeMedia
    .choices(player, youtubeObserved.get(tabId) || [])
    .filter((choice) => choice.format === 'MP4')
    .sort((first, second) => height(second) - height(first))[0];
}

async function enqueue(item, tabId) {
  // "Find page links" and the link menu can pick a YouTube page address, which the
  // desktop can only download with the optional yt-dlp tool. When it is the video open
  // in this tab, download it through the captured stream like the in-page menu does.
  const pageVideoId = !item.sabrSelection && !item.youtubeFormat && watchVideoId(item.url);

  if (pageVideoId) {
    const choice = await bestYoutubeChoice(tabId, pageVideoId);

    if (choice) {
      return enqueue({ ...choice, startNow: item.startNow, referer: item.referer }, tabId);
    }
  }

  let sabr;

  if (item.sabrSelection) {
    const player = youtubePlayers.get(tabId);
    const selection = item.sabrSelection;
    const videoItag = selection.videoItag === undefined ? undefined : Number(selection.videoItag);
    const audioItag = Number(selection.audioItag);

    if (
      !player ||
      !Number.isSafeInteger(audioItag) ||
      audioItag <= 0 ||
      (videoItag !== undefined && (!Number.isSafeInteger(videoItag) || videoItag <= 0))
    ) {
      throw new Error('The captured YouTube session expired. Reopen the menu.');
    }

    const audio = player.formats.find(
      (format) => format.itag === audioItag && /^audio\/mp4/i.test(format.mimeType),
    );

    const video =
      videoItag === undefined
        ? undefined
        : player.formats.find(
            (format) => format.itag === videoItag && /^video\/mp4/i.test(format.mimeType),
          );

    const captured =
      (await sabrCapture(tabId, player)) || (await waitForSabrCapture(tabId, player));

    if (!captured) {
      const stats = youtubeSabrStats.get(tabId) || { seen: 0, withoutBody: 0, fromPage: 0 };
      throw new Error(
        `Could not capture this YouTube video's stream. Reload the page, play the video for a few seconds, then try again. (Streaming requests seen in this tab: ${stats.seen}; without a readable body: ${stats.withoutBody}; copied by the page: ${stats.fromPage}.)`,
      );
    }

    const serverAbrStreamingUrl = captured.url;

    if (
      !audio ||
      (videoItag !== undefined && !video) ||
      !globalThis.youtubeMedia.sabrUrl(serverAbrStreamingUrl) ||
      !player.ustreamerConfig
    ) {
      throw new Error(
        'The captured YouTube SABR session is incomplete. Play the video briefly and reopen the menu.',
      );
    }

    sabr = {
      videoId: player.videoId,
      serverAbrStreamingUrl,
      videoPlaybackUstreamerConfig: player.ustreamerConfig,
      clientInfo: { clientName: player.clientName, clientVersion: player.clientVersion },
      formats: player.formats,
      videoItag,
      audioItag,
      requestBody: captured.requestBody,
    };
  }

  const url = httpUrl(sabr?.serverAbrStreamingUrl || item.url);

  if (!url) {
    throw new Error('Only direct HTTP and HTTPS links are supported.');
  }

  if (unsupported(url, item.mime) || item.unsupported) {
    throw new Error(item.reason || 'DASH streams are unsupported.');
  }

  const requestHeaders = requestContext.get(tabId)?.get(url);
  return nativeSend({
    action: 'download',
    url,
    youtubeFormat: item.youtubeFormat,
    sabr,
    startNow: item.startNow === true,
    audioUrl: httpUrl(item.audioUrl) || undefined,
    outputFormat: item.outputFormat,
    filename: item.filename,
    referer: httpUrl(requestHeaders?.referer || item.referer) || undefined,
    requestHeaders,
  });
}

function updateCache(change) {
  return updateSession(CACHE_KEY, change);
}

// `change` receives the stored map and returns the map to store.
function updateSession(key, change) {
  const next = serial.then(async () => {
    const data = await api.storage.session.get(key);
    const changed = await change(data[key] || {});
    // Bound total tracked tabs as well as each tab's results.
    const bounded = Object.fromEntries(Object.entries(changed).slice(-50));
    await api.storage.session.set({ [key]: bounded });
  });

  serial = next.catch(() => {});
  return next;
}

// Adds one observed item to a tab's list, or refreshes the entry it repeats.
function rememberItem(prior, item) {
  const url = httpUrl(item.url);

  if (!url || isFragment(url)) {
    return prior;
  }

  const entry = {
    url,
    mime: String(item.mime || '').slice(0, 100),
    title: String(item.title || '').slice(0, 180),
    quality: String(item.quality || '').slice(0, 40),
    bitrate: Number(item.bitrate) || 0,
    format: String(item.format || '').slice(0, 20),
    separateAudio: !!item.separateAudio,
    reason: String(item.reason || '').slice(0, 180),
    unsupported: unsupported(url, item.mime) || !!item.unsupported,
  };

  entry.audioUrl = httpUrl(item.audioUrl) || undefined;
  entry.codecs = String(item.codecs || '').slice(0, 200);
  entry.masterUrl = httpUrl(item.masterUrl) || undefined;
  const existingIndex = prior.findIndex((known) => known.url === url);

  if (existingIndex < 0) {
    return [...prior, entry];
  }

  const stored = prior[existingIndex];

  if (stored.format === 'HLS' && !item.format) {
    if (entry.title) {
      stored.title = entry.title;
    }

    return prior;
  }

  const next = [...prior];

  next[existingIndex] = {
    ...stored,
    ...entry,
    audioUrl: entry.audioUrl || stored.audioUrl,
    codecs: entry.codecs || stored.codecs,
    masterUrl: entry.masterUrl || stored.masterUrl,
    title: entry.title || stored.title,
    quality: entry.quality || stored.quality,
    bitrate: entry.bitrate || stored.bitrate,
    format: entry.format || stored.format,
    separateAudio: entry.separateAudio || stored.separateAudio,
    unsupported: entry.unsupported || stored.unsupported,
    reason: entry.reason || stored.reason,
  };

  return next;
}

async function remember(tabId, items) {
  if (tabId < 0) {
    return;
  }

  await updateCache((map) => ({
    ...map,
    [tabId]: items
      .slice(0, 100)
      .reduce(rememberItem, map[tabId] || [])
      .slice(-100),
  }));
}

api.webRequest.onHeadersReceived.addListener(
  (details) => {
    const mime =
      details.responseHeaders?.find((header) => header.name.toLowerCase() === 'content-type')
        ?.value || '';

    const captured = globalThis.youtubeMedia?.mediaUrl(details.url);
    const capturedSabr = globalThis.youtubeMedia?.sabrUrl(details.url);

    if (capturedSabr && details.tabId >= 0 && [200, 206].includes(details.statusCode)) {
      const seed = youtubeSabrSeed.get(details.requestId);

      if (seed?.tabId === details.tabId && seed.url === capturedSabr) {
        rememberSabrCapture(details.tabId, seed).catch(() => {});
      }

      youtubeSabrSeed.delete(details.requestId);
    }

    if (
      captured &&
      details.tabId >= 0 &&
      [200, 206].includes(details.statusCode) &&
      /^(video|audio)\//i.test(mime)
    ) {
      const urls = youtubeObserved.get(details.tabId) || [];

      if (!urls.includes(captured)) {
        urls.unshift(captured);
      }

      youtubeObserved.set(details.tabId, urls.slice(0, 100));

      if (youtubeObserved.size > 50) {
        youtubeObserved.delete(youtubeObserved.keys().next().value);
      }
    }

    if (
      details.type === 'media' ||
      /^(video|audio)\//i.test(mime) ||
      unsupported(details.url, mime)
    ) {
      remember(details.tabId, [{ url: details.url, mime }]).catch(() => {});
    }

    if (/\.m3u8(?:[?#]|$)/i.test(details.url) || /mpegurl/i.test(mime)) {
      discoverHls(details.tabId, details.url);
    }
  },
  { urls: ['http://*/*', 'https://*/*'] },
  ['responseHeaders'],
);

api.tabs.onRemoved.addListener((tabId) => {
  youtubePlayers.delete(tabId);
  youtubeObserved.delete(tabId);
  clearSabrCapture(tabId);
  requestContext.delete(tabId);
  hlsSeen.delete(tabId);
  updateCache(({ [tabId]: removed, ...others }) => others).catch(() => {});
});

api.tabs.onUpdated.addListener((tabId, change) => {
  if (change.status === 'loading') {
    youtubePlayers.delete(tabId);
    youtubeObserved.delete(tabId);
    clearSabrCapture(tabId);
    requestContext.delete(tabId);
    hlsSeen.delete(tabId);
    updateCache(({ [tabId]: removed, ...others }) => others).catch(() => {});
  }
});

api.runtime.onInstalled.addListener(async () => {
  try {
    await api.contextMenus.removeAll();

    api.contextMenus.create({
      id: 'awesome-link',
      title: 'Download with Awesome Downloader',
      contexts: ['link', 'video', 'audio'],
    });

    api.contextMenus.create({
      id: 'awesome-page',
      title: 'Find downloadable links on this page',
      contexts: ['page'],
    });
  } catch (error) {
    await api.storage.local.set({ lastError: error.message });
  }
});

api.contextMenus.onClicked.addListener(async (info, tab) => {
  try {
    if (info.menuItemId === 'awesome-page') {
      await api.tabs.sendMessage(tab.id, { action: 'collectLinks' });
      await api.action.setBadgeText({ tabId: tab.id, text: 'LINK' });
      return;
    }

    await enqueue({ url: info.linkUrl || info.srcUrl, referer: tab?.url }, tab?.id);
    await api.action.setBadgeText({ tabId: tab.id, text: 'OK' });
  } catch (error) {
    await api.storage.local.set({ lastError: error.message });

    if (tab?.id) {
      await api.action.setBadgeText({ tabId: tab.id, text: '!' });
    }
  }
});

api.runtime.onMessage.addListener((message, sender, respond) => {
  if (sender.id !== api.runtime.id) {
    return false;
  }

  const task = async () => {
    // A copy of a successful streaming request, taken by the YouTube page script.
    if (message.action === 'sabrRequest' && sender.tab) {
      const page = new URL(sender.url || sender.tab.url || 'https://invalid.local');
      const url = globalThis.youtubeMedia.sabrUrl(message.data?.url);
      const body = String(message.data?.body || '');

      if (
        !['www.youtube.com', 'youtube.com', 'm.youtube.com'].includes(page.hostname) ||
        !url ||
        !body ||
        body.length > 350000 ||
        !/^[A-Za-z0-9+/]*={0,2}$/.test(body)
      ) {
        throw new Error('Invalid streaming request.');
      }

      sabrStats(sender.tab.id).fromPage += 1;

      await rememberSabrCapture(sender.tab.id, {
        tabId: sender.tab.id,
        url,
        requestBody: body,
      });

      return { ok: true };
    }

    if (message.action === 'playerResponse' && sender.tab) {
      const page = new URL(sender.url || sender.tab.url || 'https://invalid.local');

      if (!['www.youtube.com', 'youtube.com', 'm.youtube.com'].includes(page.hostname)) {
        throw new Error('Invalid player source.');
      }

      const { data } = message;

      if (!data || !Array.isArray(data.formats) || data.formats.length > 150) {
        throw new Error('Invalid player data.');
      }

      const clean = globalThis.youtubeMedia.sanitizePlayer(data);

      if (clean) {
        const previous = youtubePlayers.get(sender.tab.id);

        // Captures are matched to their own stream, so they are kept when an ad's
        // or preview's player data arrives in between.
        if (previous && previous.videoId !== clean.videoId) {
          youtubeObserved.delete(sender.tab.id);
        }

        youtubePlayers.set(sender.tab.id, clean);

        if (youtubePlayers.size > 50) {
          youtubePlayers.delete(youtubePlayers.keys().next().value);
        }
      }

      return { ok: true };
    }

    if (message.action === 'remember' && sender.tab) {
      await remember(sender.tab.id, message.items || []);
      return { ok: true };
    }

    if (message.action === 'download') {
      const tabId = sender.tab?.id ?? message.tabId;
      return enqueue({ ...message.item, referer: sender.tab?.url || message.item?.referer }, tabId);
    }

    if (message.action === 'list' && !sender.tab) {
      await serial;
      const data = await api.storage.session.get(CACHE_KEY);
      return { ok: true, items: data[CACHE_KEY]?.[message.tabId] || [] };
    }

    if (message.action === 'listForFrame' && sender.tab) {
      const page = new URL(sender.tab.url || 'https://invalid.local');

      if (['www.youtube.com', 'youtube.com', 'm.youtube.com'].includes(page.hostname)) {
        const id = watchVideoId(page.href);

        if (!id) {
          return { ok: true, items: [] };
        }

        await api.tabs.sendMessage(sender.tab.id, { action: 'refreshPlayer' }).catch(() => {});
        const player = youtubePlayers.get(sender.tab.id);
        const active = player?.videoId === id ? player : null;

        const items = active
          ? globalThis.youtubeMedia.choices(active, youtubeObserved.get(sender.tab.id) || [])
          : [];

        return {
          ok: true,
          items,
          notice:
            !items.length && player?.videoId === id && player.sabr
              ? 'This video uses YouTube SABR streaming, which this version cannot download yet. No download has been started.'
              : undefined,
        };
      }

      await serial;
      const data = await api.storage.session.get(CACHE_KEY);
      return {
        ok: true,
        items: (data[CACHE_KEY]?.[sender.tab.id] || []).filter(
          (item) =>
            item.unsupported ||
            item.format === 'HLS' ||
            /^(video|audio)\//i.test(item.mime) ||
            /\.(m3u8|mp4|webm|mov|m4v|mp3|m4a|ogg|wav)(?:[?#]|$)/i.test(item.url),
        ),
      };
    }

    throw new Error('Unsupported extension request.');
  };

  task().then(respond, (error) => respond({ ok: false, error: error.message }));
  return true;
});

api.downloads.onCreated.addListener(async (item) => {
  let paused = false;

  try {
    const { interceptDownloads = false } = await api.storage.local.get('interceptDownloads');

    if (!interceptDownloads || !httpUrl(item.finalUrl || item.url)) {
      return;
    }

    // IDM's observed ownership model: pause during handoff, resume on failure.
    await api.downloads.pause(item.id);
    paused = true;

    await enqueue(
      {
        url: item.finalUrl || item.url,
        filename: item.filename?.split(/[\\/]/).pop(),
        referer: item.referrer,
      },
      item.tabId,
    );

    await api.downloads.cancel(item.id);
  } catch (error) {
    if (paused) {
      await api.downloads.resume(item.id).catch(() => {});
    }

    await api.storage.local.set({ lastError: `Browser download was kept: ${error.message}` });
  }
});
