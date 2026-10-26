# 32-bit and legacy Windows build

A separate build track in `legacy/` produces installers for **Windows 7, 8, 8.1, 10 and 11, 32-bit (ia32) and 64-bit**.
The standard 64-bit build (Electron 44, `npm run dist`) is unchanged.

| | Standard build | Legacy build |
|---|---|---|
| Windows | 10/11 x64 | 7 SP1 / 8 / 8.1 / 10 / 11, ia32 + x64 |
| Runtime | Electron 44 | Electron 22 (Chromium 108, Node 16) |
| YouTube capture (SABR) | yes | no (reported as unavailable; direct files, HLS and other sites work) |

## Build

```powershell
cd legacy
npm install            # set npm_config_arch=ia32 first when building the 32-bit installer
npm run stage          # copies shared sources, swaps in legacy substitutions
npm run verify         # fails on APIs/syntax Node 16 or Chromium 108 do not have
npm run dist:ia32      # or dist:x64
```

`legacy/stage` and `legacy/release` are generated and git-ignored. The CI workflow `release-legacy.yml` does the same for both architectures.

## Browser extension on old browsers

The legacy build ships `manifest.legacy.json` (installed as `manifest.json`): Chrome 109 (last on Windows 7) cannot declare
`"world": "MAIN"` scripts, so `background.js` registers them dynamically. Use Chrome/Edge 102+ or Firefox ESR 115.

## Known limits (verify on real machines)

- Not testable on the CI image: install and run on Windows 7 SP1 (with KB4474419/KB4490628 updates, needed for modern installers) and a 32-bit VM.
- Browser integration compiles the native launcher with the .NET Framework `csc.exe` (4.0 preferred, 3.5 fallback). If none exists the app still starts and shows the reason.
- The bundled FFmpeg must run on the target OS; if the pinned `ffmpeg-static` build does not run on Windows 7, replace `ffmpeg.exe` with a Win7-compatible static build.
- `yt-dlp` (optional) dropped Windows 7 in mainline; use a legacy build or leave it out.

## New features (all builds, desktop and extension in sync)

- **Live downloads in the extension popup**: progress, speed, Pause/Resume/Retry/Cancel (via native host → bridge `/status`, `/control`; no URLs or credentials are exposed, removal is not allowed from the browser).
- **Popup filter and Select all** for page links and detected media.
- **Clipboard link monitor** (Tasks menu, off by default): notifies when a downloadable file URL is copied; clicking opens the batch-add dialog.
- **Up to 64 parallel connections per file** (was 32 in the engine and 16 in the settings dialog). The Settings field accepts 1-64 and suggests 8, 16, 32, 42, 56 and 64. Files are split into segments of at least 512 KB, so 64 connections need a file of about 32 MB or more, and the server must support byte ranges. Some servers limit or ban many connections per client; lower the value if downloads fail.

## Credits

- **Core application and the standard 64-bit version:** created by [Ahmad Khattak](https://github.com/AhmadKhattak1/).
- **32-bit / legacy Windows version (Windows 7, 8, 8.1) and the custom features added on top** (live extension controls, popup filter and Select all, clipboard link monitor, up to 64 parallel connections): created by **Zelvior (Faizan Raza)** - [github.com/zelvior](https://github.com/zelvior/).

Both parts remain under the project's MIT license.

## 32-bit FFmpeg

`ffmpeg-static` publishes no 32-bit Windows binary, so the ia32 build runs `legacy/fetch-ffmpeg.mjs` instead of that package's installer.
It downloads a 32-bit `ffmpeg.exe`, checks that it really is an i386 executable, and runs `ffmpeg -version` before building.
If the default download links stop working, set the repository variable `FFMPEG_IA32_URL` (Settings > Secrets and variables > Actions > Variables)
to a direct link to a 32-bit `ffmpeg.exe`, `.gz` or `.zip`. For Windows 7, use a build that supports it.
