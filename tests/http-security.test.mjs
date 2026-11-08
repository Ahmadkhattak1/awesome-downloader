import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { request, validUrl, cleanHeaders } from '../core/http.mjs';

test('untrusted URLs cannot select local files, scripts, or embedded credentials', () => {
  assert.equal(validUrl('https://example.com/file'), 'https://example.com/file');
  assert.equal(validUrl('http://example.com/file'), 'http://example.com/file');
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
  // Exercise every permitted field: a single Referer case would still pass
  // if a future change accidentally accepted injected cookies or authorization.
  for (const name of ['referer', 'cookie', 'authorization', 'origin', 'user-agent', 'accept']) {
    for (const injected of ['safe\rInjected: yes', 'safe\nInjected: yes']) {
      const filtered = cleanHeaders({ [name]: injected });
      if (name === 'user-agent') assert.equal(filtered[name], 'AwesomeDownloader/0.1');
      else assert.equal(filtered[name], undefined, `${name} must reject CR and LF`);
    }
  }
});

test('redirect loops stop within the bounded request budget', { timeout: 7000 }, async t => {
  let count = 0;
  const server = http.createServer((req, res) => {
    count++;
    res.writeHead(302, { location: '/loop' });
    res.end();
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => { server.closeAllConnections(); server.close(resolve); }));
  await assert.rejects(request(`http://127.0.0.1:${server.address().port}/loop`, {
    signal: AbortSignal.timeout(5000)
  }), /Too many redirects/);
  assert.equal(count, 11);
});
