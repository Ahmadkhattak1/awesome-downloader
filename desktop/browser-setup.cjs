const path = require('node:path');
const fs = require('node:fs/promises');
const { spawn, execFile } = require('node:child_process');
const { promisify } = require('node:util');

async function openExtensions(browser) {
  const relative = { Chrome: 'Google/Chrome/Application/chrome.exe', Edge: 'Microsoft/Edge/Application/msedge.exe' }[browser];
  if (!relative) throw new Error('Choose Chrome or Edge.');
  const url = browser === 'Chrome' ? 'chrome://extensions/' : 'edge://extensions/';
  if (process.platform === 'darwin') {
    // `open -a` finds the app wherever it is installed and reuses a running browser.
    const application = browser === 'Chrome' ? 'Google Chrome' : 'Microsoft Edge';
    try { await promisify(execFile)('open', ['-a', application, url]); return; }
    catch { throw new Error(`${browser} was not found. Open ${url} in your browser manually.`); }
  }
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
