import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { extensionKey, createFileIconProvider } = require('../desktop/file-icons.cjs');

test('file icon keys are safe, lowercase extensions', () => {
  assert.equal(extensionKey({ filename: 'Movie.MP4' }), '.mp4');
  assert.equal(extensionKey({ path: 'C:\\Downloads\\picture.JPEG' }), '.jpeg');
  assert.equal(extensionKey({ filename: 'no-extension' }), '');
  assert.equal(extensionKey({ filename: 'unsafe.very-long-extension' }), '');
});

test('associated file icons are loaded once per extension', async () => {
  const calls = [], writes = [];
  const provider = createFileIconProvider({
    cacheDirectory: 'C:\\IconCache',
    fileSystem: {
      mkdir: async () => {},
      writeFile: async filePath => writes.push(filePath)
    },
    getFileIcon: async filePath => {
      calls.push(filePath);
      return { isEmpty: () => false, toDataURL: () => `data:image/png;base64,${calls.length}` };
    }
  });

  await provider.load([{ filename: 'one.mp4' }, { filename: 'two.MP4' }, { filename: 'sound.mp3' }]);
  await provider.load([{ filename: 'three.mp4' }]);

  assert.equal(calls.length, 2);
  assert.equal(writes.length, 2);
  assert.deepEqual(Object.keys(provider.snapshot()).sort(), ['.mp3', '.mp4']);
  assert.match(provider.snapshot()['.mp4'], /^data:image\/png/);
});
