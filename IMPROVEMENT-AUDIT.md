# Improvement Audit — awesome-downloader

Date: 2026-10-28

## Repository identity and remotes

- Contributor fork: `frpboy/awesome-downloader`, public, writable by authenticated account `frpboy`.
- Canonical upstream: `Ahmadkhattak1/awesome-downloader`, public, read-only to this connection. Do not push directly to upstream; submit PRs from the fork.
- Default branch: `main`.
- Fork baseline SHA: `c4c795f49bad56f2e85adccb399bc7a2087d7f0e`.
- Technology: Node.js 22+, JavaScript/ES modules, Electron 44.x, Chromium MV3 / Firefox browser extension manifests, HTTP segmented download engine, HLS muxing through FFmpeg, YouTube/SABR integration and native messaging host.
- Product stage: unsigned Windows x64 preview; no auto-updater and no Chrome/Edge store listings.

## Contribution rules

`CONTRIBUTING.md` and `docs/CONTRIBUTOR-START-HERE.md` require contributors to select an approved issue and agree with the maintainer on scope and ownership before new feature implementation. Keep PRs focused, add regression tests, distinguish fixture checks from live browser or real-device validation, do not commit cookies, tokens, signed media URLs or profiles, and do not expose release secrets to untrusted PR code. Respect prerequisite ordering; never push directly to upstream default branch or bypass review.

## Current activity and duplicate check

The fork currently has two security PRs that were submitted upstream:

- Upstream PR #49: strip Referer on cross-origin redirects and add a regression test. Head `5496a292e095a6fdfe6f5c0df7b8267188a9c578`.
- Upstream PR #50: upgrade Electron to `44.9.1`, keep manifest/lockfile aligned. Head `6973546d5aadb0a378ccc1fdcd3410dd0c3f01d6`.

Other relevant upstream work at audit time:

- #47 HLS/HTTP/file-handle/native-host and Firefox manifest fixes.
- #45 classify HTTP retries and respect Retry-After.
- #46 explain when resume restarts.
- #37 YouTube transfer metering and browser handoff.
- #33/#36 platform/tooling migration overlap.
- #35/#39 Linux/macOS changes with dependency-order concerns.

The GitHub Actions runs for #49 and #50 reported `action_required`, not passed. Do not report CI success on that basis. PR #47 touches several same implementation files, so avoid overlapping implementation until its current result is resolved.

## Strong implementation candidates

1. **Privacy of persisted media URLs.** `core/engine.mjs` removes headers and SABR data from saved state, but serializes the full download URL. Browser-captured media URLs may contain temporary query credentials. Sensitivity depends on the URL; treat this as a high-confidence persistence path, not proof that every URL is a credential. Extend issue #15/design with maintainer agreement. Separate ephemeral transfer URL from history display URL and test migration/resume carefully.
2. **Reproducible yt-dlp binary inputs.** `.gitignore` ignores `vendor/*.exe`; `core/youtube.mjs` expects `vendor/yt-dlp.exe` in development and `package.json` packages it. The visible release workflow does not fetch and verify this binary. Verify provenance, hash and intended optionality before implementing.
3. **FFmpeg corresponding source.** `THIRD-PARTY.md` and `docs/RELEASING.md` explicitly say corresponding-source/build material for the actual bundled FFmpeg binary and linked libraries is incomplete. Release/legal owner review is required before redistribution. Coordinate with #41 rather than duplicating release automation work.
4. **Malformed history recovery.** `DownloadEngine.init()` catches missing history but throws for malformed JSON or other read errors; Electron startup then exits. Add non-destructive backup/recovery and schema validation only after maintainer agreement on data-loss semantics.
5. **Clean-machine release QA.** The current workflow is manual and uploads an artifact with a short retention. Existing #41 covers tag-driven installer build and draft release; extend that issue with install/upgrade/uninstall/browser-handoff checks rather than creating another issue.
6. **Electron version policy.** PR #50 currently says `44.9.1` while PR #36 references `44.9.3`. Resolve the version policy with upstream maintainers and official release/security evidence before opening a second update PR. Do not repeat the previous unverified CVE attribution.
7. **Browser-session lifecycle.** The extension has bounded per-tab request-context and SABR maps, but cleanup behavior needs event-by-event verification before calling it a bug. An investigation, not a confirmed leak.
8. **YouTube capture failure.** Existing issue #42 describes a user-visible symptom; source review alone did not establish the root cause. Diagnose with sanitized reproduction and keep work in #42.

## Existing issue areas — avoid duplicates

- #12 throughput baselines and bursty YouTube behavior.
- #13 safe contributor CI/regression checks.
- #15 interrupted transfer, expired URLs and recovery.
- #16 browser handoff.
- #17 extension interactions.
- #18 progress/completion interactions and multi-select.
- #20 bounded website/link grabbing.
- #40 native host missing on Windows/Chrome.
- #41 release workflow.
- #42 YouTube session-capture failure.

## Backlog access / limitations

The open upstream issues endpoint returned 30 non-PR issues and the open PR endpoint returned 11 PRs when inspected. The labels/milestones endpoints were not accessible via the connector. While recent commit history and relevant open/closed PRs were inspected, an exhaustive paginated all-time issue history could not be independently confirmed. No local working-tree inspection or local test/build execution was available in this connector-only workflow. Suggestions remain proposals until tests and maintainer approval occur.

## Current audit status

- Repository/fork/upstream identity verified.
- Source, contributor docs, release docs, workflows and relevant PRs reviewed via GitHub.
- No new upstream issue created during discovery.
- No code fix implemented by this documentation change.
- No tests claimed as passing.
