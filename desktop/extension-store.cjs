const fs = require('node:fs/promises');
const path = require('node:path');
const EXTENSION_ID = 'dnolinbkicmedadaigcedkmndcpahmml';
const STORE_URL = `https://chromewebstore.google.com/detail/${EXTENSION_ID}`;
const storeBrowser = browser => ['Chrome', 'Edge', 'Brave'].includes(browser);

// A successful first interactive launch offers setup once. Background launches
// and browser download handoffs must never interrupt the user with setup tabs.
async function offerStoreSetup({ packaged, background, connected, browsers, directory, open }) {
  if (!packaged || background || connected) return false;
  const browser = browsers.find(item => item.name === 'Chrome' && item.installed);
  if (!browser) return false;
  const marker = path.join(directory, 'chrome-store-offered.json');
  try { await fs.access(marker); return false; } catch (error) { if (error.code !== 'ENOENT') throw error; }
  await open(browser.name);
  await fs.writeFile(marker, JSON.stringify({ extensionId: EXTENSION_ID }), { flag: 'wx' });
  return true;
}
module.exports = { EXTENSION_ID, STORE_URL, storeBrowser, offerStoreSetup };
