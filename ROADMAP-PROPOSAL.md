# Roadmap Proposal — Awesome Downloader
For maintainer review; not a committed project roadmap.

## Phase 0 — review conflicts and verify exact heads
- Review #47 for engine/HTTP/mux/Firefox/native-host overlap.
- Reconcile #49/#50; their latest Actions runs were `action_required`, not confirmed passes.
- Resolve Electron selection between #50 (44.9.1) and #36 (44.9.3) against official release notes and compatibility; no unverified CVE claim.
- Reconcile #33/#35/#36/#39 with dependency order #14 and focused PR expectations.
**Gate:** maintainer agrees merge order and every relevant check runs against exact head.

## Phase 1 — high-risk privacy and state integrity
1. S01: discuss URL persistence with #15/#16; design ephemeral-vs-history split and resume behavior.
2. S02: approve non-destructive history recovery UX, backups and schema policy.
**Gate:** tests cover redaction, migration, restart/resume, corrupt data, future version, and preserve-original behavior.

## Phase 2 — reproducible package inputs and CI
1. S03: verify yt-dlp source, version, hash, license and optionality.
2. Extend #13 for safe contributor regression checks; never expose release secrets to fork PRs.
3. Extend #41 for tag-triggered build/checksum/draft candidate but keep public promotion manual.
**Gate:** clean Windows checkout builds intended artifact reproducibly; missing binary or mismatch fails clearly.

## Phase 3 — release compliance and clean-machine QA
1. S04: match corresponding source/build materials to the actual FFmpeg executable and linked libraries.
2. S05: clean machine without Node.js validates install, launch, browser handoff, direct fixture download, upgrade, uninstall.
3. Consider SBOM/binary inventory as a separate release manifest after format and ownership approval.
**Gate:** release owner approves exact artifact’s licenses, source bundle, hash and clean-machine results before redistribution.

## Phase 4 — user-facing reliability
- #42 YouTube session capture: reproduce safely and isolate boundary, don't infer cause from symptom.
- #40 native host: investigate clean install/restart; coordinate with #47.
- #15/#45/#46 retry/resume: validate changed-resource/cancel/Retry-After cases.
- #12/#37 throughput: benchmark first; don't invent metrics or tune concurrency blindly.
- #16/#17/#18 handoff/extension/desktop UX: keep each issue/PR slice focused.
**Gate:** reproduction + regression test, plus separately described fixture and live-browser evidence.

## Phase 5 — approved platform/product expansion
- #14 before Linux #22/#23, macOS #24/#25 and Windows ARM64 #26/#27.
- Firefox #28 before #29.
- Playlist #30 before #31.
- Agree scope before #19 queues/scheduling, #20 link grabbing or extension store/update work.
**Gate:** target OS/browser/hardware validation and release assets exist before claiming support.

## Priority shortlist
P1: S01 URL persistence, S03 reproducible vendor binary, S04 matching source bundle, S02 history recovery, S05 clean-machine smoke. Advance existing #42/#40/#12/#15/#13/#41 in parallel through their current issues.
P2: S06 header-scope investigation, S14 dependency cadence, S15 diagnostic export, S16 accessibility, S17 extension distribution strategy.
P3: platform and feature expansion only after dependency acceptance.
