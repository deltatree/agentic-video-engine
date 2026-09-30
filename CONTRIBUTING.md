# Contributing to OpenVideo

[Deutsche Fassung](CONTRIBUTING.de.md)

Thank you for your interest. This page explains how to contribute a change.
It applies to humans and to coding agents (short version for agents: [AGENTS.md](AGENTS.md)).

## Requirements

- Node.js 22.13 or newer
- FFmpeg 6 or newer (CI uses 7.1) in `PATH` or in `OPENVIDEO_FFMPEG`
- Chromium for Playwright: `npx playwright install chromium chromium-headless-shell`
- Optional: Blender 4.2 LTS (`OPENVIDEO_BLENDER`), Docker (sandbox and workers), Piper or espeak-ng, whisper.cpp

`openvideo doctor` shows what is missing.

## First steps

1. Clone the repository.
2. Install the dependencies: `npm ci`.
3. Build all packages: `npm run build`.
4. Run all checks: `npm run check`.

`npm run check` checks dependency rules, build, lint (including the examples), generated docs and their numbers, licenses and tests.

## Contributing a change

1. Open an issue or comment on an existing one.
2. Create a branch from `main`.
3. First write a test that shows the desired behavior.
4. Change the code until the test is green.
5. Run `npm run check`.
6. Open a pull request. Describe what changes and why.

Keep pull requests small. One change should do one thing.

## Code rules

| Rule | Example |
|---|---|
| Strict TypeScript: no `any`, no `as` except `as const`, no `!` | Use `isRecord` and `conforms` from `@agentic-video/core`. |
| Errors are `OpenVideoError` with a code and suggestions | `code: 'OV_ASSET_MISSING'`, `suggestions: ['Run asset.import …']` |
| Every exported function has TSDoc with `@example` | see `packages/core/src/patches.ts` |
| No `Date.now()` and no `Math.random()` in render paths | Randomness only via `random(seed, …)` |
| Packages import only allowed packages | Rules in `scripts/dependency-rules.json` |
| Node modules with prefix | `import { readFile } from 'node:fs/promises'` |

The binding render semantics are in `docs/reference/node-semantics.md`.
Architecture decisions are in `docs/adr/`.

## Tests

- Tests live in `packages/<package>/test/*.test.ts` or `*.test.tsx` (Vitest), also next to the code under `src/`.
- Golden images live in `packages/<package>/test/golden/`.
  Regenerate them with `UPDATE_GOLDENS=1`. Look at every new image before you commit it.
- A test that needs a missing program is skipped with a reason:
  `it.skipIf(skipUnless(available, 'reason and fix'))` from `@agentic-video/testing`.
  CI sets `OPENVIDEO_REQUIRE_ALL=1`; there every such skip is an error (exception: GPU, `allowInCi`).
- No fixed sleeps: wait for promises or `expect.poll`, use injectable clocks. Hard time limits
  only with `it.skipIf(!perfStrict())` (they run nightly with `OV_PERF_STRICT=1`).
- `npm run test:coverage` measures coverage; the minimum per package is in `vitest.config.ts`
  and is only ever raised.
- Run a single package like this: `npx vitest run packages/core/`.
  Mind the trailing slash. Otherwise `packages/render` also matches `renderer-*`.

## Documentation

- English first: `README.md`, `AGENTS.md`, `llms.txt`, `docs/ai/`, `docs/guide/`, `docs/reference/`, example READMEs,
  this file, `SECURITY.md` and `deploy/README.md`. Where a German version exists it sits next to the file as `*.de.md`;
  both link to each other and keep identical JSON, JSONC and TSX blocks (`packages/render/test/docs.test.ts`).
  Change both versions in the same pull request.
- `docs/ai/capabilities.json`, `docs/guide/api.md`, `docs/guide/cli.md`, the examples in
  `docs/reference/node-semantics*.md` and `packages/mcp/src/agents-doc.ts` are generated:
  `npm run build && node scripts/generate-docs.mjs`. `node scripts/generate-docs.mjs --check` fails when they are stale.
- `node scripts/check-doc-numbers.mjs` fails when README, AGENTS or llms.txt name other counts of operations,
  node types, components, templates or blend modes than `docs/ai/capabilities.json`.
- The TypeDoc API reference is published by `.github/workflows/docs.yml`; `npm run docs` writes it locally to `docs/api/`.

## Language

- Comments, TSDoc and ADRs are in German.
- Identifiers, code and user-facing error messages are in English.
- User documentation is English first (see above).

## Security vulnerabilities

Do not report security vulnerabilities as a public issue. Read [SECURITY.md](SECURITY.md).

## License

By contributing you agree that your contribution is licensed under Apache-2.0.
New runtime dependencies need an OSI license. `npm run licenses` checks that and regenerates `licenses.json`, `THIRD_PARTY_NOTICES.md` and `sbom.cdx.json`; commit them. If you change dependencies or `deploy/docker/Dockerfile`, `node scripts/licenses.mjs --check` (part of `npm run check` and CI) fails otherwise.
