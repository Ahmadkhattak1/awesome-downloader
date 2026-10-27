const path = require('node:path');
const fs = require('node:fs');

const LINKS = [
  { label: 'Source code and issues', url: 'https://github.com/Ahmadkhattak1/awesome-downloader' },
  { label: 'Report a security problem', url: 'https://github.com/Ahmadkhattak1/awesome-downloader/security' }
];
// Plain data for the About window (kept free of Electron objects so it can be unit tested).
function buildAboutInfo({ version, versions = {}, platform = process.platform, arch = process.arch, root, dataDirectory, packaged = false }) {
  const read = name => { try { return fs.readFileSync(path.join(root, name), 'utf8'); } catch { return ''; } };
  return {
    name: 'Awesome Downloader', version, packaged,
    description: 'A Windows download manager with segmented transfers, adaptive connections, HTTP/2 multiplexing, on-the-fly integrity checks and browser video capture.',
    features: ['HTTP/1.1 and HTTP/2 (ALPN) range downloads in 2–4 MB blocks', 'Automatic scale-down and Retry-After handling on HTTP 429 / 503', 'Adaptive block sizing, slow-connection dropping and mirror balancing', 'SHA-256 and MD5 computed in a worker thread while downloading', 'Unencrypted HLS to MP4, separate audio/video muxing, browser extension'],
    runtime: { Electron: versions.electron || '', Chromium: versions.chrome || '', 'Node.js': versions.node || '', V8: versions.v8 || '', Platform: `${platform} ${arch}`, 'Data folder': dataDirectory || '' },
    links: LINKS, license: read('LICENSE'), thirdParty: read('THIRD-PARTY.md')
  };
}
function diagnosticsText(info) {
  return [`${info.name} ${info.version}${info.packaged ? '' : ' (development)'}`, ...Object.entries(info.runtime).filter(([, v]) => v).map(([k, v]) => `${k}: ${v}`)].join('\n');
}
module.exports = { buildAboutInfo, diagnosticsText, LINKS };
