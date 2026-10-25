import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomBytes, createHash } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { DownloadEngine, isTransientNetworkError } from '../core/engine.mjs';

const digest = buffer => createHash('sha256').update(buffer).digest('hex');
const until = async (predicate, timeout = 5000) => {
  const started = Date.now();
  while (!predicate()) {
    if (Date.now() - started > timeout) throw new Error('Timed out waiting for condition.');
    await delay(15);
  }
};

async function fixture(t, handler) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'awesome-retry-test-'));
  const server = http.createServer(handler);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const engine = await new DownloadEngine({
    dataDirectory: path.join(root, 'state'),
    downloadDirectory: path.join(root, 'downloads'),
    tickMs: 25
  }).init();
  t.after(async () => {
    await engine.close();
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    await fs.rm(root, { recursive: true, force: true });
  });
  return { engine, root, url: `http://127.0.0.1:${server.address().port}` };
}

test('isTransientNetworkError accurately classifies transient vs permanent errors', () => {
  // Transient network & server errors
  assert.equal(isTransientNetworkError(new Error('Server returned HTTP 500.')), true);
  assert.equal(isTransientNetworkError(new Error('Server returned HTTP 502.')), true);
  assert.equal(isTransientNetworkError(new Error('Server returned HTTP 503.')), true);
  assert.equal(isTransientNetworkError(new Error('Server returned HTTP 504.')), true);
  assert.equal(isTransientNetworkError(new Error('Server returned HTTP 429.')), true);
  assert.equal(isTransientNetworkError(new Error('fetch failed')), true);
  assert.equal(isTransientNetworkError(new Error('socket hang up')), true);
  assert.equal(isTransientNetworkError(new Error('read ECONNRESET')), true);
  assert.equal(isTransientNetworkError(new Error('connect ETIMEDOUT')), true);
  assert.equal(isTransientNetworkError(new Error('getaddrinfo ENOTFOUND example.com')), true);
  assert.equal(isTransientNetworkError(new Error('Connection ended before the segment finished.')), true);
  assert.equal(isTransientNetworkError({ code: 'ECONNRESET', message: 'connection dropped' }), true);
  assert.equal(isTransientNetworkError({ cause: { code: 'ETIMEDOUT' }, message: 'request failed' }), true);

  // Permanent client errors & invalid inputs
  assert.equal(isTransientNetworkError(new Error('Server returned HTTP 404.')), false);
  assert.equal(isTransientNetworkError(new Error('Server returned HTTP 403.')), false);
  assert.equal(isTransientNetworkError(new Error('Server returned HTTP 400.')), false);
  assert.equal(isTransientNetworkError(new Error('Server returned HTTP 200 instead of a byte range.')), false);
  assert.equal(isTransientNetworkError(new Error('Server returned an inconsistent byte range.')), false);
  assert.equal(isTransientNetworkError(new Error('Server ignored identity encoding; refusing to save corrupt ranges.')), false);
  assert.equal(isTransientNetworkError(new Error('Invalid YouTube format.')), false);
  assert.equal(isTransientNetworkError(null), false);
});

test('settings validate maxRetries range and defaults', async t => {
  const f = await fixture(t, (req, res) => res.end('ok'));
  assert.equal(f.engine.settings.maxRetries, 3);

  await f.engine.updateSettings({ maxRetries: 0 });
  assert.equal(f.engine.settings.maxRetries, 0);

  await f.engine.updateSettings({ maxRetries: 5 });
  assert.equal(f.engine.settings.maxRetries, 5);

  await f.engine.updateSettings({ maxRetries: 10 });
  assert.equal(f.engine.settings.maxRetries, 10);

  assert.throws(() => f.engine.updateSettings({ maxRetries: -1 }), /Invalid maxRetries/);
  assert.throws(() => f.engine.updateSettings({ maxRetries: 11 }), /Invalid maxRetries/);
  assert.throws(() => f.engine.updateSettings({ maxRetries: 'invalid' }), /Invalid maxRetries/);
  assert.throws(() => f.engine.updateSettings({ maxRetries: 1.5 }), /Invalid maxRetries/);
});

