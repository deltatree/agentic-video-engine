# ADR 0028: Qualitätstore ohne stille Skips, Determinismus ohne Cache und npm-Release mit Provenance

- Status: angenommen
- Datum: 2026-09-30
- Bezug: Audit 2026-09-30 (QA P0-1 bis P2-10, Agent-DX 1 und 2), Epic 22 (Story 22.1–22.5, 22.7), Entscheidungen T3 und T12

## Kontext

Tests für Docker, Piper und whisper.cpp liefen in CI nie: Die Umgebung fehlte, `it.skipIf` übersprang
still, und CI blieb grün. Die Aussage „zweiter Lauf ist bitgleich“ kam aus dem Cache. Benchmarks liefen
nur als Smoke-Test, Zeitgrenzen und feste Pausen machten Tests auf geteilten Runnern wackelig.
`npx @agentic-video/cli` fand kein Paket, und das Studio fehlte im CLI-Paket.

## Entscheidung

1. **Überwachte Skips:** Umgebungsabhängige Tests überspringen nur über `skipUnless(verfügbar, Grund)` aus
   `@agentic-video/testing`. CI setzt `OPENVIDEO_REQUIRE_ALL=1`; dann wirft `skipUnless`
   `OV_TEST_SKIP_FORBIDDEN`. Einzige Ausnahme ist die Allowlist `allowInCi` (GPU-Hardware). Ein Test prüft,
   dass kein `skipIf`/`runIf` an `skipUnless` vorbeiläuft.
2. **Vollständige CI-Umgebung:** CI zieht die Docker-Images per Digest vorab und installiert Piper
   (Abhängigkeiten mit `--require-hashes`) mit der Stimme en_US-lessac-low sowie whisper.cpp (Commit geprüft)
   mit ggml-tiny.en.bin; alle Downloads sind per SHA-256 geprüft und gecacht.
3. **Determinismus ohne Cache:** `packages/render/test/determinism.test.ts` vergleicht Frame- und
   Datei-Hashes aus frischen Umgebungen mit leerem Cache, bei umgekehrter Chunk-Reihenfolge und mit 1 gegen
   3 Prozess-Workern, für Skia, Compositor, Browser und Three. Jeder Lauf muss alle Frames selbst rendern.
4. **Zeit:** Harte Wall-Clock-Grenzen gelten nur mit `OV_PERF_STRICT=1` (nightly). Sonst warten Tests auf
   Sperren oder nutzen injizierte Uhren (Koordinator `now`).
5. **Nightly-Benchmark:** `compareToBaseline` vergleicht fps, Spitzen-RAM, Startzeit, Encoder-fps und
   Cache-Quote mit Toleranzen je Metrik. Die Basis ist maschinenspezifisch und liegt im Actions-Cache unter
   dem Hash der Maschinenbeschreibung; ohne Basis misst der erste Lauf sie.
6. **Coverage als Ratchet:** Mindestwerte je Paket in `vitest.config.ts`, knapp unter dem gemessenen Stand;
   sie werden nur angehoben.
7. **npm-Release (T3):** Alle Pakete unter `packages/*` haben `publishConfig: { access: 'public', provenance: true }`.
   Der Build kopiert das Studio nach `packages/cli/studio` (Teil von `files`). Bei einem Tag `v*` prüft
   `.github/workflows/release.yml` Tag gegen Root-Version, setzt alle Paketversionen aus der Root-Version,
   baut, führt den Smoke-Test aus und veröffentlicht in Abhängigkeitsreihenfolge mit `npm publish --provenance`
   (Secret `NPM_TOKEN`). Den Tag setzt der Maintainer. `scripts/smoke-npx.mjs` packt alle Pakete, installiert
   sie in ein leeres Verzeichnis und führt `openvideo create/validate/render-frame` aus; CI führt ihn bei
   jedem Commit aus.

## Folgen

- Eine fehlende Werkzeugkette in CI ist ein roter Build statt einer stillen Lücke. Lokal bleiben benannte Skips.
- Die CI-Laufzeit steigt um den ersten Aufbau von Piper und whisper.cpp; danach greifen die Caches.
- Benchmarks vergleichen nur gleiche Runner-Typen. Wechselt GitHub die CPU eines Runners, misst der nächste
  Lauf eine neue Basis, statt falsch zu vergleichen.
- Bis zur ersten Veröffentlichung nennt das README die Installation aus dem Repository.

## Nachtrag 2026-09-30: keine npm-Veröffentlichung vorerst

Der Maintainer hat entschieden, die Pakete vorerst nicht auf npm zu veröffentlichen. Jeder baut OpenVideo aus dem
Repository. Dafür gibt es `SETUP.md`: eine Anleitung, die ein Coding Assistant liest und ausführt, und
`npm run setup` (`scripts/setup.mjs`: Voraussetzungen prüfen, `npm ci`, Build, Chromium, `openvideo` global
verlinken, `doctor`). `release.yml` und `publishConfig` bleiben unverändert und ruhen, bis ein Tag `v*` gesetzt wird;
der Smoke-Test `smoke-npx` prüft weiter, dass die gepackten Pakete funktionieren.
