# Testplan (System-Ebene) – OpenVideo

- Datum: 2026-09-28, an die echten Pfade angepasst am 2026-09-30 (Epic 22)
- Grundlage: PRD NFR-5, NFR-6, NFR-13; Architektur AD-1..AD-14
- Risiko-Schwelle: P1 (aus `_bmad/config.toml`)

## Teststufen

| Stufe | Werkzeug | Ort | Prüft | Läuft in |
|---|---|---|---|---|
| Unit | Vitest | `packages/*/test/**/*.test.{ts,tsx}`, auch neben dem Code (`packages/*/src/**/*.test.ts`) | Core, Timeline, Mathe, Schema, Asset Pipeline | jedem Commit |
| Property-Based | Vitest + fast-check | in den Unit-Dateien (`fc.assert`), z. B. `packages/timeline/test/`, `packages/core/test/`, `packages/components/test/` | Interpolation, Easing, Zeiteinheiten, Patches | jedem Commit |
| Integration | Vitest | `packages/renderer-*/test/` | Composition → Renderer → Frame | jedem Commit |
| Golden Image | `@agentic-video/testing` | `packages/*/test/golden/*.png` | Referenz-Frames | jedem Commit |
| Pixel Diff | `compareImages` | wie Golden | Toleranz Kanal ≤ 2, Pixel ≤ 0,1 % | jedem Commit |
| Audio | Vitest + FFmpeg | `packages/audio/test/`, `packages/render/test/audio-nested.test.ts`, A/V-Sync im MP4: `packages/render/test/av-sync.test.ts` | Dauer, Sync ± 1 Frame (Klick + Blitz-Frame in der kodierten Datei), Pegel ± 0,5 LU | jedem Commit |
| End-to-End | Vitest | `packages/render/test/e2e.test.ts`, `packages/render/test/e2e-mixed.test.ts`, `packages/cli/test/`, `examples/dod/dod.test.ts` | Composition → MP4, CLI; Bitgleichheit ohne Cache (frische Umgebung) | jedem Commit |
| Determinismus | Vitest | `packages/render/test/determinism.test.ts` | zwei frische Umgebungen ohne Cache, umgekehrte Chunk-Reihenfolge, 1 gegen 3 Prozess-Worker, gemischte Composition (Skia, Compositor, Browser, Three); Frame- und Datei-Hash | jedem Commit |
| Security | Vitest + Docker | `packages/sandbox/test/sandbox.test.ts`, `packages/sandbox/test/review-fixes.test.ts`, `packages/renderer-browser/test/security.test.ts`, `packages/agent/test/server-security.test.ts`, `packages/worker/test/robustness.test.ts` | Ausbruch, Netz, Dateisystem, Limits, Tokens, Body-Limit, Pfad-Traversal, kaputte Protokoll-Rahmen | jedem Commit (Docker in CI) |
| Performance | `benchmarks` | `packages/benchmarks/`, `.github/workflows/benchmarks.yml` | fps, RAM, Startzeit, Encoder-fps, Cache-Quote gegen die Basis des Runner-Typs (Toleranzen je Metrik); Wall-Clock-Tests mit `OV_PERF_STRICT=1` | nightly + manuell |
| UI | Playwright | `apps/studio/test/` (Screenshot-Golden `apps/studio/test/golden/studio.png` mit Toleranz, Artefakt in CI) | Studio-Funktionen FR-73..FR-76 | jedem Commit |
| Katalog-Snapshots | Vitest | `packages/templates/test/catalog-snapshot.test.ts`, `packages/components/test/catalog-snapshot.test.ts` | Template- und Komponentenkatalog | jedem Commit |
| Paket-Smoke | Node | `scripts/smoke-npx.mjs` (CI-Job `smoke-npx`) | `npm pack` aller Pakete → leeres Verzeichnis → `openvideo create/validate/render-frame` | jedem Commit, vor jedem Release |
| Coverage | Vitest v8 | `npm run test:coverage`, Schwellen je Paket in `vitest.config.ts` | Mindest-Coverage (Ratchet) | jedem Commit |

## Risiken und Gegenmaßnahmen

| Nr. | Risiko | Wahrsch. | Wirkung | Prio | Test |
|---|---|---|---|---|---|
| R1 | Nicht-deterministische Frames (Browser, Fonts, Threads) | mittel | hoch | P0 | Determinismus-Suite je Renderer |
| R2 | Sandbox-Ausbruch | niedrig | hoch | P0 | Security-Suite |
| R3 | Golden-Drift durch Bibliotheks-Updates | hoch | mittel | P1 | Golden + gepinnte Versionen |
| R4 | A/V-Versatz | mittel | hoch | P1 | Audio-Sync-Test mit Klick-Spur |
| R5 | Falsches Alpha (Premultiplied) | mittel | mittel | P1 | Alpha-Export-Test FR-60a |
| R6 | Cache liefert veralteten Frame | niedrig | hoch | P0 | Frame-Schlüssel-Test (Änderung → neuer Schlüssel) |
| R7 | Umgebungsabhängigkeit (kein FFmpeg, kein Docker, kein Blender) | hoch | mittel | P1 | Tests melden `skip` nur mit Begründung und Doctor-Hinweis; CI hat alles außer GPU |
| R8 | Schema-Bruch ohne Versionssprung | mittel | hoch | P1 | Schema-Snapshot-Test |

## Regeln

- Ein übersprungener Test braucht eine benannte Ursache (z. B. „Blender fehlt“) und läuft über `skipUnless` aus `@agentic-video/testing`. Die CI-Umgebung installiert FFmpeg, Chromium, Blender, Docker-Images, Piper mit Stimme und whisper.cpp mit Modell und setzt `OPENVIDEO_REQUIRE_ALL=1`: Jeder umgebungsbedingte Skip ist dort ein Fehler, außer der Allowlist (`allowInCi`, GPU-Hardware).
- Wall-Clock-Grenzen gelten nur mit `OV_PERF_STRICT=1`; sonst warten Tests auf Sperren (Promises, `expect.poll`) oder nutzen injizierte Uhren statt fester Pausen.
- Golden-Referenzen entstehen mit dem gepinnten Chromium und CanvasKit. Änderungen nur mit `UPDATE_GOLDENS=1` und Begründung im Commit.
- Jede Story nennt ihre Tests im Story-Dokument; die Trace-Matrix (Phase 10) verknüpft FR → Test.
