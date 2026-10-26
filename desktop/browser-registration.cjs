const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const exec = promisify(execFile);

// `mac` is the browser's folder under ~/Library/Application Support, which holds
// its profiles and, except for Opera, its NativeMessagingHosts folder on macOS.
const BROWSERS = {
  Chrome: { registry: 'Google\\Chrome', data: 'Google/Chrome/User Data', dataRoot: 'local', mac: 'Google/Chrome' },
  Edge: { registry: 'Microsoft\\Edge', data: 'Microsoft/Edge/User Data', dataRoot: 'local', mac: 'Microsoft Edge' },
  Brave: { registry: 'BraveSoftware\\Brave-Browser', data: 'BraveSoftware/Brave-Browser/User Data', dataRoot: 'local', mac: 'BraveSoftware/Brave-Browser' },
  // Opera documents that its Windows native host is registered under Chrome;
  // on macOS it likewise shares Chrome's NativeMessagingHosts folder.
  Opera: { registry: 'Google\\Chrome', data: 'Opera Software/Opera Stable', dataRoot: 'roaming', rootProfile: true, mac: 'com.operasoftware.Opera' },
  Firefox: { registry: 'Mozilla', firefox: true, mac: 'Mozilla' }
};
const macSupport = home => path.join(home, 'Library', 'Application Support');

function browserSpec(browser) {
  const spec = BROWSERS[browser];
  if (!spec) throw new Error('Choose Chrome, Edge, Brave, Opera, or Firefox.');
  return spec;
}

async function registerBrowser({ browser, extensionId }, { dataDirectory, integrationRoot, platform = process.platform, home = os.homedir() }) {
  const spec=browserSpec(browser);
  if (typeof extensionId !== 'string' || !(spec.firefox ? /^[A-Za-z0-9@._{}-]{1,128}$/ : /^[a-p]{32}$/).test(extensionId)) throw new Error('Copy the extension ID from your browser’s extensions page.');
  const host = 'com.awesome.downloader';
  const key = `HKCU\\Software\\${spec.registry}\\NativeMessagingHosts\\${host}`;
  const folder = path.join(dataDirectory, 'NativeMessaging');
  // Opera and Chrome intentionally share the Chrome registry location and
  // therefore one allow-list manifest instead of replacing each other.
  const manifestName=browser==='Opera'?'Chrome':browser;
  // macOS has no registry: browsers read the manifest from a fixed per-user folder.
  const mac = platform === 'darwin';
  const manifestFolder = mac ? path.join(macSupport(home), BROWSERS[manifestName].mac, 'NativeMessagingHosts') : folder;
  const manifestPath = path.join(manifestFolder, mac ? `${host}.json` : `${manifestName}.json`);
  const manifest = { name: host, description: 'Awesome Downloader browser bridge', path: path.join(integrationRoot, 'integration', mac ? 'native-host' : 'native-host.exe'), type: 'stdio' };
  if (spec.firefox) manifest.allowed_extensions = [extensionId];
  else manifest.allowed_origins = [`chrome-extension://${extensionId}/`];
  await fs.access(manifest.path);
  await fs.mkdir(folder, { recursive: true });
  await fs.mkdir(manifestFolder, { recursive: true });
  let previous;
  try { previous = await fs.readFile(manifestPath, 'utf8'); } catch (e) { if (e.code !== 'ENOENT') throw e; }
  if(previous&&!spec.firefox){
    try {
      const old=JSON.parse(previous);
      manifest.allowed_origins=[...new Set([...(old.allowed_origins||[]),...manifest.allowed_origins])].filter(value=>/^chrome-extension:\/\/[a-p]{32}\/$/.test(value));
    } catch { /* The invalid file is backed up and replaced below. */ }
  }
  const content = JSON.stringify(manifest, null, 2);
  const stamp = new Date().toISOString().replaceAll(/[:.]/g, '-');
  // Backups stay in our own folder so browsers never see a stray manifest.
  if (previous && previous !== content) await fs.writeFile(path.join(folder, `${manifestName}.json.${stamp}.bak`), previous);
  if (mac) {
    if (previous !== content) await fs.writeFile(manifestPath, content, 'utf8');
  } else {
    let registry = null;
    try { registry = (await exec('reg.exe', ['QUERY', key, '/ve'], { windowsHide: true })).stdout; }
    catch (error) { if (error.code !== 1) throw error; }
    const previousPath = registry?.match(/REG_SZ\s+(.+)\r?\n?/)?.[1]?.trim();
    if (registry && previousPath !== manifestPath) await fs.writeFile(path.join(folder, `${browser}.${stamp}.registry-backup.txt`), registry);
    if (previous !== content) await fs.writeFile(manifestPath, content, 'utf8');
    if (previousPath !== manifestPath) await exec('reg.exe', ['ADD', key, '/ve', '/t', 'REG_SZ', '/d', manifestPath, '/f'], { windowsHide: true });
  }
  let extensionPath = path.join(integrationRoot, 'extension');
  if (spec.firefox) {
    extensionPath = path.join(folder, 'firefox-extension');
    await fs.cp(path.join(integrationRoot, 'extension'), extensionPath, { recursive: true });
    await fs.copyFile(path.join(extensionPath, 'manifest.firefox.json'), path.join(extensionPath, 'manifest.json'));
  }
  return { ok: true, manifestPath, extensionPath };
}
// Read only extension registrations, never browser history, cookies, or page data.
async function connectInstalledBrowsers({ dataDirectory, integrationRoot, localAppData = process.env.LOCALAPPDATA, roamingAppData = process.env.APPDATA, platform = process.platform, home = os.homedir() }, { register = registerBrowser } = {}) {
  const results = [];
  const mac = platform === 'darwin';
  const expected = await fs.realpath(path.join(integrationRoot, 'extension'));
  for (const [browser, spec] of Object.entries(BROWSERS).filter(([,value])=>!value.firefox)) {
    const base=mac?macSupport(home):spec.dataRoot==='roaming'?roamingAppData:localAppData;
    if(!base)continue;
    const root = path.join(base, mac ? spec.mac : spec.data);
    let profiles;
    try { profiles = await fs.readdir(root, { withFileTypes: true }); } catch { continue; }
    if(spec.rootProfile)profiles=[{name:'.',isDirectory:()=>true},...profiles];
    const ids = new Set();
    for (const profile of profiles.filter(p => p.isDirectory() && (p.name==='.'||/^(Default|Profile \d+)$/.test(p.name)))) {
      for (const file of ['Preferences', 'Secure Preferences']) {
        try {
          const settings = JSON.parse(await fs.readFile(path.join(root, profile.name, file), 'utf8')).extensions?.settings || {};
          for (const [id, entry] of Object.entries(settings)) {
            if (!/^[a-p]{32}$/.test(id) || !entry.path || !path.isAbsolute(entry.path)) continue;
            const installed = await fs.realpath(entry.path).catch(() => null);
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
      let result;
      for(const extensionId of ids)result=await register({ browser, extensionId }, { dataDirectory, integrationRoot, platform, home });
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
module.exports = { BROWSERS, browserSpec, registerBrowser, connectInstalledBrowsers, prepareNativeHost };
