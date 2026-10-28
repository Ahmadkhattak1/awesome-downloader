import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const { clipboardLinks, classify } = createRequire(import.meta.url)('../desktop/clipboard-links.cjs');

test('file links, video pages and download-style links are offered', () => {
  assert.deepEqual(clipboardLinks('https://cdn.example.com/files/game-setup.exe?token=1'), { links: ['https://cdn.example.com/files/game-setup.exe?token=1'], extract: false });
  assert.equal(clipboardLinks('https://example.com/a/b/movie.MKV').extract, false);
  assert.equal(clipboardLinks('https://www.youtube.com/watch?v=dQw4w9WgXcQ').extract, true);
  assert.equal(clipboardLinks('https://youtu.be/dQw4w9WgXcQ').extract, true);
  assert.equal(clipboardLinks('https://x.com/user/status/1234567890').extract, true);
  assert.equal(clipboardLinks('https://vimeo.com/123456789').extract, true);
  assert.ok(clipboardLinks('https://example.com/download.php?id=77')); assert.ok(clipboardLinks('https://example.com/get?file=abc'));
});
test('several links (one per line) become one batch', () => {
  const r = clipboardLinks('https://a.example/x.zip\r\nhttps://b.example/y.pdf\n\nhttps://c.example/z.mp3');
  assert.equal(r.links.length, 3); assert.equal(r.extract, false);
});
test('ordinary text, pages, credentials and unsafe schemes never interrupt the user', () => {
  for (const text of ['', '   ', 'hello world', 'see https://example.com/a.zip please', 'https://example.com/', 'https://example.com/about', 'ftp://example.com/a.zip', 'file:///C:/a.zip', 'javascript:alert(1)', 'https://user:pw@example.com/a.zip', 'localhost/a.zip', 'https://example.com/a.zip not-a-link']) assert.equal(clipboardLinks(text), null, text);
  assert.equal(clipboardLinks(Array.from({ length: 30 }, (_, i) => `https://e.example/${i}.zip`).join('\n')), null);
  assert.equal(classify('https://example.com/' + 'a'.repeat(3000) + '.zip'), null);
});
