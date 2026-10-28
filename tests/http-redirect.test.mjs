import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { request } from '../core/http.mjs';

function listen(server) {
  return new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve(server.address().port)));
}

function close(server) {
  return new Promise(resolve => server.close(resolve));
}

test('cross-origin redirects do not forward Referer or credentials', async t => {
  let received;
  const target = http.createServer((req, res) => {
    received = req.headers;
    res.writeHead(200, { 'content-length': '2' });
    res.end('ok');
  });
  const targetPort = await listen(target);
  t.after(() => close(target));

  const source = http.createServer((req, res) => {
    res.writeHead(302, { location: `http://127.0.0.1:${targetPort}/destination` });
    res.end();
  });
  const sourcePort = await listen(source);
  t.after(() => close(source));

  const response = await request(`http://127.0.0.1:${sourcePort}/start`, {
    headers: {
      referer: 'https://private.example/account?session=do-not-forward',
      cookie: 'session=do-not-forward',
      authorization: 'Bearer do-not-forward',
      origin: 'https://private.example',
      'user-agent': 'AwesomeDownloader/test'
    }
  });
  response.resume();

  assert.equal(response.statusCode, 200);
  assert.ok(received, 'redirect target should receive the request');
  assert.equal(received.referer, undefined);
  assert.equal(received.cookie, undefined);
  assert.equal(received.authorization, undefined);
  assert.equal(received.origin, undefined);
  assert.equal(received['user-agent'], 'AwesomeDownloader/test');
});
