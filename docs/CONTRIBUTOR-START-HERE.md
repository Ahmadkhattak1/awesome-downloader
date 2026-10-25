# Contributor start here

Awesome Downloader is an early Windows x64 preview. Downloads and Chrome/Edge
integration exist, but reliability, sustained speed and user experience still
need work. Linux, macOS, Windows ARM64, broader browser support and playlists are
approved development goals, not released capabilities.

## Our strategy

Keep working downloads reliable while adding capabilities in small, reviewed
steps. Measure speed improvements and verify completed files. Build shared
platform support once, then implement and validate each operating system.
Each change should leave the existing Windows application usable.

The maintainer approves scope and merges PRs. An approved issue approves an
objective; it does not approve every possible implementation or guarantee a
merge. Propose additional features in an issue before implementing them.

## Pick your first task

1. Read the relevant goal and its acceptance criteria in the
   [issue backlog](https://github.com/Ahmadkhattak1/awesome-downloader/issues).
2. Choose a concrete implementation step. Check its prerequisites, existing PRs
   and comments so you do not duplicate another contributor's work.
3. Comment with the step you want to take, your approach, and how you will test
   it. State which operating systems/devices you can actually test.
4. Wait for maintainer agreement on scope and ownership before starting new
   feature implementation. A comment alone does not reserve the task.
5. Submit a focused PR with test evidence. If a prerequisite is unfinished, you
   may discuss or share a draft, but do not merge ahead of the dependency.

Small bug reports, documentation corrections and regression tests are welcome.
If an issue has no status label, read its discussion and ask for scope/readiness
agreement; missing labels do not mean it is automatically ready or blocked.

## What the labels mean

| Label | Meaning | What to do |
| --- | --- | --- |
| `type: goal` | A larger outcome delivered through several steps | Read it for context; choose a linked implementation issue |
| `status: ready` | No unfinished implementation prerequisite is recorded | Propose your approach and agree ownership |
| `status: blocked` | A named prerequisite must merge and pass validation first | Follow that dependency; planning is welcome |
| `help wanted` | Contributions are welcome | Still check readiness and discuss scope |
| `bug` / `enhancement` / `documentation` | The kind of work | These do not indicate priority or merge approval |
| `good first issue` | A deliberately scoped newcomer task, when applied | Read its acceptance criteria before claiming it |

Labels are maintained manually. They are not automated merge gates and may lag
behind discussions. If a label and dependency disagree, ask the maintainer to
reconcile them. Issue numbers and step numbers describe identity/order, not
priority. `help wanted` plus `status: blocked` means help is welcome once the
prerequisite is ready.

## How the goals fit together

| Goal | Implementation order |
| --- | --- |
| [Linux #6](https://github.com/Ahmadkhattak1/awesome-downloader/issues/6) | Shared adapters #14 → runtime/integration #22 → packaging/validation #23 |
| [macOS #7](https://github.com/Ahmadkhattak1/awesome-downloader/issues/7) | Shared adapters #14 → runtime/integration #24 → packaging/validation #25 |
| [Windows ARM64 #8](https://github.com/Ahmadkhattak1/awesome-downloader/issues/8) | Shared adapters #14 → runtime/dependencies #26 → installer/hardware validation #27 |
| [Firefox #10](https://github.com/Ahmadkhattak1/awesome-downloader/issues/10) | Capture/integration #28 → persistent installation/setup #29 |
| [YouTube playlists #21](https://github.com/Ahmadkhattak1/awesome-downloader/issues/21) | Discovery/model #30 → selection/queue/batch controls #31 |

The shared adapters are one task, not three copies. After #14 is merged and
validated, Linux, macOS and ARM64 implementation can proceed in parallel.
Firefox's initial Windows work and playlist discovery do not need to wait for
those ports. Brave #9 and Opera #11 start as focused Windows browser tasks;
their new-OS integration follows the relevant platform work.

Reliability work can proceed alongside these goals: measured throughput #12,
CI/regression coverage #13, interrupted-transfer recovery #15, safe handoff #16,
extension behavior #17, and desktop interactions #18. Named queues/scheduling
#19 and website grabbing #20 have their own scoped plans. The initial playlist
feature can use existing per-item queues without waiting for #19.

## Link a PR correctly

For a PR that fully completes macOS runtime step #24, use:

```text
Closes #24
Refs #7
Prerequisite: #14 (merged and validated)
```

Use `Refs #24` instead if the PR only delivers part of that step. Do not write
`Closes #7` for a single implementation step: the macOS goal also requires
packaging and end-to-end validation. One issue may need several small PRs;
several unrelated issues should not become one large PR.

After merge, the maintainer checks the evidence, updates the goal checklist,
and changes the next step from blocked to ready. A goal closes only when all
acceptance criteria are met. Publishing installers is a separate maintainer
release decision.

## Evidence and review

- Add regression coverage for behavior you change and explain what you tested.
- Distinguish fixtures, live-browser testing and real-device testing. A passing
  build does not establish support for an operating system or architecture.
- Preserve transfer integrity, audio/video pairing, cancellation, credential
  boundaries and existing Windows behavior.
- Keep credentials, signed media URLs and browser profiles out of public reports.
- Keep unrelated refactors and dependency upgrades out of focused feature PRs.
- Contributor code must not receive release secrets. Stronger automated checks
  are tracked in #13; do not assume a label enforces them today.

See [CONTRIBUTING.md](../CONTRIBUTING.md) for development commands,
[SECURITY.md](../SECURITY.md) for private vulnerability reports, and
[release requirements](RELEASING.md) for distribution checks.
