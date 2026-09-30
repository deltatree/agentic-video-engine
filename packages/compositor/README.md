# @agentic-video/compositor

Layer-Compositor: Blend Modes, Masken, Effekte, Color Management.

## Node-Filter und Schatten

`filters` und `shadow` an Compositor-Gruppen (hochgestufte `group`, `layer`) und an isolierten
Layern mit `applyFilters: true` (Backends ohne eigene Filter: `scene3d`, `blender`) rechnet der
Compositor selbst, mit denselben CSS-Farbmatrizen wie das Skia-Backend (`cssFilterMatrix`).
Reihenfolge: Maske → `filters` → `shadow` → Reveal. Siehe `docs/reference/node-semantics.md` 1.6.

## Leistung (Epic 18, ADR 0026)

- Jedes Zwischenbild trägt seine **Inhalts-Region**: Außerhalb davon sind alle Kanäle 0. Blend, Crop, Maske,
  Reveal, Transform und Farbraum-Umrechnung rechnen nur darin; Offscreens kommen aus einem kleinen Pool.
  Neue Operationen müssen Nullen außerhalb der Region erhalten oder die Region neu bestimmen (Scan).
- Frames aus reinen Bild-Layern komponiert ein Durchlauf ohne Float-Zwischenbild (ein Layer: Tabellen je Frame).
- `color-grade` rechnet ohne Allokation je Pixel, die Vignette nutzt eine gecachte Kurve.
- Alles bleibt bitgleich: `test/performance-18.test.ts` vergleicht zufällige Compositor-Bäume Byte für Byte mit
  dem Stand vor der Optimierung (`test/reference/`).
