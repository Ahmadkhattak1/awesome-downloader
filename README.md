# Awesome Downloader

A desktop download manager with a compact interface and browser video buttons.
Runs on Windows 10/11 and Linux x64. Original open-source implementation; not
affiliated with Internet Download Manager and not a complete feature-for-feature
replacement.

**Early preview:** Private/sign-in-required, DRM and live media are unsupported. Please report bugs
without sharing session tokens or signed media links.

## Just want to use it?

Download **Awesome-Downloader-Setup.exe** from the project's
[Windows preview release](https://github.com/Ahmadkhattak1/awesome-downloader/releases/tag/v0.1.0-preview.4),
then see the [installation and usage guide](docs/INSTALL.md). It is a normal
Windows installer with Start-menu and
desktop shortcuts. No GitHub account, Node.js, or developer tools are needed for
the desktop app.

Linux x64 builds are produced from source as an AppImage and a Debian package
(`npm run dist:linux`); see the [Linux instructions](docs/INSTALL.md#linux) in the
same guide. Build artifacts appear in `release/`.

The Windows installer and Linux builds are currently unsigned previews. Browser video buttons
require one manual "Load unpacked" setup; Chrome/Edge store listings are not
available.

## Features

- HTTP(S) downloads with parallel ranges where the server supports them.
- Pause/resume for supported transfers, history, scheduling and speed limits.
- Chrome/Chromium/Edge media detection and quality selection; selected video/audio tracks
  are combined locally with FFmpeg.
- Download File Info with save location, category, Download Later, Start and Cancel.
- Separate progress and completion windows, duplicate-active-download prevention.

YouTube uses captured browser-session data and the GoogleVideo SABR transport
library. It is not a promise of universal site support or DRM circumvention.
The legacy manual watch-URL resolver optionally uses yt-dlp; browser quality
selection does not invoke it. Firefox YouTube capture has not reached parity.

## Develop

On Windows x64 or Linux x64 with Node.js 22+:

```sh
npm ci
npm test
npm start
```

`npm run package` builds the unpacked application. `npm run dist` builds a local
NSIS installer, without publishing. `npm run dist:portable` builds a portable
executable. On Linux, `npm run package:linux` builds the unpacked application and
`npm run dist:linux` builds an AppImage plus a Debian package. See
[release requirements](docs/RELEASING.md) before distributing either. Current
builds are unsigned and have no auto-updater.

The optional legacy extractor is described in [THIRD-PARTY.md](THIRD-PARTY.md).
Do not commit its executable. `npm ci` installs the locked media dependencies.
On Linux, install the extractor with your package manager (for example
`sudo apt install yt-dlp`) or place an executable named `yt-dlp` in `vendor/`.
The app falls back to a distribution FFmpeg automatically when the bundled
static binary cannot handle an input; install it with `sudo apt install ffmpeg`.
Set `AWESOME_FFMPEG_PATH=/path/to/ffmpeg` to force a specific executable.

## Contribute

**New contributor? Start with the [contributor guide and roadmap](docs/CONTRIBUTOR-START-HERE.md).**
It explains the current project stage, issue labels, dependency order and how
to agree on a task before coding. Major goals are delivered through focused,
reviewed PRs; planned platform support is not yet released support.

Bug reports, tests, documentation and pull requests are welcome. See
[CONTRIBUTING.md](CONTRIBUTING.md) and [SECURITY.md](SECURITY.md).
You can fork the project and submit a pull request without repository write access.

High-priority work: YouTube throughput and session refresh, clean-machine
installer testing, browser-store packaging, and accessibility.

## Privacy and licensing

Media request credentials are held in memory, not stored in download history.
History and browser-integration configuration are stored locally in
`~/.awesome-downloader` (`%USERPROFILE%\.awesome-downloader` on Windows). The
bridge is authenticated and loopback-only.
Do not publish this directory or browser profiles in issues.

Original project code is [MIT licensed](LICENSE). Third-party components retain
their own licenses, including GPL-covered FFmpeg components; see
[THIRD-PARTY.md](THIRD-PARTY.md). Proprietary binaries, extracted evidence, local
research and test screenshots are not part of the public source.
Only download content you are permitted to save.
