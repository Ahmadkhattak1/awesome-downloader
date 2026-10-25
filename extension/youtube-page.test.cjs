const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
const path = require('node:path');

const youtubeMedia = require('./youtube-media.js');

const sabrUrl = 'https://r1.googlevideo.com/videoplayback?id=wLdZWyLOJCI-asset&sabr=1&rn=3';

const settle = () =>
  new Promise((resolve) => {
    setTimeout(resolve, 0);
  });

// Runs youtube-page.js against a stand-in page whose own fetch/XHR answer with `status`.
function page({ status = 200 } = {}) {
  const posted = [];
  const sent = [];

  class FakeXMLHttpRequest {
    constructor() {
      this.listeners = {};
      this.status = status;
    }

    addEventListener(name, fn) {
      this.listeners[name] = fn;
    }

    open(method, url) {
      this.url = url;
    }

    send(body) {
      sent.push(body);
      setTimeout(() => this.listeners.load?.(), 0);
    }
  }

  const window = {
    // The page's own fetch must still receive a readable request body.
    async fetch(input, init) {
      sent.push(init?.body ?? (input instanceof Request ? await input.text() : undefined));
      return { ok: status >= 200 && status < 300 };
    },
    postMessage(message) {
      posted.push(message);
    },
  };

  vm.runInNewContext(fs.readFileSync(path.join(__dirname, 'youtube-page.js'), 'utf8'), {
    window,
    XMLHttpRequest: FakeXMLHttpRequest,
    location: {
      origin: 'https://www.youtube.com',
      href: 'https://www.youtube.com/watch?v=wLdZWyLOJCI',
    },
    document: { getElementById: () => null },
    addEventListener() {},
    URL,
    Request,
    Blob,
    btoa,
    setTimeout,
    youtubeMedia,
  });

  return { window, XMLHttpRequest: FakeXMLHttpRequest, posted, sent };
}

// Plain copies: objects made inside the vm context have that context's prototypes.
const copies = (sandbox) =>
  JSON.parse(
    JSON.stringify(
      sandbox.posted
        .filter((message) => message.type === 'awesome-sabr-request')
        .map((message) => message.data),
    ),
  );

test('a successful SABR fetch body is copied for the extension', async () => {
  const sandbox = page();
  await sandbox.window.fetch(sabrUrl, { method: 'POST', body: Uint8Array.from([1, 2, 3]) });
  await settle();
  assert.deepEqual(copies(sandbox), [{ url: sabrUrl, body: 'AQID' }]);
});

test('a SABR Request object is copied without consuming the page’s own body', async () => {
  const sandbox = page();

  await sandbox.window.fetch(
    new Request(sabrUrl, { method: 'POST', body: Uint8Array.from([104, 105]) }),
  );

  await settle();
  assert.equal(sandbox.sent[0], 'hi');
  assert.deepEqual(copies(sandbox), [{ url: sabrUrl, body: 'aGk=' }]);
});

test('a SABR XMLHttpRequest body is copied after it loads', async () => {
  const sandbox = page();
  const xhr = new sandbox.XMLHttpRequest();
  xhr.open('POST', sabrUrl);
  xhr.send(Uint8Array.from([1, 2, 3]));
  await settle();
  await settle();
  assert.deepEqual(copies(sandbox), [{ url: sabrUrl, body: 'AQID' }]);
});

test('failed and non-streaming requests are not copied', async () => {
  const failed = page({ status: 403 });
  await failed.window.fetch(sabrUrl, { method: 'POST', body: Uint8Array.from([1]) });
  const other = page();

  await other.window.fetch('https://www.youtube.com/api/stats', {
    method: 'POST',
    body: Uint8Array.from([1]),
  });

  await other.window.fetch('https://r1.googlevideo.com/videoplayback?id=x&itag=140', {
    method: 'POST',
    body: Uint8Array.from([1]),
  });

  await settle();
  assert.deepEqual(copies(failed), []);
  assert.deepEqual(copies(other), []);
});