test('transient network failure triggers auto-retry backoff and succeeds on subsequent attempt', async t => {
  const content = randomBytes(1024 * 64);
  let attempts = 0;
  const f = await fixture(t, (req, res) => {
    attempts++;
    if (attempts === 1) {
      // First attempt fails with transient 503 error
      res.writeHead(503, { 'content-type': 'text/plain' });
      return res.end('Service Unavailable');
    }
    // Subsequent attempt succeeds
    res.setHeader('etag', '"test-retry-1"');
    res.setHeader('content-length', content.length);
    res.end(content);
  });

  const [id] = await f.engine.add({ url: `${f.url}/test.bin` });
  const d = f.engine.downloads[0];

  // Wait until attempt 1 fails and it transitions to 'scheduled' retry state
  await until(() => d.status === 'scheduled');
  assert.equal(d.retries, 1);
  assert.match(d.error, /Network error.*Retrying in 2s \(1\/3\)/);
  assert.ok(d.scheduledAt);
  assert.ok(new Date(d.scheduledAt).getTime() > Date.now());

  // Advance scheduledAt so the next tick immediately picks it up
  d.scheduledAt = new Date(Date.now() - 1000).toISOString();
  f.engine.tick();

  // Wait until it completes successfully
  await until(() => d.status === 'complete');
  assert.equal(d.retries, 0);
  assert.equal(attempts, 3); // 1 initial failed probe + 1 retry probe + 1 transfer
  assert.equal(digest(await fs.readFile(d.path)), digest(content));
});

test('exceeding maxRetries marks download as error with total retry summary', async t => {
  let attempts = 0;
  const f = await fixture(t, (req, res) => {
    attempts++;
    res.writeHead(500, { 'content-type': 'text/plain' });
    res.end('Internal Server Error');
  });

  await f.engine.updateSettings({ maxRetries: 2 });
  const [id] = await f.engine.add({ url: `${f.url}/persistent-fail.bin` });
  const d = f.engine.downloads[0];

  // Retry 1
  await until(() => d.status === 'scheduled' && d.retries === 1);
  assert.match(d.error, /\(1\/2\)/);
  d.scheduledAt = new Date(Date.now() - 1000).toISOString();
  f.engine.tick();

  // Retry 2
  await until(() => d.status === 'scheduled' && d.retries === 2);
  assert.match(d.error, /\(2\/2\)/);
  d.scheduledAt = new Date(Date.now() - 1000).toISOString();
  f.engine.tick();

  // Attempt 3 fails after exhausting 2 retries
  await until(() => d.status === 'error');
  assert.equal(d.retries, 0);
  assert.match(d.error, /Failed after 2 retry attempt\(s\): Server returned HTTP 500\./);
  assert.equal(attempts, 3);
});

test('permanent 404 error fails immediately without retrying', async t => {
  let attempts = 0;
  const f = await fixture(t, (req, res) => {
    attempts++;
    res.writeHead(404, { 'content-type': 'text/plain' });
    res.end('Not Found');
  });

  await f.engine.add({ url: `${f.url}/missing.bin` });
  const d = f.engine.downloads[0];

  await until(() => d.status === 'error');
  assert.equal(attempts, 1);
  assert.equal(d.retries, 0);
  assert.match(d.error, /HTTP 404/);
});

test('user pause during retry backoff cancels schedule and resets retries', async t => {
  const f = await fixture(t, (req, res) => {
    res.writeHead(503);
    res.end('Unavailable');
  });

  const [id] = await f.engine.add({ url: `${f.url}/cancel-retry.bin` });
  const d = f.engine.downloads[0];

  await until(() => d.status === 'scheduled');
  assert.equal(d.retries, 1);

  await f.engine.action(id, 'pause');
  assert.equal(d.status, 'paused');
  assert.equal(d.scheduledAt, null);
  assert.equal(d.retries, 0);
});
