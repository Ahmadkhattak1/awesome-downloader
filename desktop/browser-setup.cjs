const os = require('node:os');
const path = require('node:path');
const fs = require('node:fs/promises');
const { spawn } = require('node:child_process');

function browserExecutables(browser, platform) {
  if (platform === 'darwin') {
    const bundle = { Chrome: 'Google Chrome', Edge: 'Microsoft Edge' }[browser];
    if (!bundle) {
      return null;
    }
    return ['/Applications', path.join(os.homedir(), 'Applications')].map((root) =>
      path.join(root, `${bundle}.app`, 'Contents', 'MacOS', bundle),
    );
  }
  const relative = {
    Chrome: 'Google/Chrome/Application/chrome.exe',
    Edge: 'Microsoft/Edge/Application/msedge.exe',
  }[browser];
  if (!relative) {
    return null;
  }
  return [process.env.LOCALAPPDATA, process.env.ProgramFiles, process.env['ProgramFiles(x86)']]
    .filter(Boolean)
    .map((root) => path.join(root, relative));
}
async function openExtensions(browser, platform = process.platform) {
  const executables = browserExecutables(browser, platform);
  if (!executables) {
    throw new Error('Choose Chrome or Edge.');
  }
  const url = browser === 'Chrome' ? 'chrome://extensions/' : 'edge://extensions/';
  const exists = (file) =>
    fs.access(file).then(
      () => true,
      () => false,
    );
  for (const executable of executables) {
    if (await exists(executable)) {
      // A running browser hands the URL to its open window.
      await new Promise((resolve, reject) => {
        const child = spawn(executable, [url], {
          detached: true,
          stdio: 'ignore',
          windowsHide: true,
        });
        child.once('error', reject);
        child.once('spawn', () => {
          child.unref();
          resolve();
        });
      });
      return;
    }
  }
  throw new Error(`${browser} was not found. Open ${url} in your browser manually.`);
}
module.exports = { openExtensions };
