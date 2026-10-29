// macOS packaging configuration: package.json "build" without electronDist.
// npm ci leaves node_modules/electron/dist empty (the electron package has no
// postinstall) and it would only ever hold the host's architecture, so on macOS
// electron-builder downloads the Electron that matches each target architecture.
//
// Release builds are signed with a Developer ID, use the hardened runtime and are
// notarized. They are used only when CSC_LINK (or CSC_NAME) is set, and then the
// Apple notarization variables are required too. Without them (forks, pull
// requests, local builds) the app is ad-hoc signed and not notarized.
// See docs/RELEASING.md.
const { electronDist, ...build } = require('./package.json').build;

const signingVariables = ['CSC_LINK', 'CSC_KEY_PASSWORD', 'CSC_NAME', 'APPLE_ID', 'APPLE_APP_SPECIFIC_PASSWORD', 'APPLE_TEAM_ID'];
// GitHub Actions passes an unset secret as an empty string; treat it as absent.
for (const name of signingVariables) if (process.env[name] === '') delete process.env[name];

const release = Boolean(process.env.CSC_LINK || process.env.CSC_NAME);
if (release) {
  const missing = ['APPLE_ID', 'APPLE_APP_SPECIFIC_PASSWORD', 'APPLE_TEAM_ID'].filter(name => !process.env[name]);
  if (missing.length) throw new Error(`Signed macOS builds must be notarized; set ${missing.join(', ')}.`);
}

module.exports = {
  ...build,
  // Fail instead of quietly shipping an unsigned app when the certificate is unusable.
  forceCodeSigning: release,
  mac: release ? build.mac : {
    ...build.mac,
    identity: '-',
    // Library validation rejects ad-hoc signed frameworks under the hardened runtime.
    hardenedRuntime: false,
    notarize: false
  }
};
