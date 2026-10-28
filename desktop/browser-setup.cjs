const path = require('node:path');
const fs = require('node:fs/promises');
const { spawn } = require('node:child_process');

async function openExtensions(browser) {
  const definitions={
    Chrome:{relative:'Google/Chrome/Application/chrome.exe',url:'chrome://extensions/'},
    Edge:{relative:'Microsoft/Edge/Application/msedge.exe',url:'edge://extensions/'},
    Brave:{relative:'BraveSoftware/Brave-Browser/Application/brave.exe',url:'brave://extensions/'},
    Opera:{relative:'Programs/Opera/launcher.exe',url:'opera://extensions/'}
  };
  const definition=definitions[browser];
  if (!definition) throw new Error('Choose Chrome, Edge, Brave, or Opera.');
  for (const root of [process.env.LOCALAPPDATA, process.env.ProgramFiles, process.env['ProgramFiles(x86)']].filter(Boolean)) {
    const executable = path.join(root, definition.relative);
    try { await fs.access(executable); } catch { continue; }
    await new Promise((resolve, reject) => {
      const child = spawn(executable, [definition.url], { detached: true, stdio: 'ignore', windowsHide: true });
      child.once('error', reject);
      child.once('spawn', () => { child.unref(); resolve(); });
    });
    return;
  }
  throw new Error(`${browser} was not found. Open ${definition.url} in your browser manually.`);
}
module.exports = { openExtensions };
