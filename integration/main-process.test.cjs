const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const Module = require('node:module');
const os = require('node:os');
const path = require('node:path');

// electron-builder copies integration/ to Resources/browser/integration, not into app.asar,
// so the packaged main process cannot load it. Only the --native-host mode may.
test('the main process loads nothing from integration/ at startup', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ad-main-process-'));

  const electron = {
    app: {
      setName() {},
      getPath: () => home,
      setPath() {},
      // A second instance quits straight away, so no window or engine is created.
      requestSingleInstanceLock: () => false,
      quit() {},
    },
  };

  const loaded = [];
  // eslint-disable-next-line no-underscore-dangle -- Node's module loader hook.
  const originalLoad = Module._load;

  // eslint-disable-next-line no-underscore-dangle -- Node's module loader hook.
  Module._load = function recordLoad(request, parent, isMain) {
    if (request === 'electron') {
      return electron;
    }

    // eslint-disable-next-line no-underscore-dangle -- Node's module resolver.
    loaded.push(Module._resolveFilename(request, parent, isMain));
    return originalLoad.call(this, request, parent, isMain);
  };

  try {
    // eslint-disable-next-line global-require -- must load after the loader hook is installed.
    require('../desktop/main.cjs');
  } finally {
    // eslint-disable-next-line no-underscore-dangle -- restores Node's module loader hook.
    Module._load = originalLoad;
  }

  assert.deepEqual(
    loaded.filter((file) => file.startsWith(`${__dirname}${path.sep}`)),
    [],
  );
});
