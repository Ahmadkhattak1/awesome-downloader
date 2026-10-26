const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
const path = require('node:path');

function harness(file, mode) {
  const events = new Map();
  const observers = [];
  const hosts = [];
  const callbacks = new Set();
  let calls = 0;
  let id = 'test-extension';
  let removed = 0;

  const runtime = {
    get id() {
      return id;
    },
    sendMessage() {
      calls += 1;

      if (mode === 'throw') {
        throw new Error('Extension context invalidated.');
      }

      if (mode === 'reject') {
        return Promise.reject(new Error('Extension context invalidated.'));
      }

      return Promise.resolve({ ok: true });
    },
    onMessage: {
      addListener(fn) {
        callbacks.add(fn);
      },
      removeListener(fn) {
        callbacks.delete(fn);
      },
    },
  };

  const addEventListener = (name, fn, options = {}) => {
    events.set(name, fn);
    options.signal?.addEventListener('abort', () => events.delete(name));
  };

  class Observer {
    constructor(fn) {
      this.fn = fn;
      this.targets = new Set();
      observers.push(this);
    }

    observe(target) {
      this.targets.add(target);
    }

    unobserve(target) {
      this.targets.delete(target);
    }

    disconnect() {
      this.disconnected = true;
    }
  }

  const video = {
    currentSrc: 'https://example.test/video.mp4',
    src: '',
    querySelectorAll() {
      return [];
    },
    addEventListener,
    isConnected: true,
    getBoundingClientRect() {
      return { top: 50, bottom: 400, left: 0, right: 600, width: 600, height: 350 };
    },
  };

  const document = {
    title: 'Video',
    documentElement: {
      appendChild(host) {
        Object.assign(host, { parentNode: this });
      },
    },
    querySelectorAll(selector) {
      return selector === 'video' ? [video] : [];
    },
    addEventListener,
    createElement() {
      const host = {
        style: {},
        remove() {
          removed += 1;
        },
        attachShadow() {
          return {
            querySelector(selector) {
              return selector === '.chooser' ? host.chooser || null : { addEventListener() {} };
            },
          };
        },
      };

      hosts.push(host);
      return host;
    },
  };

  const context = {
    chrome: { runtime },
    document,
    location: {
      href: 'https://www.youtube.com/watch?v=wLdZWyLOJCI',
      origin: 'https://www.youtube.com',
    },
    window: {},
    URL,
    AbortController,
    ResizeObserver: Observer,
    MutationObserver: Observer,
    addEventListener,
    removeEventListener(name) {
      events.delete(name);
    },
    requestAnimationFrame() {
      return 1;
    },
    cancelAnimationFrame() {},
    setTimeout,
    clearTimeout,
    dispatchEvent() {},
    Event,
    innerHeight: 800,
    innerWidth: 1200,
  };

  vm.runInNewContext(fs.readFileSync(path.join(__dirname, file), 'utf8'), context);
  return {
    context,
    events,
    observers,
    callbacks,
    hosts,
    video,
    get calls() {
      return calls;
    },
    get removed() {
      return removed;
    },
    invalidate() {
      id = undefined;
    },
  };
}

for (const mode of ['throw', 'reject']) {
  test(`content script cleans up after ${mode} from invalidated messaging`, async () => {
    const sandbox = harness('content.js', mode);

    await new Promise((resolve) => {
      setImmediate(resolve);
    });

    assert.equal(sandbox.calls, 1);
    assert.equal(sandbox.removed, 1);
    assert.ok(sandbox.observers.every((observer) => observer.disconnected));
    assert.equal(sandbox.callbacks.size, 0);
    assert.equal(sandbox.events.size, 0);
    sandbox.observers.forEach((observer) => observer.fn());
    assert.equal(sandbox.calls, 1);
  });

  test(`YouTube relay retires after ${mode} from invalidated messaging`, async () => {
    const sandbox = harness('youtube-relay.js', mode);
    const callback = [...sandbox.callbacks][0];
    let reply;

    callback({ action: 'refreshPlayer' }, { id: 'test-extension' }, (value) => {
      reply = value;
    });

    await sandbox.events.get('message')({
      source: sandbox.context.window,
      origin: sandbox.context.location.origin,
      data: { type: 'awesome-player-response', data: { videoId: 'wLdZWyLOJCI', formats: [] } },
    });

    assert.equal(sandbox.calls, 1);
    assert.equal(sandbox.callbacks.size, 0);
    assert.equal(sandbox.events.size, 0);
    assert.equal(reply.ok, false);
  });
}

test('missing runtime ID retires page scripts without sending again', () => {
  const sandbox = harness('content.js', 'success');
  sandbox.invalidate();
  sandbox.events.get('scroll')();
  assert.equal(sandbox.calls, 1);
  assert.equal(sandbox.removed, 1);
  assert.equal(sandbox.callbacks.size, 0);
});

test('page scrolling dismisses chooser and does not pin an offscreen video button', async () => {
  const sandbox = harness('content.js', 'success');
  const host = sandbox.hosts[0];

  host.chooser = {
    remove() {
      delete host.chooser;
    },
  };

  sandbox.events.get('scroll')({ composedPath: () => [] });
  assert.equal(host.chooser, undefined);
  assert.equal(host.style.display, 'none');

  sandbox.video.getBoundingClientRect = () => ({
    top: -30,
    bottom: 300,
    left: 0,
    right: 600,
    width: 600,
    height: 330,
  });

  await new Promise((resolve) => {
    setTimeout(resolve, 180);
  });

  assert.equal(host.style.display, 'none');
  sandbox.invalidate();
  sandbox.events.get('resize')();
});
