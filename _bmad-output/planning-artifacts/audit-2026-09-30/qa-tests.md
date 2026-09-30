# Audit Tests (Murat, TEA) – 2026-09-30

~870 Tests in 36 Workspaces. Dünn: scheduler (1617 LOC/7), worker (582/2), motion-canvas-adapter (1219/7), render (1583/14), studio store.ts ohne Unit-Tests, telemetry (280/3).

| # | Befund | Beleg | Schwere |
|---|---|---|---|
| P0-1 | Docker-Worker-Determinismustest wird in CI immer übersprungen (Image node:22-bookworm-slim nie gezogen) | packages/scheduler/test/docker.test.ts:14,83 | hoch |
| P0-2 | Piper und whisper.cpp in CI nie getestet | packages/speech/test/engines.test.ts:35,52 | hoch |
| P0-3 | Zugesagte Suiten fehlen: render/test/determinism.test.ts, render/test/e2e/, sandbox/test/security.test.ts; e2e „bitgleich“ kommt aus dem Cache | render/test/e2e.test.ts:94-97 | hoch |
| P1-4 | Keine Performance-Regression in CI; Benchmarks-Tests nur Smoke | benchmarks/test/benchmarks.test.ts:39-51 | mittel-hoch |
| P1-5 | Zeitabhängige Tests (Wall-Clock-Grenzen, feste Sleeps) | compositor.test.ts:472; worker/test/http.test.ts:119,127,134; agent/test/operations.test.ts:164; agent/test/jobs.test.ts:29 | mittel |
| P1-6 | Studio-Store ohne Unit-Tests; Screenshot-Test ohne Assertion | apps/studio/test/studio.test.ts:265 | mittel |
| P1-7 | Coordinator/Worker: falsches Token, Body-Limit, Traversal ungetestet; stdio.ts/workspace.ts ohne Tests | worker/test/http.test.ts:103 | mittel |
| P2-8 | A/V-Sync nur im Mix geprüft, nicht im MP4 | render/test/e2e.test.ts:89 | mittel |
| P2-9 | vitest sammelt keine *.test.tsx/co-located; keine Coverage-Schwellen; scripts/*.mjs ungetestet | vitest.config.ts:15 | niedrig-mittel |
| P2-10 | Schwache Assertions in Katalogen | templates/test/templates.test.ts:134,180; components/test/components.test.ts:84,99,108 | niedrig |
