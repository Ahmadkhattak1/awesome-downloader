const fs = require('node:fs/promises');
const path = require('node:path');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const exec = promisify(execFile);

const BROWSERS = {
  Chrome: { registry: 'Google\\Chrome', data: 'Google/Chrome/User Data', dataRoot: 'local' },
  Edge: { registry: 'Microsoft\\Edge', data: 'Microsoft/Edge/User Data', dataRoot: 'local' },
  Brave: { registry: 'BraveSoftware\\Brave-Browser', data: 'BraveSoftware/Brave-Browser/User Data', dataRoot: 'local' },
  // Opera documents that its Windows native host is registered under Chrome.
  Opera: { registry: 'Google\\Chrome', data: 'Opera Software/Opera Stable', dataRoot: 'roaming', rootProfile: true },
  Firefox: { registry: 'Mozilla', data: 'Mozilla/Firefox/Profiles', dataRoot: 'roaming', firefox: true }
};

function browserSpec(browser) {
  const spec = BROWSERS[browser];
  if (!spec) throw new Error('Choose Chrome, Edge, Brave, Opera, or Firefox.');
  return spec;
}

async function registerBrowser({ browser, extensionId }, { dataDirectory, integrationRoot }) {
  const spec=browserSpec(browser);
  if (typeof extensionId !== 'string' || !(spec.firefox ? /^[A-Za-z0-9@._{}-]{1,128}$/ : /^[a-p]{32}$/).test(extensionId)) throw new Error('Copy the extension ID from your browser’s extensions page.');
  const host = 'com.awesome.downloader';
  const key = `HKCU\\Software\\${spec.registry}\\NativeMessagingHosts\\${host}`;
  const folder = path.join(dataDirectory, 'NativeMessaging');
  // Opera and Chrome intentionally share the Chrome registry location and
  // therefore one allow-list manifest instead of replacing each other.
  const manifestName=browser==='Opera'?'Chrome':browser;
  const manifestPath = path.join(folder, `${manifestName}.json`);
  const manifest = { name: host, description: 'Awesome Downloader browser bridge', path: path.join(integrationRoot, 'integration', 'native-host.exe'), type: 'stdio' };
  if (spec.firefox) manifest.allowed_extensions = [extensionId];
  else manifest.allowed_origins = [`chrome-extension://${extensionId}/`];
  await fs.access(manifest.path);
  await fs.mkdir(folder, { recursive: true });
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
  if (previous && previous !== content) await fs.writeFile(`${manifestPath}.${stamp}.bak`, previous);
  let registry = null;
  try { registry = (await exec('reg.exe', ['QUERY', key, '/ve'], { windowsHide: true })).stdout; }
  catch (error) { if (error.code !== 1) throw error; }
  const previousPath = registry?.match(/REG_SZ\s+(.+)\r?\n?/)?.[1]?.trim();
  if (registry && previousPath !== manifestPath) await fs.writeFile(path.join(folder, `${browser}.${stamp}.registry-backup.txt`), registry);
  if (previous !== content) await fs.writeFile(manifestPath, content, 'utf8');
  if (previousPath !== manifestPath) await exec('reg.exe', ['ADD', key, '/ve', '/t', 'REG_SZ', '/d', manifestPath, '/f'], { windowsHide: true });
  let extensionPath = path.join(integrationRoot, 'extension');
  if (spec.firefox) {
    extensionPath = path.join(folder, 'firefox-extension');
    await fs.cp(path.join(integrationRoot, 'extension'), extensionPath, { recursive: true });
    await fs.copyFile(path.join(extensionPath, 'manifest.firefox.json'), path.join(extensionPath, 'manifest.json'));
  }
  return { ok: true, manifestPath, extensionPath };
}
// Read only extension registrations, never browser history, cookies, or page data.
async function connectInstalledBrowsers({ dataDirectory, integrationRoot, localAppData = process.env.LOCALAPPDATA, roamingAppData = process.env.APPDATA }, { register = registerBrowser } = {}) {
  const results = [];
  const expected = await fs.realpath(path.join(integrationRoot, 'extension'));
  for (const [browser, spec] of Object.entries(BROWSERS).filter(([,value])=>!value.firefox)) {
    const base=spec.dataRoot==='roaming'?roamingAppData:localAppData;
    if(!base)continue;
    const root = path.join(base, spec.data);
    let profiles;
    try { profiles = await fs.readdir(root, { withFileTypes: true }); } catch { continue; }
    if(spec.rootProfile)profiles=[{name:'.',isDirectory:()=>true},...profiles];
    const ids = new Set(), matchedProfiles = new Set();
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
            if (ownExtension) { ids.add(id); matchedProfiles.add(profile.name); }
          }
        } catch { /* A running browser can temporarily replace a preference file. */ }
      }
    }
    if (ids.size) {
      let result;
      for(const extensionId of ids)result=await register({ browser, extensionId }, { dataDirectory, integrationRoot });
      results.push({ browser, connected: true, profiles: matchedProfiles.size });
    }
  }
  const firefoxRoot = roamingAppData && path.join(roamingAppData, BROWSERS.Firefox.data);
  if (firefoxRoot) {
    const matchedProfiles = [];
    let profiles = [];
    try { profiles = await fs.readdir(firefoxRoot, { withFileTypes: true }); } catch { /* Firefox is not installed or has no profile yet. */ }
    for (const profile of profiles.filter(entry => entry.isDirectory())) {
      try {
        const extensions = JSON.parse(await fs.readFile(path.join(firefoxRoot, profile.name, 'extensions.json'), 'utf8')).addons || [];
        if (extensions.some(addon => addon.id === 'awesome-downloader@morluto.local' && addon.active !== false && addon.appDisabled !== true)) matchedProfiles.push(profile.name);
      } catch { /* A running browser can temporarily replace its add-on database. */ }
    }
    if (matchedProfiles.length) {
      await register({ browser: 'Firefox', extensionId: 'awesome-downloader@morluto.local' }, { dataDirectory, integrationRoot });
      results.push({ browser: 'Firefox', connected: true, profiles: matchedProfiles.length });
    }
  }
  return results;
}
async function prepareNativeHost(integrationRoot, executable) {
  const folder = path.join(integrationRoot, 'integration');
  const target = path.join(folder, 'native-host.exe');
  try { await fs.access(target); }
  catch {
    const compiler = path.join(process.env.WINDIR || 'C:\\Windows', 'Microsoft.NET', 'Framework64', 'v4.0.30319', 'csc.exe');
    await exec(compiler, ['/nologo', '/target:exe', `/out:${target}`, path.join(folder, 'NativeHostLauncher.cs')], { windowsHide: true });
  }
  await fs.writeFile(path.join(folder, 'runtime-path.txt'), executable, 'utf8');
}
module.exports = { BROWSERS, browserSpec, registerBrowser, connectInstalledBrowsers, prepareNativeHost };
