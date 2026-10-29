// macOS uninstall step for a source checkout: removes this product's native-host
// manifests and the launcher files generated here. Quit Awesome Downloader first,
// because the running app registers its host again every few seconds.
const path = require('node:path');
const { unregisterNativeHosts } = require('../desktop/browser-registration.cjs');
unregisterNativeHosts({ integrationRoot: path.join(__dirname, '..') }).then(removed => {
  for (const file of removed) console.log(`Removed ${file}`);
  if (!removed.length) console.log('Nothing to remove.');
}, error => { console.error(error.message); process.exitCode = 1; });
