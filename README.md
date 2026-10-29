# Awesome Downloader

A Windows download manager with a compact desktop interface and browser video
buttons. Original open-source implementation; not affiliated with Internet
Download Manager and not a complete feature-for-feature replacement.

**Early preview:** Private/sign-in-required, DRM and live media are unsupported. Please report bugs
without sharing session tokens or signed media links.

## Just want to use it?

Download **Awesome-Downloader-Setup.exe** from the project's
[Windows preview release](https://github.com/Ahmadkhattak1/awesome-downloader/releases/tag/v0.1.0-preview.4),
then see the [installation and usage guide](docs/INSTALL.md). It is a normal
Windows installer with Start-menu and
desktop shortcuts. No GitHub account, Node.js, or developer tools are needed for
the desktop app.

The installer is currently an unsigned preview. Browser video buttons require
one manual "Load unpacked" setup; browser-store listings are not available.

## Features

- HTTP(S) downloads with up to 64 parallel ranges per file where the server supports them.
- Pause/resume for supported transfers, history, scheduling and speed limits.
- Chrome, Edge, Brave, and Opera media detection and quality selection; selected video/audio tracks
  are combined locally with FFmpeg.
- Download File Info with save location, category, Download Later, Start and Cancel.
- Separate progress and completion windows, duplicate-active-download prevention.

YouTube uses captured browser-session data and the GoogleVideo SABR transport
library. It is not a promise of universal site support or DRM circumvention.
The legacy manual watch-URL resolver optionally uses yt-dlp; browser quality
selection does not invoke it. Firefox YouTube capture has not reached parity.

## Develop

On Windows x64 with Node.js 22+:

```powershell
npm ci
npm test
npm start
```

`npm run package` builds the unpacked application. `npm run dist` builds a local
NSIS installer, without publishing. `npm run dist:portable` builds a portable
executable. See [release requirements](docs/RELEASING.md) before distributing
either. Current builds are unsigned and have no auto-updater.

The optional legacy extractor is described in [THIRD-PARTY.md](THIRD-PARTY.md).
Do not commit its executable. `npm ci` installs the locked media dependencies.

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

## Credits

- **Core application and the standard 64-bit version:** created by [Ahmad Khattak](https://github.com/AhmadKhattak1/).
- **32-bit / legacy Windows version (Windows 7, 8, 8.1) and the custom features added on top** (live extension controls, popup filter and Select all, clipboard link monitor, up to 64 parallel connections): created by **Zelvior (Faizan Raza)** - [github.com/zelvior](https://github.com/zelvior/).

Both parts remain under the project's MIT license.

## Privacy and licensing

Media request credentials are held in memory, not stored in download history.
History and browser-integration configuration are stored locally in
`%USERPROFILE%\.awesome-downloader`. The bridge is authenticated and loopback-only.
Do not publish this directory or browser profiles in issues.

Original project code is [MIT licensed](LICENSE). Third-party components retain
their own licenses, including GPL-covered FFmpeg components; see
[THIRD-PARTY.md](THIRD-PARTY.md). Proprietary binaries, extracted evidence, local
research and test screenshots are not part of the public source.
Only download content you are permitted to save.

## Any file, any site, browser takeover

- **Browser downloads go through Awesome Downloader by default** (like IDM). Every `http(s)` file type is handed to the
  desktop app; the browser copy is canceled only after the app accepts it. Exclude sites or types (`example.com, .pdf`)
  in the extension popup, or switch the takeover off there.
- **Any video page:** use the extension's *Download this page's video* button, the button over a player, the right-click
  menu, or tick *This address is a web page* in Download File Info. yt-dlp (bundled, SHA-256 verified at build time)
  finds the best streams, ffmpeg merges them; pick quality (up to 4K / 1080p / 720p / audio only) and container
  (MP4, MKV, WebM, MP3, M4A, FLAC, WAV). A page without a video is saved as a normal file.
- **Streams:** progressive files (mp4, mkv, flv, avi, ts, ...), HLS, and DASH `.mpd` manifests are supported.
- **Not possible:** DRM-protected streams (Widevine / PlayReady / FairPlay, e.g. Netflix, Disney+) are refused with a
  clear message; this app does not and will not circumvent DRM. Some sites also need you to be signed in.
