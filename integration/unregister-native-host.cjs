// macOS uninstall step: removes this product's native-host manifests and the
// generated launcher files. Quit Awesome Downloader first, because the running app
// registers its host again every few seconds. The launcher folder defaults to this
// checkout; for the installed app pass ~/.awesome-downloader/BrowserIntegration.
const path = require('node:path');
const { unregisterNativeHosts } = require('../desktop/browser-registration.cjs');
unregisterNativeHosts({ integrationRoot: path.resolve(process.argv[2] || path.join(__dirname, '..')) }).then(removed => {
  for (const file of removed) console.log(`Removed ${file}`);
  if (!removed.length) console.log('Nothing to remove.');
}, error => { console.error(error.message); process.exitCode = 1; });
