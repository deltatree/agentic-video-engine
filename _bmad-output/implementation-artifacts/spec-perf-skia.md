---
title: 'Render-Leistung und Skia-Speicherleck'
type: 'bugfix'
created: '2026-09-28'
status: 'ready-for-dev'
route: 'dispatch'
context:
  - '{project-root}/_bmad-output/implementation-artifacts/agent-rules.md'
  - '{project-root}/packages/benchmarks/README.md'
  - '{project-root}/packages/benchmarks/baseline.json'
---

## Intent

**Problem:** Die Benchmarks zeigen zwei Fehler.

1. Nach vielen Renders im selben Prozess scheitert CanvasKit (`OV_SKIA_READBACK`, `OV_SKIA_SURFACE`, zuletzt `table index is out of bounds`). Lange laufende Prozesse wie `openvideo serve` und Worker sind davon betroffen.
2. Einzelne Szenarien sind sehr langsam. In 1080p braucht ein Frame von `image-heavy` etwa 19 s, von `mixed` etwa 10 s und von `text-heavy` etwa 7 s. In 4K braucht `image-heavy` etwa 75 s.

**Nutzen:** Server und Worker laufen stabil. Ein 60-Sekunden-Video in 1080p30 hat 1800 Frames. Das muss in Minuten fertig sein, nicht in Stunden.

## Anforderungen

1. Ein Test rendert mindestens 500 Frames verschiedener Szenarien in einem Prozess ohne Fehler. Der WASM-Speicher wächst dabei nicht unbegrenzt.
2. Die Ursache der langsamen Szenarien ist gemessen und benannt, zum Beispiel wiederholtes Dekodieren, Kopieren großer Puffer oder zu viele Layer.
3. Zielwerte auf der Referenzmaschine (1080p30, ohne Encoding), gemessen mit `openvideo-bench`:
   - `image-heavy`: höchstens 1 s pro Frame
   - `text-heavy`, `mixed`: höchstens 1 s pro Frame
   - kein anderes Szenario wird mehr als 10 % langsamer
4. Die Frames bleiben bitgleich, das heißt die Frame-Hashes in den Golden-Tests ändern sich nicht. Ändert sich ein Hash doch, ist das begründet und das Bild visuell geprüft.
5. `packages/benchmarks/baseline.json` wird nach der Optimierung neu gemessen.

## Grenzen

- Determinismus geht vor Geschwindigkeit.
- Keine neuen Laufzeitabhängigkeiten.

## Offene Fragen

- Keine. Sind die Zielwerte nachweislich nicht erreichbar, nenne die Grenze mit Messung.
