const path = require('node:path');
const fs = require('node:fs/promises');
const { spawn } = require('node:child_process');

const DEFINITIONS = {
  Chrome: { url: 'chrome://extensions/', candidates: [
    ['LOCALAPPDATA', 'Google/Chrome/Application/chrome.exe'], ['ProgramFiles', 'Google/Chrome/Application/chrome.exe'], ['ProgramFiles(x86)', 'Google/Chrome/Application/chrome.exe']
  ] },
  Edge: { url: 'edge://extensions/', candidates: [
    ['ProgramFiles(x86)', 'Microsoft/Edge/Application/msedge.exe'], ['ProgramFiles', 'Microsoft/Edge/Application/msedge.exe'], ['LOCALAPPDATA', 'Microsoft/Edge/Application/msedge.exe']
  ] },
  Brave: { url: 'brave://extensions/', candidates: [
    ['LOCALAPPDATA', 'BraveSoftware/Brave-Browser/Application/brave.exe'], ['ProgramFiles', 'BraveSoftware/Brave-Browser/Application/brave.exe'], ['ProgramFiles(x86)', 'BraveSoftware/Brave-Browser/Application/brave.exe']
  ] },
  Opera: { url: 'opera://extensions/', candidates: [
    ['LOCALAPPDATA', 'Programs/Opera/launcher.exe'], ['LOCALAPPDATA', 'Programs/Opera GX/launcher.exe'], ['ProgramFiles', 'Opera/launcher.exe'], ['ProgramFiles(x86)', 'Opera/launcher.exe']
  ] },
  Firefox: { url: 'about:debugging#/runtime/this-firefox', firefox: true, candidates: [
    ['ProgramFiles', 'Mozilla Firefox/firefox.exe'], ['ProgramFiles(x86)', 'Mozilla Firefox/firefox.exe'], ['LOCALAPPDATA', 'Mozilla Firefox/firefox.exe']
  ] }
};

function definitionFor(browser) {
  const definition = DEFINITIONS[browser];
  if (!definition) throw new Error('Choose Chrome, Edge, Brave, Opera, or Firefox.');
  return definition;
}

async function findBrowserExecutable(browser, environment = process.env) {
  const definition = definitionFor(browser);
  for (const [rootName, relative] of definition.candidates) {
    const root = environment[rootName];
    if (!root) continue;
    const executable = path.join(root, relative);
    try { await fs.access(executable); return executable; } catch { /* Try the next supported location. */ }
  }
  return null;
}

async function openBrowser(browser, environment = process.env) {
  definitionFor(browser);
  const executable = await findBrowserExecutable(browser, environment);
  if (!executable) throw new Error(`${browser} was not found.`);
  await new Promise((resolve, reject) => {
    const child = spawn(executable, [], { detached: true, stdio: 'ignore', windowsHide: true });
    child.once('error', reject);
    child.once('spawn', () => { child.unref(); resolve(); });
  });
  return { browser };
}
module.exports = { DEFINITIONS, definitionFor, findBrowserExecutable, openBrowser };
