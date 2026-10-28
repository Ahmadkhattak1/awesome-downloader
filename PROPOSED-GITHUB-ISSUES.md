# Proposed GitHub Issue Drafts — Awesome Downloader
Drafts only; do not post duplicates. Contribution guide requires maintainer agreement on new feature scope/ownership before implementation. Never include signed URLs, cookies, Authorization headers, browser profiles or private diagnostics.

## Existing items to extend
- #42 YouTube session capture symptom.
- #40 native messaging host missing.
- #15 transfer recovery/expired links, with PRs #45 and #46.
- #12 throughput, with PR #37.
- #13 safe CI.
- #41 release automation.
- #16 browser handoff; #17 extension UX; #18 keyboard/desktop UX.
- #14 shared adapters and children #22–#27.
These should not be duplicated.

## D01 — Keep signed browser-media URLs out of persisted history
**Suggested labels:** bug, help wanted. **Priority:** P1. **Related:** S01, #15/#16.
**Evidence:** `DownloadEngine.persist()` omits headers and SABR but retains full URL; browser-captured stream URLs may contain temporary signed parameters. This confirms a persistence path, not that every URL is sensitive or exploitation occurred.
**Approach:** Define persisted URL policy; separate redacted display source from ephemeral transfer URL and preserve safe direct-download resume behavior.
**Acceptance:** representative signed URLs not stored verbatim; headers/SABR/cookies/Auth remain absent; direct URL behavior stays correct; migration is non-destructive; diagnostics/exports also redact.
**Tests:** serialization and restart/resume tests, synthetic URL parameters, logs, ordinary HTTP/S URL behavior.
**Risk/readiness:** may change resume; maintainers must agree policy. Prefer updating #15 if maintainers deem it same root cause.

## D02 — Recover safely from corrupt or unsupported download history
**Suggested labels:** bug, help wanted. **Priority:** P1.
**Evidence:** history parse/read failures other than ENOENT throw from init and cause startup to quit.
**Approach:** preserve original, make unique backup, validate schema/version and provide explicit restore/reset or safe read-only recovery.
**Acceptance:** corrupt file never silently overwritten; startup exposes recovery path; invalid history cannot inject unsafe URLs/paths; backup collisions and permission errors handled.
**Tests:** missing/truncated JSON, unsupported schema, partial bad record, backup collision, permission denied, successful restore.
**Risk/readiness:** needs maintainer-approved recovery semantics; no matching open issue found in reviewed subset.

## D03 — Make yt-dlp an explicit, verified build input
**Suggested labels:** bug, help wanted. **Priority:** P1.
**Evidence:** .gitignore excludes vendor/*.exe; runtime/package expects yt-dlp.exe; observed workflow does not fetch/hash it.
**Acceptance:** required/optional behavior documented; pinned release and SHA verified before packaging/execution; clean checkout produces intended package or clear error; binary license/provenance matches exact artifact.
**Tests:** clean Windows packaging, missing binary, successful download/hash, tampered hash.
**Risk/readiness:** supply-chain/redistribution review; verify exact provenance before implementation. Coordinate #41.

## D04 — Complete matching FFmpeg corresponding-source/build materials
**Suggested labels:** documentation, help wanted. **Priority:** P1.
**Evidence:** THIRD-PARTY.md and docs/RELEASING.md explicitly say matching source/build material for actual binary and linked libraries is incomplete.
**Acceptance:** actual shipped binary hash/version/build and linked components are inventoried; applicable corresponding source/build scripts and notices are mirrored; release manifest hashes match exact asset; release/compliance review is recorded.
**Tests:** manifest validation plus manual review of actual artifact.
**Risk/readiness:** legal/compliance decision required. Coordinate #41; generic upstream URLs are not necessarily sufficient.

## D05 — Add clean-machine Windows install/upgrade/handoff/uninstall smoke coverage
**Suggested labels:** testing, help wanted. **Priority:** P1.
**Acceptance:** on clean Windows machine without Node.js install and launch; verify browser/native host setup, fixture download and completion; upgrade previous preview and uninstall; failed smoke blocks candidate promotion; no public release automatically promoted.
**Tests:** npm ci, npm test, npm run dist and clean machine/VM workflow.
**Risk/readiness:** extend #13/#41, don't duplicate tag-trigger automation; agree on safe browser fixture/test infrastructure.

## D06 — Minimize browser request-header capture and stale context
**Suggested labels:** security, help wanted. **Priority:** P1; investigation first.
**Evidence:** manifest broadly matches HTTP/S and background map captures selected request headers in bounded memory. Authenticated media support is an existing requirement; no exploit is confirmed.
**Acceptance:** documented data-flow/least-privilege assessment; tab/reload lifecycle tests; unrelated URLs/headers not retained; in-flight download still works.
**Tests:** browser mocks for allowed host, lifecycle cleanup and legitimate captured media.
**Risk/readiness:** must preserve functionality and be maintainer-approved; coordinate #16/#17/#28/#29 before creating issue.

## D07 — Add opt-in privacy-safe diagnostic export for browser integration failures
**Suggested labels:** enhancement, help wanted. **Priority:** P2.
**Problem/opportunity:** #40/#42 are hard to diagnose, but no support burden data was found.
**Acceptance:** explicit user action; allowlisted codes/versions/timestamps only; remove query strings, tokens, cookies, paths and profile data; preview before save; redaction tests verify known secrets absent.
**Tests:** synthetic diagnostics with token, signed URL and filesystem path; ensure export doesn't contain any values.
**Risk/readiness:** needs maintainer/privacy agreement; could be folded into #40/#42 rather than new issue.
