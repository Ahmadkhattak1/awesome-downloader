const path = require('node:path');

const SAFE_EXTENSION = /^\.[a-z0-9]{1,12}$/i;

function extensionKey(download = {}) {
  const source = download.filename || download.path || '';
  const extension = path.extname(String(source)).toLowerCase();
  return SAFE_EXTENSION.test(extension) ? extension : '';
}

function createFileIconProvider({ getFileIcon, cacheDirectory, fileSystem = require('node:fs/promises') }) {
  if (typeof getFileIcon !== 'function') throw new TypeError('getFileIcon must be a function.');
  if (!cacheDirectory) throw new TypeError('cacheDirectory is required.');

  const icons = new Map();
  const pending = new Map();

  async function loadExtension(extension) {
    if (!extension || icons.has(extension)) return false;
    if (pending.has(extension)) return pending.get(extension);

    const task = (async () => {
      let dataUrl = '';
      try {
        await fileSystem.mkdir(cacheDirectory, { recursive: true });
        // Windows resolves the user's default application icon from a file's
        // extension. The empty probe is never opened or executed.
        const probePath = path.join(cacheDirectory, `associated-file${extension}`);
        await fileSystem.writeFile(probePath, '', { flag: 'a' });
        const image = await getFileIcon(probePath, { size: 'small' });
        dataUrl = image?.isEmpty?.() === true ? '' : image?.toDataURL?.() || '';
      } catch {
        // The renderer keeps its neutral file fallback if Windows cannot
        // resolve an association for this extension.
      }
      icons.set(extension, dataUrl);
      pending.delete(extension);
      return true;
    })();

    pending.set(extension, task);
    return task;
  }

  async function load(downloads = []) {
    const extensions = [...new Set(downloads.map(extensionKey).filter(Boolean))];
    const results = await Promise.all(extensions.map(loadExtension));
    return results.some(Boolean);
  }

  return {
    load,
    snapshot: () => Object.fromEntries(icons)
  };
}

module.exports = { extensionKey, createFileIconProvider };
