# Release checklist

Public source and public binaries are separate release steps. Do not publish a
download asset just because a local package command succeeds.

1. Run `npm ci` and `npm test` on Windows x64.
2. Review the source diff and export for private data and proprietary material.
3. Verify third-party license notices and provide corresponding source and build
   material for the actual bundled GPL binaries (including their linked components).
   The FFmpeg commit alone is not a complete source bundle for its external libraries.
   Mirror required source archives alongside binary release assets. Record hashes.
   Review the yt-dlp executable's bundled components too if it is included.
   FFmpeg differs per platform and architecture: audit each one you ship.
4. `npm run dist` builds an unsigned per-user NSIS installer. Test it on a clean
   Windows machine without Node.js: install, launch, extension setup, native handoff,
   download with audio, completion, update, and uninstall.
5. Publish a **prerelease** until the clean-machine checks and known limitations
   are documented. Attach installer, checksums, notices, and required source assets.
6. Never attach research, browser profiles, diagnostics with media URLs, or user data.
7. Enable repository Issues and private vulnerability reporting. Review incoming
   pull requests; contributors do not need write/admin access to submit them.

Current gates: GitHub authentication, dependency source-distribution audit,
clean-machine installer QA, and first release publication. Windows code signing
and browser store publication are not configured. macOS signing is configured
below but needs the maintainer's Apple credentials. Do not advertise any of them
as available until a signed build has been verified.

## macOS

macOS builds use [`electron-builder.mac.cjs`](../electron-builder.mac.cjs): the
`build` settings from `package.json`, minus `electronDist`. electron-builder
downloads the Electron for each target architecture, so a fresh
`npm ci && npm run dist:mac` needs no manual steps.

| Command | Output |
| --- | --- |
| `npm run dist:mac` | DMG for this Mac's architecture |
| `npm run dist:mac:arm64` | `release/Awesome-Downloader-<version>-macOS-arm64.dmg` |
| `npm run dist:mac:x64` | `release/Awesome-Downloader-<version>-macOS-x64.dmg` |
| `npm run package:mac` | unpacked `.app` only |

`ffmpeg-static` downloads one FFmpeg at install time, for the architecture npm
runs on. Build each architecture on a Mac of that architecture, or reinstall
first: `npm_config_arch=x64 npm ci && npm run dist:mac:x64` on Apple Silicon.
Every `dist:mac*` script then runs `scripts/check-mac-arch.sh`, which fails the
build unless `lipo -archs` reports exactly the target architecture for the app
executable, Electron Framework and the bundled FFmpeg (and includes it for
`tools/yt-dlp`, which upstream ships as a universal binary).

### Signing and notarization

The config chooses one of two modes from the environment:

- **Release:** `CSC_LINK` (or `CSC_NAME`) is set. The app is signed with that
  Developer ID Application certificate, runs with the hardened runtime, and is
  notarized with `notarytool`; electron-builder staples the ticket to the app.
  The build fails if the certificate can't be used (`forceCodeSigning`) or any
  notarization variable is missing.
- **Unsigned:** no certificate. The app is ad-hoc signed (Apple Silicon refuses
  to run unsigned code), without the hardened runtime and without notarization.
  Library validation rejects ad-hoc signed frameworks under the hardened runtime,
  so the app would not start with it on. Gatekeeper rejects these builds; they
  are for testing only. Forks and pull requests always build this way.

GitHub Actions secrets, read only by the macOS jobs in `release.yml`:

