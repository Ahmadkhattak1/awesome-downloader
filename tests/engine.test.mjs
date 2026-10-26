import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomBytes, createHash } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { DownloadEngine, safeFilename } from '../dist/core/engine.mjs';
import { startBridge } from '../dist/core/bridge.mjs';

async function fixture(testContext, options = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'awesome-download-test-'));
  const data = randomBytes(3 * 1024 * 1024 + 37);
  const ranges = [];

  const server = http.createServer((req, res) => {
    if (req.url === '/redirect') {
      res.writeHead(302, { location: '/file.bin' });
      res.end();
      return;
    }

    if (req.url === '/missing') {
      res.writeHead(404);
      res.end();
      return;
    }

    const noRange = req.url === '/plain';
    res.setHeader('etag', options.etag || '"fixture-1"');

    if (!noRange) {
      res.setHeader('accept-ranges', 'bytes');
    }

    let start = 0;
    let end = data.length - 1;
    let status = 200;

    if (req.headers.range && req.url === '/ignore-range') {
      res.setHeader('content-length', data.length);
      res.end(data);
      return;
    }

    if (req.headers.range && !noRange) {
      [, start, end] = /^bytes=(\d+)-(\d+)$/.exec(req.headers.range).map(Number);
      ranges.push([start, end]);
      status = 206;
      res.setHeader('content-range', `bytes ${start}-${end}/${data.length}`);
    }

    res.setHeader('content-length', end - start + 1);
    res.writeHead(status);

    if (req.method === 'HEAD') {
      res.end();
      return;
    }

    if (options.slow) {
      let offset = start;

      const interval = setInterval(() => {
        if (offset > end) {
          clearInterval(interval);
          res.end();
          return;
        }

        const next = Math.min(end + 1, offset + 16384);
        res.write(data.subarray(offset, next));
        offset = next;
      }, 5);

      res.on('close', () => clearInterval(interval));
    } else {
      res.end(data.subarray(start, end + 1));
    }
  });

  await new Promise((resolve) => {
    server.listen(0, '127.0.0.1', resolve);
  });

  const engine = await new DownloadEngine({
    dataDirectory: path.join(root, 'state'),
    downloadDirectory: path.join(root, 'downloads'),
    tickMs: 30,
  }).init();

  testContext.after(async () => {
    await engine.close();
    server.closeAllConnections();

    await new Promise((resolve) => {
      server.close(resolve);
    });

    await fs.rm(root, { recursive: true, force: true });
  });

  return { engine, data, ranges, root, url: `http://127.0.0.1:${server.address().port}` };
}

test('repeated concurrent browser clicks reuse one active download but allow retry after cancel', async (testContext) => {
  const setup = await fixture(testContext);
  const request = { url: `${setup.url}/file.bin`, queueOnly: true, reuseActive: true };

  const ids = await Promise.all([
    setup.engine.add(request),
    setup.engine.add(request),
    setup.engine.add(request),
  ]);

  assert.equal(new Set(ids.flat()).size, 1);
  assert.equal(setup.engine.downloads.length, 1);
  await setup.engine.action(ids[0][0], 'cancel');
  const retry = await setup.engine.add(request);
  assert.notEqual(retry[0], ids[0][0]);
});

test('review prompt supports Download Later and cancellation without transferring bytes', async (testContext) => {
  const setup = await fixture(testContext);
  const request = { url: `${setup.url}/file.bin`, reviewOnly: true, reuseActive: true };
  const [id] = await setup.engine.add(request);
  assert.deepEqual(await setup.engine.add(request), [id]);
  await setup.engine.reviewDownload({ id, queueOnly: true });
  await delay(40);
  const download = setup.engine.downloads.find((item) => item.id === id);
  assert.equal(download.status, 'paused');
  assert.equal(download.needsReview, false);
  assert.equal(download.downloaded, 0);
  const [cancelId] = await setup.engine.add({ ...request, url: `${setup.url}/plain` });
  await setup.engine.action(cancelId, 'remove');

  assert.equal(
    setup.engine.downloads.some((item) => item.id === cancelId),
    false,
  );
});

test('browser SABR reuse identifies video and quality rather than expiring URL', async (testContext) => {
  const setup = await fixture(testContext);

  const sabr = {
    videoId: 'wLdZWyLOJCI',
    serverAbrStreamingUrl: 'https://r1.googlevideo.com/videoplayback?sabr=1',
    videoPlaybackUstreamerConfig: 'AQID',
    audioItag: 140,
    videoItag: 137,
    formats: [
      { itag: 137, mimeType: 'video/mp4', qualityLabel: '1080p' },
      { itag: 136, mimeType: 'video/mp4', qualityLabel: '720p' },
      { itag: 140, mimeType: 'audio/mp4', audioQuality: 'AUDIO_QUALITY_MEDIUM' },
    ],
  };

  const request = {
    url: sabr.serverAbrStreamingUrl,
    sabr,
    outputFormat: 'mp4',
    queueOnly: true,
    reuseActive: true,
  };

  const first = await setup.engine.add(request);

  assert.deepEqual(
    await setup.engine.add({
      ...request,
      url: `${request.url}&new=1`,
      sabr: { ...sabr, serverAbrStreamingUrl: `${request.url}&new=1` },
    }),
    first,
  );

  assert.notDeepEqual(
    await setup.engine.add({ ...request, sabr: { ...sabr, videoItag: 136 } }),
    first,
  );
});

