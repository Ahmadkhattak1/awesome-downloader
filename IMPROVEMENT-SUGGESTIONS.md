# Improvement Suggestions — Awesome Downloader
Date: 2026-10-28. See IMPROVEMENT-AUDIT.md for source locations and validation limitations.

## Evidence/readiness key
**Verified** means the code/docs show the behavior. **Hypothesis** means runtime impact still needs reproduction. No issue should be created for a tracked item unless it extends the current ticket; no implementation proceeds without maintainer agreement required by CONTRIBUTING.md.

| ID | Suggestion / category | Priority / confidence | Evidence and proposed value | Effort / risks | Tracking and readiness |
|---|---|---|---|---|---|
| S01 | Separate signed media URLs from persisted history (security/privacy) | P1 / high for persistence path; medium for URL sensitivity | core/engine.mjs omits headers/SABR from saved record but retains url; captured media URL can contain temporary access parameters. Reduces exposure in backups/history. | M (2–4d); can break resume if URL redaction is naive. Add versioned migration and resume tests. | New candidate; coordinate with #15/#16; needs design/investigation. |
| S02 | Recover non-destructively from corrupt/future-version history (reliability) | P1 / high | DownloadEngine.init() throws on parse/read errors other than ENOENT; startup quits. Preserve original, backup, validate schema, present recovery options. | M (2–4d); user-data loss risk if recovery is silent. | New candidate; no matching open issue found in reviewed issue list; maintainer UX decision first. |
| S03 | Make ignored yt-dlp binary reproducible (release engineering) | P1 / high for missing acquisition automation; clean-build impact unverified | .gitignore excludes vendor/*.exe; core/youtube.mjs expects vendor/yt-dlp.exe; package config includes it; release workflow shows no fetch/hash verification. | M (2–4d); verify provenance, version, hash and optionality. | New candidate; coordinate #41 but distinct from tag-trigger behavior; investigation first. |
| S04 | Complete corresponding-source/build materials for FFmpeg (release compliance) | P1 / high | THIRD-PARTY.md and docs/RELEASING.md explicitly state the full matching source/build materials for actual FFmpeg binary and linked libraries are incomplete. | L (1–2w); exact legal obligations depend on shipped binary. | Coordinate #41; release/compliance owner approval required. |
| S05 | Clean-machine Windows install/upgrade/handoff/uninstall smoke tests (testing) | P1 / high | Workflow currently runs npm ci/npm test; release docs require manual clean-machine testing. | L (1–2w); Windows VM/browser setup and fixture handling. | Extend #13/#41; no duplicate; needs test-environment design. |
| S06 | Reduce extension request-header capture scope (security/privacy) | P1 / high for broad scope, medium for impact | extension manifest broadly matches HTTP/S and background tracks Cookie/Auth/Referer/Origin in bounded in-memory contexts. Existing behavior supports authenticated media; no exploit confirmed. | L (1–2w); reducing scope can break sites. | Investigation/maintainer approval; coordinate #16/#17/#28/#29. |
| S07 | Diagnose YouTube session-capture failure (bug) | P1 / medium | Existing user report #42; source review has not established root cause. | M (2–5d); live site variability. | Use #42; no duplicate; reproduce safely without session data. |
| S08 | Repair native-messaging host registration failures (reliability) | P1 / medium-high | Existing report #40; active PR #47 changes registration. | M (2–5d); Windows-specific paths/registration. | Use #40 and review #47/#13; no duplicate. |
| S09 | Expand safe contributor CI (testing/security) | P1 / high | test.yml only runs npm ci and npm test; #13 already defines renderer, bridge and transfer checks. | M–L (4–8d); keep fork PR permissions read-only, no release secrets. | Extend #13; no duplicate. |
| S10 | Tag-triggered release-candidate build (release engineering) | P1 / high | release.yml is workflow_dispatch and holds 7-day artifact; #41 tracks draft-release automation. | M (2–4d); public release must stay maintainer-controlled. | Extend #41; no duplicate. |
| S11 | Finish bounded retries and truthful resume behavior (reliability) | P1 / high | Existing #15 and active PRs #45/#46 split retry classification and restart message. | M (3–6d incl tests); reconcile shared engine changes. | Validate existing work; do not duplicate. |
| S12 | Measure/fix throughput and bursty YouTube transfers (performance) | P1 / high for reported problem, cause empirical | #12 requests baselines; #37 changes meter/handoff. | M–L (1–2w); don't invent benchmark numbers or tune without measurements. | Extend #12 and review #37. |
| S13 | Split/sequence cross-cutting platform/toolchain PRs (architecture) | P1 / high | Contributor roadmap defines #14 adapter prerequisite; PRs #33/#35/#36/#39 overlap or mix scopes. | S–M triage; implementation varies. | Maintainer review; use existing #14/#22–#27 and PR discussions. |
| S14 | Document Electron/npm dependency cadence (release engineering) | P2 / high | PR #50 selects 44.9.1 while #36 references 44.9.3; version policy/CI should be reconciled. No CVE claim is asserted. | S–M (1–4d); target must be checked against official release notes. | Existing PRs #50/#36; maintainer decision first. |
| S15 | Privacy-safe opt-in diagnostics (UX/supportability) | P2 / medium | Could help #40/#42, but no support-burden metrics exist. | M (3–6d); strict allowlist/redaction required. | Needs maintainer approval and privacy data dictionary; don't include signed URL/cookies. |
| S16 | Fix nested interactive semantics and keyboard/screen-reader workflows (accessibility) | P2 / high markup evidence; impact needs validation | Renderer includes nested interactive semantics; #18 and README identify keyboard/accessibility priorities. | M (3–5d); don't rely on automated scan alone. | Extend #18/#13, coordinate #47 renderer changes. |
| S17 | Secure extension distribution/update strategy (product/security) | P2 / high current limitation | README confirms manual unpacked setup and no store listing/updater. | L (2–4w); store policy, signing, permissions and release authenticity. | Maintainer approval; coordinate browser/platform goals. |
| S18 | Gate platform expansion on shared adapters/hardware acceptance (architecture/release) | P2 / high | Dependency graph requires #14 before platform children; open PR scope overlaps. | M for triage, L platform work. | Existing #14, #6–#8, #22–#27, #33/#35/#39; no new issue. |

## Top five
1. S01 privacy of persisted signed media URL fields.
2. S03 reproducible yt-dlp inputs on clean checkout.
3. S04 actual corresponding source/build materials before redistribution.
4. S02 non-destructive corrupt-history recovery.
5. S05 clean-machine installer smoke tests and release gates.

These do not override active prerequisites or maintainer policy. A priority rating does not equal authorization to implement.
