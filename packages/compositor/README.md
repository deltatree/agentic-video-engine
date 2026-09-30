# @agentic-video/compositor

Layer-Compositor: Blend Modes, Masken, Effekte, Color Management.

## Node-Filter und Schatten

`filters` und `shadow` an Compositor-Gruppen (hochgestufte `group`, `layer`) und an isolierten
Layern mit `applyFilters: true` (Backends ohne eigene Filter: `scene3d`, `blender`) rechnet der
Compositor selbst, mit denselben CSS-Farbmatrizen wie das Skia-Backend (`cssFilterMatrix`).
Reihenfolge: Maske → `filters` → `shadow` → Reveal. Siehe `docs/reference/node-semantics.md` 1.6.
