const EXTENSION_ID = 'dnolinbkicmedadaigcedkmndcpahmml';
const STORE_URL = `https://chromewebstore.google.com/detail/${EXTENSION_ID}`;
const storeBrowser = browser => ['Chrome', 'Edge', 'Brave'].includes(browser);

module.exports = { EXTENSION_ID, STORE_URL, storeBrowser };
