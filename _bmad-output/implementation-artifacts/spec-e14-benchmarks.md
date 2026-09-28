---
title: 'Benchmarks und Performance-Tests (Story 14.5, NFR-5 Performance)'
type: 'feature'
created: '2026-09-28'
status: 'ready-for-dev'
route: 'dispatch'
context:
  - '{project-root}/_bmad-output/implementation-artifacts/agent-rules.md'
  - '{project-root}/packages/render/src/node-env.ts'
  - '{project-root}/packages/render/src/video.ts'
  - '{project-root}/packages/render/src/frame.ts'
  - '{project-root}/packages/render/test/e2e-mixed.test.ts'
---

## Intent

**Problem:** Performance muss messbar, reproduzierbar und gegen Regressionen geschützt sein (A38, FR-94, SM-4).

**Approach:** Paket `benchmarks` erzeugt Szenario-Projekte deterministisch im Code, rendert sie mit der echten Render-Umgebung (`createNodeEnvironment`, `renderFrame`/`renderVideo` aus `@agentic-video/render`) und misst. Ergebnisse als JSON; eine eingecheckte Basis erkennt Regressionen.

## Boundaries & Constraints

**Always:**
- Paket: `packages/benchmarks` (existiert als Gerüst). Nichts anderes ändern. Eigene `bin` (`openvideo-bench`) und Skripte darfst du in dessen `package.json` anlegen.
- Szenarien (A38): `text-heavy`, `vector-heavy`, `image-heavy` (Bilder erzeugst du im Code), `video-heavy` (Testvideos per FFmpeg `lavfi`), `3d-heavy` (scene3d), `mixed` (DOM + 2D + 3D), `audio-heavy` (viele Clips, Ducking, Mastering). Auflösungen `1080p30`, `1080p60`, `4k30`, `4k60`.
- Messwerte (A38): frames/sec, Renderzeit pro Frame (Mittel, p50, p95), GPU-Auslastung und VRAM (über `nvidia-smi`, sonst `null` mit Begründung `no GPU`), CPU-Auslastung (Prozess + Kindprozesse über `/proc`, sonst Prozess), Spitzen-RAM (RSS inkl. Kindprozesse, Abtastung alle 100 ms), Cache-Trefferquote, Encoding-Durchsatz (Frames/s des Encoders), Startzeit (Umgebung bis erster Frame).
- Parallelität: Wenn `@agentic-video/scheduler` einen `createProcessChunkRunner` exportiert (Paket entsteht parallel; prüfe zur Laufzeit per dynamischem `import()` und fange das Fehlen ab), misst `--workers N` den Durchsatz mit N Prozessen; sonst nur in einem Prozess und das Ergebnis vermerkt `workers: 1`.
- Regressionserkennung: `compareToBaseline(results, baseline, { tolerance: 0.2 })` meldet Szenarien, deren fps um mehr als 20 % schlechter sind. Basisdatei `packages/benchmarks/baseline.json` (auf dieser Maschine gemessen, mit Maschinenbeschreibung). Werte einer anderen Maschine werden nicht verglichen (Diagnose statt falscher Alarm).
- Ergebnisse sind deterministisch in allem außer Zeitmessungen (gleiche Frames → gleiche Hashes, im Ergebnis mit ausgegeben).

## Anforderungen

- `runBenchmark({ scenario, resolution, frames, workers, encode })` → `BenchmarkResult`.
- `runSuite(options)` → alle Szenarien × gewählte Auflösungen; Ausgabe JSON + Markdown-Tabelle.
- `bin/openvideo-bench` mit `--scenario`, `--resolution`, `--frames`, `--workers`, `--json`, `--update-baseline`, `--compare`.
- Performance-Tests (Vitest, kurze Läufe, großzügige Grenzen, damit CI stabil bleibt): je Szenario 1080p mit wenigen Frames läuft durch und liefert plausible Werte; 4K-Frame (text/vector) rendert; ein Projekt mit ≥ 1000 Assets (kleine PNGs) wird aufgelöst und gerendert, Zeit wird gemessen; Regressionserkennung gegen eine künstlich schlechtere Messung schlägt an.
- `README.md`: wie man misst, was die Werte bedeuten, aktuelle Basiswerte dieser Maschine (Tabelle).

## Verification

- `npx tsc -b packages/benchmarks`
- `npx vitest run packages/benchmarks/`
- `npx eslint packages/benchmarks --max-warnings 0`
