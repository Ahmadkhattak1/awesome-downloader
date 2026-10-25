const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');

const exec = promisify(execFile);

const HOST = 'com.awesome.downloader';
// Per-user browser folders under ~/Library/Application Support on macOS.
const MAC_BROWSER_FOLDERS = { Chrome: 'Google/Chrome', Edge: 'Microsoft Edge', Firefox: 'Mozilla' };

function nativeHostPath(integrationRoot, platform = process.platform) {
  return path.join(
    integrationRoot,
    'integration',
    platform === 'win32' ? 'native-host.exe' : 'native-host.sh',
  );
}

function macManifestPath(browser, home) {
  return path.join(
    home,
    'Library',
    'Application Support',
    MAC_BROWSER_FOLDERS[browser],
    'NativeMessagingHosts',
    `${HOST}.json`,
  );
}

async function registerBrowser(
  { browser, extensionId },
  { dataDirectory, integrationRoot, platform = process.platform, home = os.homedir() },
) {
  if (!['Chrome', 'Edge', 'Firefox'].includes(browser)) {
    throw new Error('Choose Chrome, Edge, or Firefox.');
  }

  if (
    typeof extensionId !== 'string' ||
    !(browser === 'Firefox' ? /^[A-Za-z0-9@._{}-]{1,128}$/ : /^[a-p]{32}$/).test(extensionId)
  ) {
    throw new Error('Copy the extension ID from your browser’s extensions page.');
  }

  if (!['win32', 'darwin'].includes(platform)) {
    throw new Error('Browser integration is available on Windows and macOS.');
  }

  const folder = path.join(dataDirectory, 'NativeMessaging');

  // Windows finds the manifest through the registry; macOS browsers read a fixed folder.
  const manifestPath =
    platform === 'win32' ? path.join(folder, `${browser}.json`) : macManifestPath(browser, home);

  const manifest = {
    name: HOST,
    description: 'Awesome Downloader browser bridge',
    path: nativeHostPath(integrationRoot, platform),
    type: 'stdio',
  };

  if (browser === 'Firefox') {
    manifest.allowed_extensions = [extensionId];
  } else {
    manifest.allowed_origins = [`chrome-extension://${extensionId}/`];
  }

  const content = JSON.stringify(manifest, null, 2);
  await fs.access(manifest.path);
  await fs.mkdir(folder, { recursive: true });
  await fs.mkdir(path.dirname(manifestPath), { recursive: true });
  let previous;

  try {
    previous = await fs.readFile(manifestPath, 'utf8');
  } catch (error) {
    if (error.code !== 'ENOENT') {
      throw error;
    }
  }

  const stamp = new Date().toISOString().replaceAll(/[:.]/g, '-');

  if (previous && previous !== content) {
    await fs.writeFile(path.join(folder, `${browser}.json.${stamp}.bak`), previous);
  }

  if (platform === 'win32') {
    const key = `HKCU\\Software\\${{ Chrome: 'Google\\Chrome', Edge: 'Microsoft\\Edge', Firefox: 'Mozilla' }[browser]}\\NativeMessagingHosts\\${HOST}`;
    let registry = null;

    try {
      registry = (await exec('reg.exe', ['QUERY', key, '/ve'], { windowsHide: true })).stdout;
    } catch (error) {
      if (error.code !== 1) {
        throw error;
      }
    }

    const previousPath = registry?.match(/REG_SZ\s+(.+)\r?\n?/)?.[1]?.trim();

    if (registry && previousPath !== manifestPath) {
      await fs.writeFile(path.join(folder, `${browser}.${stamp}.registry-backup.txt`), registry);
    }

    if (previous !== content) {
      await fs.writeFile(manifestPath, content, 'utf8');
    }

    if (previousPath !== manifestPath) {
      await exec('reg.exe', ['ADD', key, '/ve', '/t', 'REG_SZ', '/d', manifestPath, '/f'], {
        windowsHide: true,
      });
    }
  } else if (previous !== content) {
    await fs.writeFile(manifestPath, content, 'utf8');
  }

  let extensionPath = path.join(integrationRoot, 'extension');

  if (browser === 'Firefox') {
    extensionPath = path.join(folder, 'firefox-extension');
    await fs.cp(path.join(integrationRoot, 'extension'), extensionPath, { recursive: true });

    await fs.copyFile(
      path.join(extensionPath, 'manifest.firefox.json'),
      path.join(extensionPath, 'manifest.json'),
    );
  }

  return { ok: true, manifestPath, extensionPath };
}

