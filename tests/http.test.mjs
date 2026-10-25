import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { validUrl, cleanHeaders, request, probe } from '../core/http.mjs';

async function fixture(t, handler) {
  const server = http.createServer(handler);
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  t.after(() => new Promise(r => { server.closeAllConnections(); server.close(r); }));
  return `http://127.0.0.1:${server.address().port}`;
}

async function body(response) {
  const chunks = [];
  for await (const chunk of response) chunks.push(chunk);
  return Buffer.concat(chunks).toString('utf8');
}

test('validUrl accepts http(s) and rejects other schemes, credentials and oversized input', () => {
  assert.equal(validUrl('https://example.com/file.zip?x=1'), 'https://example.com/file.zip?x=1');
  assert.throws(() => validUrl('ftp://example.com/file.zip'), /Only HTTP and HTTPS/);
  assert.throws(() => validUrl('https://user:pass@example.com/file.zip'), /credentials in URLs/);
  assert.throws(() => validUrl('https://example.com/' + 'a'.repeat(16400)), /Invalid download URL/);
  assert.throws(() => validUrl(42), /Invalid download URL/);
});

test('cleanHeaders applies the allowlist and drops unsafe values', () => {
  const headers = cleanHeaders({
    Referer: 'https://example.com/page',
    Authorization: 'Bearer token',
    'X-Custom': 'nope',
    Cookie: 'a=1\r\nInjected: yes',
    Origin: 'https://example.com',
    Accept: 'x'.repeat(40000),
  });
  assert.equal(headers['user-agent'], 'AwesomeDownloader/0.1');
  assert.equal(headers['accept-encoding'], 'identity');
  assert.equal(headers.referer, 'https://example.com/page');
  assert.equal(headers.authorization, 'Bearer token');
  assert.equal(headers.origin, 'https://example.com');
  assert.equal(headers['x-custom'], undefined);
  assert.equal(headers.cookie, undefined, 'CRLF values must be dropped');
  assert.equal(headers.accept, undefined, 'oversized values must be dropped');
});

test('request follows a same-origin redirect and keeps auth headers', async t => {
  const base = await fixture(t, (req, res) => {
    if (req.url === '/start') { res.writeHead(302, { location: '/final' }); return res.end(); }
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify(req.headers));
  });
  const response = await request(base + '/start', { headers: { authorization: 'Bearer token', cookie: 'a=1' } });
  const seen = JSON.parse(await body(response));
  assert.equal(response.statusCode, 200);
  assert.equal(response.finalUrl, base + '/final');
  assert.equal(seen.authorization, 'Bearer token');
  assert.equal(seen.cookie, 'a=1');
});

test('request strips authorization, cookie and origin on a cross-origin redirect', async t => {
  const target = await fixture(t, (req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify(req.headers));
  });
  const source = await fixture(t, (req, res) => {
    res.writeHead(302, { location: target + '/landing' });
    res.end();
  });
  const response = await request(source + '/start', {
    headers: { authorization: 'Bearer token', cookie: 'a=1', origin: 'https://example.com', 'user-agent': 'TestAgent/1' },
  });
  const seen = JSON.parse(await body(response));
  assert.equal(seen.authorization, undefined);
  assert.equal(seen.cookie, undefined);
  assert.equal(seen.origin, undefined);
  assert.equal(seen['user-agent'], 'TestAgent/1', 'non-sensitive headers still forward');
});

test('request gives up after too many redirects', async t => {
  const base = await fixture(t, (req, res) => { res.writeHead(302, { location: '/loop' }); res.end(); });
  await assert.rejects(request(base + '/loop'), /Too many redirects/);
});

test('probe reads size, range support and a strong validator from HEAD', async t => {
  const base = await fixture(t, (req, res) => {
    res.writeHead(200, { 'content-length': '4096', 'accept-ranges': 'bytes', etag: '"abc123"', 'last-modified': 'Wed, 01 Jan 2025 00:00:00 GMT' });
    res.end();
  });
  const info = await probe(base + '/file.bin', {});
  assert.equal(info.total, 4096);
  assert.equal(info.ranges, true);
  assert.equal(info.validator, '"abc123"');
});

test('probe falls back to a range request when HEAD is refused and parses content-range', async t => {
  const base = await fixture(t, (req, res) => {
    if (req.method === 'HEAD') { res.writeHead(405); return res.end(); }
    res.writeHead(206, { 'content-range': 'bytes 0-0/5000', 'content-length': '1' });
    res.end('x');
  });
  const info = await probe(base + '/file.bin', {});
  assert.equal(info.status, 206);
  assert.equal(info.total, 5000);
  assert.equal(info.ranges, true);
});

test('probe ignores weak etags and rejects error statuses', async t => {
  const base = await fixture(t, (req, res) => {
    if (req.url === '/weak') {
      res.writeHead(200, { 'content-length': '10', etag: 'W/"abc"', 'last-modified': 'Wed, 01 Jan 2025 00:00:00 GMT' });
      return res.end();
    }
    res.writeHead(404);
    res.end();
  });
  const info = await probe(base + '/weak', {});
  assert.equal(info.validator, 'Wed, 01 Jan 2025 00:00:00 GMT');
  await assert.rejects(probe(base + '/missing', {}), /Server returned HTTP 404/);
});