async function until(check, timeout = 8000) {
  const deadline = Date.now() + timeout;

  while (!check()) {
    if (Date.now() > deadline) {
      throw new Error('Timed out waiting for download state.');
    }

    await delay(15);
  }
}

const digest = (buffer) => createHash('sha256').update(buffer).digest('hex');

test('parallel ranged transfers reconstruct exact bytes and preserve existing filenames', async (testContext) => {
  const setup = await fixture(testContext);
  await fs.mkdir(path.join(setup.root, 'downloads'));
  await fs.writeFile(path.join(setup.root, 'downloads', 'file.bin'), 'existing');
  const [id] = await setup.engine.add({ url: `${setup.url}/redirect` });
  const download = setup.engine.downloads.find((item) => item.id === id);
  await until(() => ['complete', 'error'].includes(download.status));
  assert.equal(download.status, 'complete', download.error);
  assert.ok(setup.ranges.length > 1);
  assert.equal(digest(await fs.readFile(download.path)), digest(setup.data));

  assert.equal(
    await fs.readFile(path.join(setup.root, 'downloads', 'file.bin'), 'utf8'),
    'existing',
  );

  assert.equal(download.filename, 'file (1).bin');
});

test('pause then resume from saved partial bytes produces exact output', async (testContext) => {
  const setup = await fixture(testContext, { slow: true });
  const [id] = await setup.engine.add({ url: `${setup.url}/file.bin` });
  const download = setup.engine.downloads[0];
  await until(() => download.downloaded > 150000);
  await setup.engine.action(id, 'pause');
  assert.equal(download.status, 'paused');
  const partial = download.downloaded;
  assert.ok(partial > 0 && partial < setup.data.length);
  const priorRanges = setup.ranges.length;
  await setup.engine.action(id, 'resume');
  await until(() => ['complete', 'error'].includes(download.status));
  assert.equal(download.status, 'complete', download.error);
  assert.equal(digest(await fs.readFile(download.path)), digest(setup.data));

  assert.ok(
    setup.ranges
      .slice(priorRanges)
      .some(([start]) => start % Math.floor(setup.data.length / download.segments.length) !== 0),
  );
});

test('non-range server downloads sequentially and queue/scheduled history survives restart', async (testContext) => {
  const setup = await fixture(testContext);
  await setup.engine.add({ url: `${setup.url}/plain` });
  const download = setup.engine.downloads[0];
  await until(() => ['complete', 'error'].includes(download.status));
  assert.equal(download.status, 'complete', download.error);
  assert.equal(digest(await fs.readFile(download.path)), digest(setup.data));
  assert.equal(download.connections, 1);

  await setup.engine.add({
    url: `${setup.url}/file.bin`,
    scheduledAt: new Date(Date.now() + 60000).toISOString(),
  });

  await setup.engine.close();

  const restored = await new DownloadEngine({
    dataDirectory: path.join(setup.root, 'state'),
    downloadDirectory: path.join(setup.root, 'downloads'),
  }).init();

  testContext.after(() => restored.close());
  assert.equal(restored.downloads[1].status, 'scheduled');
  assert.equal(restored.downloads[0].status, 'complete');
  await restored.close();
});

test('invalid batches fail atomically; reserved Windows names are sanitized', async (testContext) => {
  const setup = await fixture(testContext);
  await assert.rejects(setup.engine.add({ urls: [`${setup.url}/file.bin`, 'file:///C:/secret'] }));
  assert.equal(setup.engine.downloads.length, 0);
  assert.equal(safeFilename('../../CON.exe'), 'download_CON.exe');
  await assert.rejects(setup.engine.add({ url: `${setup.url}/stream.mpd` }), /muxing engine/);
});

test('bridge requires token and rejects web origins before enqueuing', async (testContext) => {
  const setup = await fixture(testContext);

  const bridge = await startBridge(setup.engine, {
    dataDirectory: path.join(setup.root, 'state'),
    port: 0,
  });

  testContext.after(() => bridge.close());
  const endpoint = `http://127.0.0.1:${bridge.port}/downloads`;

  const { token } = JSON.parse(
    await fs.readFile(path.join(setup.root, 'state', 'bridge.json'), 'utf8'),
  );

  assert.equal((await fetch(endpoint, { method: 'POST', body: '{}' })).status, 401);
  const headers = { 'content-type': 'application/json', authorization: `Bearer ${token}` };

  assert.equal(
    (
      await fetch(endpoint, {
        method: 'POST',
        headers: { ...headers, origin: 'https://example.com' },
        body: '{}',
      })
    ).status,
    403,
  );

  const response = await fetch(endpoint, {
    method: 'POST',
    headers,
    body: JSON.stringify({ url: `${setup.url}/file.bin` }),
  });

  assert.equal(response.status, 201);
  assert.equal((await response.json()).ids.length, 1);
});

