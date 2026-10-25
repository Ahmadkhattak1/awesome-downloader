# Contributing

Issues and pull requests are welcome. This is an early Windows preview, not a
finished replacement for every commercial downloader feature.

Read the [contributor start guide](docs/CONTRIBUTOR-START-HERE.md) before choosing
work. It explains our roadmap, labels and implementation order. For new feature
work, pick an approved issue and agree your approach and ownership with the
maintainer before coding. Propose features outside the backlog for approval first.

## Development

Use Windows x64 or an Apple Silicon Mac, and Node.js 22 or newer (`.nvmrc` pins the
major version, so `nvm use` picks it; CI reads the same file). The project uses Yarn 4 through Corepack,
which ships with Node.js; run `corepack enable` once. Fork this repository, clone
your fork, and create a branch for one focused change.

```powershell
yarn install
yarn test
yarn start
```

The download engine in `core/` is TypeScript. `yarn build` compiles it into
`dist/`; `yarn test`, `yarn start` and the packaging commands build it first.
Run `yarn format` and `yarn lint` before committing; CI runs both.

## Code style

The code follows the [Airbnb JavaScript Style Guide](https://github.com/airbnb/javascript),
enforced by `eslint-config-airbnb-base` in `eslint.config.mjs`. Prettier owns layout, so
Airbnb's formatting rules are turned off and `curly` is set to always require braces.
Two parts of the guide that `eslint-config-airbnb-base` does not check are enforced too:

- Descriptive names, never single letters (`id-length`; `_` is allowed for an unused
  parameter). Name values by what they are: `download`, `segment`, `format`, `index`.
- A blank line around every function, class, multi-line block and multi-line statement.

These exceptions are deliberate:

- `for...of` loops are allowed, including `for await` over streams. `for...in`, labels
  and `with` stay banned.
- `await` inside loops is allowed: retries and in-order writes are sequential on purpose.
- Download records and their segments (`d`, `segment`, …) are updated in place.
- Functions may be called before the line that declares them.
- The extension's shared script globals (`youtubeMedia`, `mediaChoices`,
  `parseHlsMaster`) are declared rather than imported.

Disable a rule only on the line that needs it, with
`// eslint-disable-next-line <rule> -- <reason>`.

The legacy manual YouTube URL resolver needs the optional executable described
in THIRD-PARTY.md; the browser-capture path does not invoke it.

Run `yarn package` to build the unpacked app or `yarn dist` for a local
Windows installer. These commands do not publish a release. Review
[release requirements](docs/RELEASING.md) before distributing binaries.

## Pull requests

- Link the implementation issue and its parent goal, and identify prerequisites.
- Use `Closes #...` only for an issue fully completed by the PR; use `Refs #...`
  for partial work and parent goals. Keep each PR focused and wait for prerequisite
  changes to merge and pass validation before merging dependent work.
- Explain the problem, the change, and how you tested it.
- Add regressions for parsing, transfers, authentication, and lifecycle changes.
- Preserve the compact Windows layout and keyboard accessibility.
- Distinguish local fixture tests from live-browser verification.
- Keep captured URLs, cookies, tokens, browser profiles, and downloads out of Git.
- Do not include proprietary IDM code, extracted binaries, or DRM bypasses.
- Do not use `pull_request_target` to run untrusted contributor code with secrets.

By contributing, you agree to license your original contributions under the MIT
license. Third-party materials must retain compatible upstream notices.

Please be respectful. Do not post private media or session data in bug reports.
