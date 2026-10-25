# Contributing

Issues and pull requests are welcome. This is an early Windows preview, not a
finished replacement for every commercial downloader feature.

## Development

Use Windows x64 and Node.js 22 or newer. The project uses Yarn 4 through Corepack,
which ships with Node.js; run `corepack enable` once. Fork this repository, clone
your fork, and create a branch for one focused change.

```powershell
yarn install
yarn test
yarn start
```

The download engine in `core/` is TypeScript. `yarn build` compiles it into
`dist/`; `yarn test`, `yarn start` and the packaging commands build it first.
Run `yarn format` before committing.

The legacy manual YouTube URL resolver needs the optional executable described
in THIRD-PARTY.md; the browser-capture path does not invoke it.

Run `yarn package` to build the unpacked app or `yarn dist` for a local
Windows installer. These commands do not publish a release. Review
[release requirements](docs/RELEASING.md) before distributing binaries.

## Pull requests

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
