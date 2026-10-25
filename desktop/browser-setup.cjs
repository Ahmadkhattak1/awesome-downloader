const path = require('node:path');
const fs = require('node:fs/promises');
const { spawn } = require('node:child_process');

async function openExtensions(browser) {
  const relative = { Chrome: 'Google/Chrome/Application/chrome.exe', Edge: 'Microsoft/Edge/Application/msedge.exe' }[browser];
  if (!relative) throw new Error('Choose Chrome or Edge.');
  const url = browser === 'Chrome' ? 'chrome://extensions/' : 'edge://extensions/';
  for (const root of [process.env.LOCALAPPDATA, process.env.ProgramFiles, process.env['ProgramFiles(x86)']].filter(Boolean)) {
    const executable = path.join(root, relative);
    try { await fs.access(executable); } catch { continue; }
    await new Promise((resolve, reject) => {
      const child = spawn(executable, [url], { detached: true, stdio: 'ignore', windowsHide: true });
      child.once('error', reject);
      child.once('spawn', () => { child.unref(); resolve(); });
    });
    return;
  }
  throw new Error(`${browser} was not found. Open ${url} in your browser manually.`);
}
module.exports = { openExtensions };
