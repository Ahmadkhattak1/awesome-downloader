import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { request, validUrl, cleanHeaders } from '../core/http.mjs';

test('untrusted URLs cannot select local files, scripts, or embedded credentials', () => {
  for (const url of ['file:///C:/Windows/win.ini', 'javascript:alert(1)', 'ftp://example.com/file', 'https://user:secret@example.com/file']) {
    assert.throws(() => validUrl(url));
  }
});

test('request header filtering rejects injection and caller-controlled transport headers', () => {
  const headers = cleanHeaders({ Cookie: 'session=fixture', Authorization: 'Bearer fixture', Host: 'evil.test', Range: 'bytes=1-2', Connection: 'upgrade', Referer: 'https://example.com/\r\nInjected: yes' });
  assert.equal(headers.cookie, 'session=fixture');
  assert.equal(headers.authorization, 'Bearer fixture');
  for (const key of ['host', 'range', 'connection', 'referer']) assert.equal(headers[key], undefined);
  assert.equal(headers['accept-encoding'], 'identity');
});

test('redirect loops stop within the bounded request budget', async t => {
  let count = 0;
  const server = http.createServer((req, res) => {
    count++;
    res.writeHead(302, { location: '/loop' });
    res.end();
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => { server.closeAllConnections(); server.close(resolve); }));
  await assert.rejects(request(`http://127.0.0.1:${server.address().port}/loop`), /Too many redirects/);
  assert.equal(count, 11);
});
