# AGENTS.md – working on this repository

This file is for coding agents that change OpenVideo itself.
To **use** OpenVideo (create, patch and render videos), read [docs/ai/AGENTS.md](docs/ai/AGENTS.md) instead.
Humans: [CONTRIBUTING.md](CONTRIBUTING.md) has the same rules in long form.

## Setup and commands

Node.js 22.13+, FFmpeg in `PATH` or `OPENVIDEO_FFMPEG`/`OPENVIDEO_FFPROBE`, Chromium via `npx playwright install chromium chromium-headless-shell`.

| Task | Command |
|---|---|
| Set up from scratch | `npm run setup` (npm ci, build, Chromium, links `openvideo`; see [SETUP.md](SETUP.md)) |
| Install | `npm ci` (never add dependencies without a reason in the PR) |
| Build everything | `npm run build` |
| Build one package | `npx tsc -b packages/<name>` |
| Test one package | `npx vitest run packages/<name>/` (trailing slash: `packages/render` also matches `renderer-*`) |
| Test the examples / scripts | `npx vitest run examples` / `npx vitest run scripts` |
| Lint | `npm run lint` (strict `tsc` for tests, Studio and examples, then ESLint with `--max-warnings 0`) |
| Dependency rules | `node scripts/check-deps.mjs` (allowed imports in `scripts/dependency-rules.json`) |
| Regenerate docs | `node scripts/generate-docs.mjs` (after `npm run build`; when operations, node types, components, templates, CLI help or `docs/ai/AGENTS.md` change) |
| Docs drift gate | `node scripts/generate-docs.mjs --check && node scripts/check-doc-numbers.mjs` |
| Everything CI checks | `npm run check` |
| Regenerate golden images | `UPDATE_GOLDENS=1 npx vitest run packages/<name>/` – then look at every changed PNG |

Changes to the schema regenerate `packages/schema/openvideo.schema.json` during `npm run build`; commit it.

## Code rules (short)

- Strictest TypeScript: no `any`, no `as` (except `as const`), no `!`, no `@ts-ignore`, no empty `catch`. Use type guards (`isRecord`, `conforms` from `@agentic-video/core`).
- Errors are `OpenVideoError` with `code` (`OV_<AREA>_<NAME>`), `errorClass`, `problem` and concrete `suggestions`.
- Every exported function or class has TSDoc with `@example`.
- No TODO placeholders, fakes or mocks in product code; what does not work is reported as a capability limitation with a diagnostic.
- Determinism: no `Date.now()`, `Math.random()` or wall clock in render paths; randomness only via `random(seed, …)`.
- Imports between packages only via `@agentic-video/<name>`; Node modules with the `node:` prefix. No `console.log` in libraries.
- Language: comments, TSDoc and ADRs in **German**; identifiers, code and user-facing error messages in **English**.
- Every fix gets a test that fails without it. Golden images change only with a reason and a visual check.
- A test that needs a missing program uses `it.skipIf(skipUnless(available, 'reason'))` from `@agentic-video/testing`, never a silent skip (CI sets `OPENVIDEO_REQUIRE_ALL=1`).
- Binding render semantics: `docs/reference/node-semantics.md`. New architecture decisions: `docs/adr/NNNN-*.md` (next free number, German) plus an entry in `docs/adr/README.md`.

## Documentation rules

- English first (`README.md`, `AGENTS.md`, `llms.txt`, `docs/ai/`, `docs/guide/`, `docs/reference/`, example READMEs, `CONTRIBUTING.md`, `SECURITY.md`, `deploy/README.md`). German versions sit next to a file as `*.de.md`; update both, keep JSON/JSONC/TSX blocks identical and the mutual links intact (`packages/render/test/docs.test.ts`).
- Never edit generated files by hand: `docs/ai/capabilities.json`, `docs/guide/api.md`, `docs/guide/cli.md`, the node examples in `docs/reference/node-semantics*.md`, `packages/mcp/src/agents-doc.ts`.
- When behavior changes, update README, `docs/`, package READMEs and `docs/ai/AGENTS.md` in the same change.

## Layout

| Path | Content |
|---|---|
| `packages/*` | The `@agentic-video/*` packages (dependency direction in `scripts/dependency-rules.json`, ADR 0014) |
| `apps/studio` | OpenVideo Studio (browser app, copied into the CLI package by `npm run build`) |
| `examples/` | Five example projects with tests, `plugin-hello`, the DoD run, `mcp.json` |
| `docs/` | Agent guide, guides, reference, ADRs, DoD report |
| `deploy/` | Dockerfile, Kubernetes overlays, deployment tests |
| `scripts/` | Build, docs generator, drift gates, licenses, release |
| `_bmad-output/` | Planning artifacts (PRD, architecture, epics, audits; German) |
