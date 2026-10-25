# Release checklist

Public source and public binaries are separate release steps. Do not publish a
download asset just because a local package command succeeds.

1. Run `yarn install --immutable` and `yarn test` on Windows x64.
2. Review the source diff and export for private data and proprietary material.
3. Verify third-party license notices and provide corresponding source and build
   material for the actual bundled GPL binaries (including their linked components).
   The FFmpeg commit alone is not a complete source bundle for its external libraries.
   Mirror required source archives alongside binary release assets. Record hashes.
   Review the yt-dlp executable's bundled components too if it is included.
4. `yarn dist` builds an unsigned per-user NSIS installer. Test it on a clean
   Windows machine without Node.js: install, launch, extension setup, native handoff,
   download with audio, completion, update, and uninstall.
   On an Apple Silicon Mac, `yarn dist:mac` builds an ad-hoc signed, not notarized
   arm64 DMG. Test it on a clean Mac the same way, including the first-launch
   **Open Anyway** step. For the optional legacy YouTube resolver, place the same
   pinned yt-dlp release's `yt-dlp_macos` binary at `vendor/yt-dlp` before building.
5. Publish a **prerelease** until the clean-machine checks and known limitations
   are documented. Attach installer, checksums, notices, and required source assets.
6. Never attach research, browser profiles, diagnostics with media URLs, or user data.
7. Enable repository Issues and private vulnerability reporting. Review incoming
   pull requests; contributors do not need write/admin access to submit them.

Current gates: GitHub authentication, dependency source-distribution audit,
clean-machine installer QA, and first release publication. Code signing and browser
store publication are not configured, and macOS builds are neither Developer ID
signed nor notarized; Intel Mac builds are not produced. Do not advertise them as available.
