# ADR 0024: Der Compositor wendet Eigenschaften über Backend-Grenzen an

- Status: angenommen
- Datum: 2026-09-30

## Kontext

Nach ADR 0005 rendert jedes Backend seine Layer, der Compositor setzt sie zusammen. Gruppen, deren Kinder nur ein Backend ohne Gruppen-Semantik brauchten (`group{scene3d}`, `group{html}`), gingen als Gruppe an dieses Backend und brachen ab. `blendMode`, `mask` und Wipe/Iris-Reveals an Nodes über einer Backend-Grenze wirkten nicht: Ein Backend mischt nur mit dem Inhalt seines eigenen, transparenten Layers (Audit 2026-09-30, Story 17.1).

## Entscheidung

- Der Planner stuft Gruppen zu Compositor-Gruppen hoch, wenn ihre Nachfahren mehrere Backends brauchen oder ihr einziges Backend keine Gruppen zeichnet (`nodeTypes` ohne `group`). Der Compositor wendet dort Farbraum, Effekte, Crop, `clip`, Maske, Reveal, Transform, Opacity und Blend Mode an.
- Eine Node wird **isoliert** (`CompositeLayerPlan.mode = 'isolate'`), wenn ihr Backend Blend Mode, Maske oder Reveal nicht über die Layer-Grenze anwenden kann: `scene3d`, `html`, `blender` mit einer dieser Eigenschaften; 2D-Nodes mit `blendMode ≠ normal` über Inhalt außerhalb ihres Layers; 2D-Nodes mit einer Masken-Node aus einem anderen Backend. Das Backend rendert die Node ohne diese Eigenschaften, der Compositor wendet sie mit der Node-Matrix auf den fertigen Layer an.
- Der Backdrop eines Blend Modes ist alles darunter, auch die Hintergrundfarbe der Composition. Gruppen bleiben isoliert.
- Die Compositor-Version im Frame-Schlüssel steigt auf `openvideo-compositor-2`.

## Folgen

Grenzfälle rendern gleich, egal welches Backend beteiligt ist. Isolierte Nodes kosten einen zusätzlichen Layer und einen Compositor-Durchgang; reine 2D-Szenen ohne Hintergrundfarbe und ohne Blend Modes planen unverändert. Frames mit Blend Modes auf oberster Ebene über einer Hintergrundfarbe oder mit Reveals an Compositor-Gruppen ändern sich (Korrektur). `filters` und `shadow` an hochgestuften Gruppen wirkten zunächst nicht (`OV_COMPOSITE_UNSUPPORTED`).

## Nachtrag (Story 17.11)

Der Compositor wendet `filters` und `shadow` an Compositor-Gruppen und an `scene3d`-/`blender`-Layern (isoliert oder nicht) selbst an, mit der Semantik des Skia-Backends (CSS-Farbmatrizen auf nicht vormultiplizierten sRGB-Werten, Blur und Schatten auf vormultiplizierten sRGB-Werten). Reihenfolge: Maske → `filters` → `shadow` → Reveal. `OV_COMPOSITE_UNSUPPORTED` entfällt. Die Compositor-Version im Frame-Schlüssel steigt auf `openvideo-compositor-3`.
