const path = require('node:path');
const fs = require('node:fs/promises');
const { constants } = require('node:fs');
const { spawn } = require('node:child_process');

const linuxExecutables = {
  Chrome: ['google-chrome', 'google-chrome-stable', 'google-chrome-beta', 'google-chrome-unstable'],
  Chromium: ['chromium', 'chromium-browser'],
  Edge: ['microsoft-edge', 'microsoft-edge-stable', 'microsoft-edge-beta', 'microsoft-edge-dev']
};
const linuxFallbacks = {
  Chrome: ['/opt/google/chrome/chrome', '/usr/bin/google-chrome', '/snap/bin/google-chrome'],
  Chromium: ['/usr/bin/chromium', '/usr/bin/chromium-browser', '/snap/bin/chromium'],
  Edge: ['/usr/bin/microsoft-edge', '/opt/microsoft/msedge/microsoft-edge', '/snap/bin/microsoft-edge']
};

async function findExecutable(names, fallbacks = []) {
  const directories = (process.env.PATH || '').split(path.delimiter).filter(Boolean);
  for (const name of names) {
    for (const directory of directories) {
      const candidate = path.join(directory, name);
      try { await fs.access(candidate, constants.X_OK); return candidate; } catch { /* Try the next candidate. */ }
    }
  }
  for (const candidate of fallbacks) {
    try { await fs.access(candidate, constants.X_OK); return candidate; } catch { /* Try the next candidate. */ }
  }
  return null;
}

async function openWindow(executable, url) {
  await new Promise((resolve, reject) => {
    const child = spawn(executable, [url], { detached: true, stdio: 'ignore', windowsHide: true });
    child.once('error', reject);
    child.once('spawn', () => { child.unref(); resolve(); });
  });
}

async function openExtensions(browser) {
  const url = { Chrome: 'chrome://extensions/', Chromium: 'chrome://extensions/', Edge: 'edge://extensions/' }[browser];
  if (!url) throw new Error('Choose Chrome, Chromium, or Edge.');
  if (process.platform === 'win32') {
    const relative = { Chrome: 'Google/Chrome/Application/chrome.exe', Edge: 'Microsoft/Edge/Application/msedge.exe' }[browser];
    if (!relative) throw new Error(`${browser} extension setup is not automated on Windows. Open ${url} manually.`);
    for (const root of [process.env.LOCALAPPDATA, process.env.ProgramFiles, process.env['ProgramFiles(x86)']].filter(Boolean)) {
      const executable = path.join(root, relative);
      try { await fs.access(executable); } catch { continue; }
      await openWindow(executable, url);
      return;
    }
    throw new Error(`${browser} was not found. Open ${url} in your browser manually.`);
  }
  const executable = await findExecutable(linuxExecutables[browser], linuxFallbacks[browser]);
  if (!executable) throw new Error(`${browser} was not found. Open ${url} in your browser manually.`);
  await openWindow(executable, url);
}
module.exports = { openExtensions, findExecutable };
