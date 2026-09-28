# Testplan (System-Ebene) – OpenVideo

- Datum: 2026-09-28
- Grundlage: PRD NFR-5, NFR-6, NFR-13; Architektur AD-1..AD-14
- Risiko-Schwelle: P1 (aus `_bmad/config.toml`)

## Teststufen

| Stufe | Werkzeug | Ort | Prüft | Läuft in |
|---|---|---|---|---|
| Unit | Vitest | `packages/*/test/*.test.ts` | Core, Timeline, Mathe, Schema, Asset Pipeline | jedem Commit |
| Property-Based | Vitest + fast-check | `packages/timeline/test/*.prop.test.ts` | Interpolation, Easing, Zeiteinheiten, Patches | jedem Commit |
| Integration | Vitest | `packages/renderer-*/test/` | Composition → Renderer → Frame | jedem Commit |
| Golden Image | `@agentic-video/testing` | `packages/*/test/golden/*.png` | Referenz-Frames | jedem Commit |
| Pixel Diff | `compareImages` | wie Golden | Toleranz Kanal ≤ 2, Pixel ≤ 0,1 % | jedem Commit |
| Audio | Vitest + FFmpeg | `packages/audio/test/` | Dauer, Sync ± 1 Frame, Pegel ± 0,5 LU | jedem Commit |
| End-to-End | Vitest | `packages/render/test/e2e/`, `packages/cli/test/` | Composition → MP4, CLI | jedem Commit |
| Determinismus | Vitest | `packages/render/test/determinism.test.ts` | Doppel-Render, umgekehrte Reihenfolge, zweiter Worker | jedem Commit |
| Security | Vitest + Docker | `packages/sandbox/test/security.test.ts` | Ausbruch, Netz, Dateisystem, Limits | jedem Commit (Docker nötig) |
| Performance | `benchmarks` | `packages/benchmarks/` | fps, ms/Frame, RAM, Cache-Quote | nightly + manuell |
| UI | Playwright | `apps/studio/test/` | Studio-Funktionen FR-73..FR-76 | jedem Commit |

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

- Ein übersprungener Test braucht eine benannte Ursache (z. B. „Blender fehlt“). Die CI-Umgebung installiert FFmpeg, Chromium und Docker, damit dort nichts übersprungen wird außer GPU-Hardware.
- Golden-Referenzen entstehen mit dem gepinnten Chromium und CanvasKit. Änderungen nur mit `UPDATE_GOLDENS=1` und Begründung im Commit.
- Jede Story nennt ihre Tests im Story-Dokument; die Trace-Matrix (Phase 10) verknüpft FR → Test.