| Secret | Value |
| --- | --- |
| `CSC_LINK` | base64 of the Developer ID Application certificate and private key exported as `.p12` (`base64 -i cert.p12 \| pbcopy`) |
| `CSC_KEY_PASSWORD` | the `.p12` export password |
| `APPLE_ID` | the Apple ID email of a member of the developer team |
| `APPLE_APP_SPECIFIC_PASSWORD` | an [app-specific password](https://support.apple.com/102654) for that Apple ID |
| `APPLE_TEAM_ID` | the 10-character team ID |

Add them under *Settings → Secrets and variables → Actions*. Never commit a
certificate, `.p12`, password or `.env` file (`.gitignore` excludes the usual key
files, but check `git status` before committing). `release.yml` runs only on
manual dispatch, and GitHub does not pass repository secrets to workflows
triggered from forks, so fork builds are always unsigned. For an extra gate, move
the secrets into a protected environment with required reviewers.

To sign locally instead, export the same variables, or use a certificate in your
login keychain with `CSC_NAME="Developer ID Application: <Name> (<TEAM_ID>)"`.

**Entitlements** ([`build/entitlements.mac.plist`](../build/entitlements.mac.plist),
used for the app and, via `entitlementsInherit`, for every nested binary):
only `com.apple.security.cs.allow-jit`. V8 needs it in the main process, the
helpers and when the native-host launcher runs the app with
`ELECTRON_RUN_AS_NODE=1`; without it Electron aborts at startup under the
hardened runtime. Nothing else is requested: the app loads no third-party
libraries (no `disable-library-validation`), needs no unsigned executable memory,
and the app sandbox is off, so network access needs no entitlement.

**Nested binaries.** electron-builder signs every Mach-O file in the bundle with
the same identity and the hardened runtime: Electron helpers and frameworks,
`app.asar.unpacked/node_modules/ffmpeg-static/ffmpeg`, and
`Resources/tools/yt-dlp` if `vendor/yt-dlp` was present at build time. CI builds
don't include yt-dlp (it is not in the repository). If you bundle it, re-check a
signed build: the official `yt-dlp_macos` is a PyInstaller program that unpacks
and loads its own Python libraries, which library validation may reject.

**RunAsNode.** The native-host launcher and yt-dlp's JavaScript runtime start
the app's executable with `ELECTRON_RUN_AS_NODE=1`, which needs Electron's
`RunAsNode` fuse. The config does not change fuses, and Electron enables it by
default. `scripts/smoke-mac-app.sh` checks it in every CI build. If fuses are
ever hardened, keep `RunAsNode` on or replace the launcher.

### Verify a build

```sh
app="release/mac-arm64/Awesome Downloader.app"   # release/mac/… for x64
sh scripts/check-mac-arch.sh arm64
codesign --verify --deep --strict --verbose=2 "$app"
codesign -dv --entitlements - "$app"   # Authority=Developer ID Application, TeamIdentifier, flags=…(runtime)
spctl --assess --type execute --verbose "$app"   # "accepted, source=Notarized Developer ID"
xcrun stapler validate "$app"
npx @electron/fuses read --app "$app"   # RunAsNode is Enabled
shasum -a 256 release/Awesome-Downloader-*-macOS-*.dmg
```

`spctl` and `stapler` succeed only for release builds; an ad-hoc build reports
`rejected`. `scripts/smoke-mac-app.sh "$app" arm64` launches the app, checks
RunAsNode and FFmpeg, and sends a native message through the launcher. It uses
the real `~/.awesome-downloader` and registers the native host, like any launch.

### CI

`Build release candidates` (manual dispatch) adds two macOS jobs beside the
Windows one: `arm64` on `macos-15` and `x64` on `macos-15-intel`. Each runs
`npm ci`, `npm test`, `dist:mac:<arch>` with the architecture check, signature
checks (plus `spctl` and `stapler` when signed), the launch smoke test, and
writes `SHA256SUMS-macOS-<arch>.txt`. Artifacts are named
`<signed|unsigned>-macos-<arch>-release-candidate`. The `Tests` workflow runs
`npm test` on macOS as well as Windows for every push and pull request.

### Before publishing a macOS build

A green CI run is not release readiness. For each architecture you ship, on a
real Mac of that architecture: download the DMG from the workflow artifact (so
it is quarantined), check its SHA-256, install to `/Applications`, launch
without warnings, connect the extension in Chrome and send a download through
the native host (including one that needs audio and video merged), install the
next build over it, then uninstall. Intel support stays unclaimed until it has
been tested on Intel hardware.

Dragging the app to the Trash leaves behind:

- `com.awesome.downloader.json` in each browser's `NativeMessagingHosts` folder
  under `~/Library/Application Support/`;
- `~/.awesome-downloader`: download history (`downloads.json`), settings,
  partial downloads (`parts`), Chromium caches, `NativeMessaging/` manifest
  backups and `BrowserIntegration/` (the unpacked extension the browser loads,
  and the native-host launcher);
- `~/Library/Preferences/com.awesomedownloader.desktop.plist` and
  `~/Library/Saved Application State/com.awesomedownloader.desktop.savedState`;
- the unpacked extension in each browser, until removed from its extensions page.

To remove everything, quit the app, remove the extension in the browser, then:

```sh
ELECTRON_RUN_AS_NODE=1 "/Applications/Awesome Downloader.app/Contents/MacOS/Awesome Downloader" \
  "/Applications/Awesome Downloader.app/Contents/Resources/app.asar/integration/unregister-native-host.cjs" \
  ~/.awesome-downloader/BrowserIntegration
rm -rf "/Applications/Awesome Downloader.app" ~/.awesome-downloader
rm -f ~/Library/Preferences/com.awesomedownloader.desktop.plist
rm -rf ~/Library/Saved\ Application\ State/com.awesomedownloader.desktop.savedState
```

The first command removes `com.awesome.downloader.json` from each browser's
`NativeMessagingHosts` folder (only when it names this host) and the generated
launcher files. Skip the `~/.awesome-downloader` removal to keep history and
settings for a later install.