function browserProfileRoots(platform, { localAppData, home }) {
  if (platform === 'win32') {
    return [
      ['Chrome', path.join(localAppData, 'Google/Chrome/User Data')],
      ['Edge', path.join(localAppData, 'Microsoft/Edge/User Data')],
    ];
  }

  if (platform === 'darwin') {
    return ['Chrome', 'Edge'].map((browser) => [
      browser,
      path.join(home, 'Library', 'Application Support', MAC_BROWSER_FOLDERS[browser]),
    ]);
  }

  return [];
}

// An unpacked extension is ours when it is our folder, or a copy of our extension.
async function isOwnExtension(entryPath, integrationRoot) {
  const installed = await fs.realpath(entryPath).catch(() => null);
  const expected = await fs.realpath(path.join(integrationRoot, 'extension'));

  if (!installed) {
    return false;
  }

  if (installed.toLowerCase() === expected.toLowerCase()) {
    return true;
  }

  const manifest = JSON.parse(await fs.readFile(path.join(installed, 'manifest.json'), 'utf8'));
  const background = await fs.readFile(path.join(installed, 'background.js'), 'utf8');
  return (
    manifest.name === 'Awesome Downloader Integration' &&
    manifest.background?.service_worker === 'background.js' &&
    background.includes(`const HOST = '${HOST}'`)
  );
}

// Read only extension registrations, never browser history, cookies, or page data.
async function connectInstalledBrowsers({
  dataDirectory,
  integrationRoot,
  platform = process.platform,
  home = os.homedir(),
  localAppData = process.env.LOCALAPPDATA,
}) {
  const results = [];

  for (const [browser, root] of browserProfileRoots(platform, { localAppData, home })) {
    // A browser that is not installed has no profile folder.
    const profiles = await fs.readdir(root, { withFileTypes: true }).catch(() => []);
    const ids = new Set();

    for (const profile of profiles.filter(
      (entry) => entry.isDirectory() && /^(Default|Profile \d+)$/.test(entry.name),
    )) {
      for (const file of ['Preferences', 'Secure Preferences']) {
        try {
          const settings =
            JSON.parse(await fs.readFile(path.join(root, profile.name, file), 'utf8')).extensions
              ?.settings || {};

          for (const [id, entry] of Object.entries(settings)) {
            if (
              /^[a-p]{32}$/.test(id) &&
              entry.path &&
              path.isAbsolute(entry.path) &&
              (await isOwnExtension(entry.path, integrationRoot))
            ) {
              ids.add(id);
            }
          }
        } catch {
          /* A running browser can temporarily replace a preference file. */
        }
      }
    }

    if (ids.size) {
      const result = await registerBrowser(
        { browser, extensionId: [...ids][0] },
        { dataDirectory, integrationRoot, platform, home },
      );

      // Multiple profiles may assign different IDs to this same unpacked extension.
      const manifest = JSON.parse(await fs.readFile(result.manifestPath, 'utf8'));
      manifest.allowed_origins = [...ids].map((id) => `chrome-extension://${id}/`);
      await fs.writeFile(result.manifestPath, JSON.stringify(manifest, null, 2));
      results.push({ browser, connected: true });
    }
  }

  return results;
}

// Browsers start this connector with stdin/stdout piped to the extension.
const shellQuote = (value) => `'${String(value).replaceAll("'", `'\\''`)}'`;

async function prepareNativeHost(integrationRoot, executable, platform = process.platform) {
  const folder = path.join(integrationRoot, 'integration');

  if (platform !== 'win32') {
    await fs.writeFile(
      path.join(folder, 'native-host.sh'),
      `#!/bin/sh\nexport ELECTRON_RUN_AS_NODE=1\nexec ${shellQuote(executable)} "$(dirname "$0")/native-host.cjs"\n`,
      { mode: 0o755 },
    );

    // writeFile keeps the mode of an existing file; make sure it stays executable.
    await fs.chmod(path.join(folder, 'native-host.sh'), 0o755);
    return;
  }

  const target = path.join(folder, 'native-host.exe');

  try {
    await fs.access(target);
  } catch {
    const compiler = path.join(
      process.env.WINDIR || 'C:\\Windows',
      'Microsoft.NET',
      'Framework64',
      'v4.0.30319',
      'csc.exe',
    );

    await exec(
      compiler,
      ['/nologo', '/target:exe', `/out:${target}`, path.join(folder, 'NativeHostLauncher.cs')],
      { windowsHide: true },
    );
  }

  await fs.writeFile(path.join(folder, 'runtime-path.txt'), executable, 'utf8');
}

module.exports = { registerBrowser, connectInstalledBrowsers, prepareNativeHost, nativeHostPath };