test('restart recovers paused offsets from actual disk files', async (testContext) => {
  const setup = await fixture(testContext, { slow: true });
  const [id] = await setup.engine.add({ url: `${setup.url}/file.bin` });
  await until(() => setup.engine.downloads[0].downloaded > 100000);
  await setup.engine.close();

  const restored = await new DownloadEngine({
    dataDirectory: path.join(setup.root, 'state'),
    downloadDirectory: path.join(setup.root, 'downloads'),
    tickMs: 30,
  }).init();

  try {
    assert.equal(restored.downloads[0].status, 'paused');
    await restored.action(id, 'resume');
    await until(() => ['complete', 'error'].includes(restored.downloads[0].status));
    const download = restored.downloads[0];
    assert.equal(download.status, 'complete', download.error);
    assert.equal(digest(await fs.readFile(download.path)), digest(setup.data));
  } finally {
    await restored.close();
  }
});

test('server ignoring ranges fails without publishing corrupt files', async (testContext) => {
  const setup = await fixture(testContext);
  await setup.engine.add({ url: `${setup.url}/ignore-range` });
  const download = setup.engine.downloads[0];
  await until(() => download.status === 'error');
  assert.match(download.error, /instead of a byte range/);
  assert.equal(download.path, null);
});

test('cancel releases queue capacity and removes partial files', async (testContext) => {
  const setup = await fixture(testContext, { slow: true });
  await setup.engine.updateSettings({ maxConcurrent: 1 });

  const [first, second] = await setup.engine.add({
    urls: [`${setup.url}/a.bin`, `${setup.url}/b.bin`],
  });

  await until(() => setup.engine.downloads[0].downloaded > 80000);
  assert.equal(setup.engine.downloads[1].status, 'queued');
  await setup.engine.action(first, 'cancel');
  assert.equal(setup.engine.downloads[0].status, 'cancelled');
  assert.equal(setup.engine.downloads[0].downloaded, 0);
  await assert.rejects(fs.stat(path.join(setup.root, 'state', 'parts', first)), { code: 'ENOENT' });

  await until(
    () => setup.engine.downloads.find((download) => download.id === second).status === 'complete',
  );
});

test('scheduled downloads start when due and settings reject invalid changes atomically', async (testContext) => {
  const setup = await fixture(testContext);
  const before = { ...setup.engine.settings };
  assert.throws(() => setup.engine.updateSettings({ maxConcurrent: 1, connections: -1 }));
  assert.deepEqual(setup.engine.settings, before);

  await setup.engine.add({
    url: `${setup.url}/file.bin`,
    scheduledAt: new Date(Date.now() + 120).toISOString(),
  });

  assert.equal(setup.engine.downloads[0].status, 'scheduled');
  await until(() => setup.engine.downloads[0].status === 'complete');
});

test('browser review persists pending intent and starts only after confirmation', async (testContext) => {
  const setup = await fixture(testContext);
  const [id] = await setup.engine.add({ url: `${setup.url}/file.bin`, reviewOnly: true });
  const download = setup.engine.downloads[0];
  await delay(80);
  assert.equal(download.status, 'paused');
  assert.equal(download.downloaded, 0);
  assert.equal(download.needsReview, true);
  await assert.rejects(setup.engine.action(id, 'resume'), /Confirm/);

  await setup.engine.reviewDownload({
    id,
    filename: 'confirmed.bin',
    directory: path.join(setup.root, 'chosen'),
    category: 'Other',
    description: 'Reviewed by user',
  });

  await until(() => ['complete', 'error'].includes(download.status));
  assert.equal(download.status, 'complete', download.error);
  assert.equal(download.needsReview, false);
  assert.equal(download.description, 'Reviewed by user');
  assert.equal(path.dirname(download.path), path.join(setup.root, 'chosen'));
  assert.equal(digest(await fs.readFile(download.path)), digest(setup.data));
});

test('global rate cap bounds combined segment throughput', async (testContext) => {
  const setup = await fixture(testContext);
  await setup.engine.updateSettings({ speedLimitKbps: 1024 });
  const start = Date.now();
  await setup.engine.add({ url: `${setup.url}/file.bin` });
  const download = setup.engine.downloads[0];
  await until(() => ['complete', 'error'].includes(download.status), 12000);
  assert.equal(download.status, 'complete', download.error);

  assert.ok(
    Date.now() - start >= 2400,
    'aggregate bandwidth should be limited, not each connection separately',
  );
});

test('request credentials are excluded from history and UI snapshots', async (testContext) => {
  const setup = await fixture(testContext);

  await setup.engine.add({
    url: `${setup.url}/file.bin`,
    reviewOnly: true,
    headers: { cookie: 'session=private-fixture', authorization: 'Bearer private-fixture' },
  });

  assert.doesNotMatch(JSON.stringify(setup.engine.snapshot()), /private-fixture/);

  assert.doesNotMatch(
    await fs.readFile(path.join(setup.root, 'state', 'downloads.json'), 'utf8'),
    /private-fixture/,
  );
});
