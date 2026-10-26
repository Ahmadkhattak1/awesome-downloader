const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const exec = promisify(execFile);
// macOS browsers read native-host manifests and profiles from fixed folders under
// ~/Library/Application Support instead of the registry and %LOCALAPPDATA%.
const macBrowserFolders = { Chrome: 'Google/Chrome', Edge: 'Microsoft Edge', Firefox: 'Mozilla' };
const macSupport = home => path.join(home, 'Library', 'Application Support');

async function registerBrowser({ browser, extensionId }, { dataDirectory, integrationRoot, platform = process.platform, home = os.homedir() }) {
  if (!['Chrome', 'Edge', 'Firefox'].includes(browser)) throw new Error('Choose Chrome, Edge, or Firefox.');
  if (typeof extensionId !== 'string' || !(browser === 'Firefox' ? /^[A-Za-z0-9@._{}-]{1,128}$/ : /^[a-p]{32}$/).test(extensionId)) throw new Error('Copy the extension ID from your browser’s extensions page.');
  const host = 'com.awesome.downloader';
  const mac = platform === 'darwin';
  const roots = { Chrome: 'Google\\Chrome', Edge: 'Microsoft\\Edge', Firefox: 'Mozilla' };
  const key = `HKCU\\Software\\${roots[browser]}\\NativeMessagingHosts\\${host}`;
  const folder = path.join(dataDirectory, 'NativeMessaging');
  const manifestFolder = mac ? path.join(macSupport(home), macBrowserFolders[browser], 'NativeMessagingHosts') : folder;
  const manifestPath = path.join(manifestFolder, mac ? `${host}.json` : `${browser}.json`);
  const manifest = { name: host, description: 'Awesome Downloader browser bridge', path: path.join(integrationRoot, 'integration', mac ? 'native-host' : 'native-host.exe'), type: 'stdio' };
  if (browser === 'Firefox') manifest.allowed_extensions = [extensionId];
  else manifest.allowed_origins = [`chrome-extension://${extensionId}/`];
  const content = JSON.stringify(manifest, null, 2);
  await fs.access(manifest.path);
  await fs.mkdir(folder, { recursive: true });
  await fs.mkdir(manifestFolder, { recursive: true });
  let previous;
  try { previous = await fs.readFile(manifestPath, 'utf8'); } catch (e) { if (e.code !== 'ENOENT') throw e; }
  const stamp = new Date().toISOString().replaceAll(/[:.]/g, '-');
  // Backups stay in our own folder so browsers never see a stray manifest.
  if (previous && previous !== content) await fs.writeFile(path.join(folder, `${browser}.json.${stamp}.bak`), previous);
  if (previous !== content) await fs.writeFile(manifestPath, content, 'utf8');
  if (!mac) {
    let registry = null;
    try { registry = (await exec('reg.exe', ['QUERY', key, '/ve'], { windowsHide: true })).stdout; }
    catch (error) { if (error.code !== 1) throw error; }
    const previousPath = registry?.match(/REG_SZ\s+(.+)\r?\n?/)?.[1]?.trim();
    if (registry && previousPath !== manifestPath) await fs.writeFile(path.join(folder, `${browser}.${stamp}.registry-backup.txt`), registry);
    if (previousPath !== manifestPath) await exec('reg.exe', ['ADD', key, '/ve', '/t', 'REG_SZ', '/d', manifestPath, '/f'], { windowsHide: true });
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
async function connectInstalledBrowsers({ dataDirectory, integrationRoot, localAppData = process.env.LOCALAPPDATA, platform = process.platform, home = os.homedir() }) {
  const results = [];
  const mac = platform === 'darwin';
  for (const [browser, relative] of [['Chrome', 'Google/Chrome/User Data'], ['Edge', 'Microsoft/Edge/User Data']]) {
    const root = mac ? path.join(macSupport(home), macBrowserFolders[browser]) : path.join(localAppData, relative);
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
      const result = await registerBrowser({ browser, extensionId: [...ids][0] }, { dataDirectory, integrationRoot, platform, home });
      // Multiple profiles may assign different IDs to this same unpacked extension.
      const manifest = JSON.parse(await fs.readFile(result.manifestPath, 'utf8'));
      manifest.allowed_origins = [...ids].map(id => `chrome-extension://${id}/`);
      await fs.writeFile(result.manifestPath, JSON.stringify(manifest, null, 2));
      results.push({ browser, connected: true });
    }
  }
  return results;
}
async function prepareNativeHost(integrationRoot, executable, platform = process.platform) {
  const folder = path.join(integrationRoot, 'integration');
  if (platform === 'darwin') {
    // Browsers start hosts without the user's PATH; run the app's own runtime as Node.
    const script = '#!/bin/sh\ndir=$(cd "$(dirname "$0")" && pwd)\nELECTRON_RUN_AS_NODE=1 exec "$(cat "$dir/runtime-path.txt")" "$dir/native-host.cjs"\n';
    await fs.writeFile(path.join(folder, 'native-host'), script, { mode: 0o755 });
    await fs.chmod(path.join(folder, 'native-host'), 0o755);
    await fs.writeFile(path.join(folder, 'runtime-path.txt'), executable, 'utf8');
    return;
  }
  const target = path.join(folder, 'native-host.exe');
  try { await fs.access(target); }
  catch {
    const compiler = path.join(process.env.WINDIR || 'C:\\Windows', 'Microsoft.NET', 'Framework64', 'v4.0.30319', 'csc.exe');
    await exec(compiler, ['/nologo', '/target:exe', `/out:${target}`, path.join(folder, 'NativeHostLauncher.cs')], { windowsHide: true });
  }
  await fs.writeFile(path.join(folder, 'runtime-path.txt'), executable, 'utf8');
}
module.exports = { registerBrowser, connectInstalledBrowsers, prepareNativeHost };
