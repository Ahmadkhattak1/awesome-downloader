const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const { writeNativeHostLauncher } = require('./native-host-launcher.cjs');
const exec = promisify(execFile);
const isWindows = process.platform === 'win32';
const HOST = 'com.awesome.downloader';
const BROWSERS = ['Chrome', 'Chromium', 'Edge', 'Firefox'];

// Linux browsers read native messaging manifests from per-user directories
// instead of the Windows registry. Keep the mapping in one place so setup,
// manual registration, and browser detection all agree.
function linuxConfigHome() {
  return process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config');
}
function nativeHostManifestPath(browser, { configHome = linuxConfigHome(), home = os.homedir() } = {}) {
  const name = `${HOST}.json`;
  const directories = {
    Chrome: ['google-chrome', 'NativeMessagingHosts'],
    Chromium: ['chromium', 'NativeMessagingHosts'],
    Edge: ['microsoft-edge', 'NativeMessagingHosts'],
    Firefox: ['.mozilla', 'native-messaging-hosts']
  };
  const parts = directories[browser];
  if (!parts) return null;
  return path.join(browser === 'Firefox' ? home : configHome, ...parts, name);
}
function manifestTarget(integrationRoot) {
  return path.join(integrationRoot, 'integration', isWindows ? 'native-host.exe' : 'native-host.sh');
}
async function registerBrowser({ browser, extensionId }, { dataDirectory, integrationRoot }) {
  if (!BROWSERS.includes(browser)) throw new Error('Choose Chrome, Chromium, Edge, or Firefox.');
  if (typeof extensionId !== 'string' || !(browser === 'Firefox' ? /^[A-Za-z0-9@._{}-]{1,128}$/ : /^[a-p]{32}$/).test(extensionId)) throw new Error('Copy the extension ID from your browser’s extensions page.');
  const roots = { Chrome: 'Google\\Chrome', Chromium: 'Chromium', Edge: 'Microsoft\\Edge', Firefox: 'Mozilla' };
  const key = `HKCU\\Software\\${roots[browser]}\\NativeMessagingHosts\\${HOST}`;
  const folder = path.join(dataDirectory, 'NativeMessaging');
  const manifestPath = isWindows ? path.join(folder, `${browser}.json`) : nativeHostManifestPath(browser);
  const manifest = { name: HOST, description: 'Awesome Downloader browser bridge', path: manifestTarget(integrationRoot), type: 'stdio' };
  if (browser === 'Firefox') manifest.allowed_extensions = [extensionId];
  else manifest.allowed_origins = [`chrome-extension://${extensionId}/`];
  const content = JSON.stringify(manifest, null, 2);
  await fs.access(manifest.path);
  await fs.mkdir(folder, { recursive: true });
  await fs.mkdir(path.dirname(manifestPath), { recursive: true });
  let previous;
  try { previous = await fs.readFile(manifestPath, 'utf8'); } catch (e) { if (e.code !== 'ENOENT') throw e; }
  const stamp = new Date().toISOString().replaceAll(/[:.]/g, '-');
  if (previous && previous !== content) await fs.writeFile(`${manifestPath}.${stamp}.bak`, previous);
  if (isWindows) {
    let registry = null;
    try { registry = (await exec('reg.exe', ['QUERY', key, '/ve'], { windowsHide: true })).stdout; }
    catch (error) { if (error.code !== 1) throw error; }
    const previousPath = registry?.match(/REG_SZ\s+(.+)\r?\n?/)?.[1]?.trim();
    if (registry && previousPath !== manifestPath) await fs.writeFile(path.join(folder, `${browser}.${stamp}.registry-backup.txt`), registry);
    if (previous !== content) await fs.writeFile(manifestPath, content, 'utf8');
    if (previousPath !== manifestPath) await exec('reg.exe', ['ADD', key, '/ve', '/t', 'REG_SZ', '/d', manifestPath, '/f'], { windowsHide: true });
  } else if (previous !== content) {
    await fs.writeFile(manifestPath, content, 'utf8');
  }
  let extensionPath = path.join(integrationRoot, 'extension');
  if (browser === 'Firefox') {
    extensionPath = path.join(folder, 'firefox-extension');
    await fs.cp(path.join(integrationRoot, 'extension'), extensionPath, { recursive: true });
    await fs.copyFile(path.join(extensionPath, 'manifest.firefox.json'), path.join(extensionPath, 'manifest.json'));
  }
  return { ok: true, manifestPath, extensionPath };
}
// Read only extension registrations, never browser history, cookies, or page data.
async function connectInstalledBrowsers({ dataDirectory, integrationRoot, localAppData = process.env.LOCALAPPDATA }) {
  const results = [];
  // Windows keeps Chrome/Edge profiles under LOCALAPPDATA; Linux uses
  // XDG_CONFIG_HOME. Chromium is common on Linux, so it is detected too.
  const roots = isWindows
    ? [['Chrome', path.join(localAppData, 'Google/Chrome/User Data')], ['Edge', path.join(localAppData, 'Microsoft/Edge/User Data')]]
    : [['Chrome', path.join(linuxConfigHome(), 'google-chrome')], ['Chromium', path.join(linuxConfigHome(), 'chromium')], ['Edge', path.join(linuxConfigHome(), 'microsoft-edge')]];
  for (const [browser, root] of roots) {
    let profiles;
    try { profiles = await fs.readdir(root, { withFileTypes: true }); } catch { continue; }
    const ids = new Set();
    for (const profile of profiles.filter(p => p.isDirectory() && /^(Default|Profile \d+)$/.test(p.name))) {
      for (const file of ['Preferences', 'Secure Preferences']) {
        try {
          const settings = JSON.parse(await fs.readFile(path.join(root, profile.name, file), 'utf8')).extensions?.settings || {};
          for (const [id, entry] of Object.entries(settings)) {
            if (!/^[a-p]{32}$/.test(id) || !entry.path || !path.isAbsolute(entry.path)) continue;
            const installed = await fs.realpath(entry.path).catch(() => null);
            const expected = await fs.realpath(path.join(integrationRoot, 'extension'));
            let ownExtension=installed?.toLowerCase()===expected.toLowerCase();
            if(installed&&!ownExtension){
              const manifest=JSON.parse(await fs.readFile(path.join(installed,'manifest.json'),'utf8'));
              const background=await fs.readFile(path.join(installed,'background.js'),'utf8');
              ownExtension=manifest.name==='Awesome Downloader Integration'&&manifest.background?.service_worker==='background.js'&&background.includes("const HOST = 'com.awesome.downloader'");
            }
            if (ownExtension) ids.add(id);
          }
        } catch { /* A running browser can temporarily replace a preference file. */ }
      }
    }
    if (ids.size) {
      const result = await registerBrowser({ browser, extensionId: [...ids][0] }, { dataDirectory, integrationRoot });
      // Multiple profiles may assign different IDs to this same unpacked extension.
      const manifest = JSON.parse(await fs.readFile(result.manifestPath, 'utf8'));
      manifest.allowed_origins = [...ids].map(id => `chrome-extension://${id}/`);
      await fs.writeFile(result.manifestPath, JSON.stringify(manifest, null, 2));
      results.push({ browser, connected: true });
    }
  }
  return results;
}
async function prepareNativeHost(integrationRoot, executable) {
  const folder = path.join(integrationRoot, 'integration');
  if (isWindows) {
    const target = path.join(folder, 'native-host.exe');
    try { await fs.access(target); }
    catch {
      const compiler = path.join(process.env.WINDIR || 'C:\\Windows', 'Microsoft.NET', 'Framework64', 'v4.0.30319', 'csc.exe');
      await exec(compiler, ['/nologo', '/target:exe', `/out:${target}`, path.join(folder, 'NativeHostLauncher.cs')], { windowsHide: true });
    }
  } else {
    // Linux uses the wrapper script directly; no compiler is available or needed.
    await writeNativeHostLauncher(folder, executable);
  }
  await fs.writeFile(path.join(folder, 'runtime-path.txt'), executable, 'utf8');
}
module.exports = { registerBrowser, connectInstalledBrowsers, prepareNativeHost, nativeHostManifestPath, BROWSERS };
