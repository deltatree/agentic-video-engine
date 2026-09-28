# ADR 0005: Renderer liefern RGBA-Layer, der Plan bildet Layer

- Status: angenommen
- Datum: 2026-09-28

## Kontext

Mehrere Backends (Skia, PixiJS, Chromium, Three.js, Blender) müssen in einem Bild zusammenkommen.

## Entscheidung

Backends implementieren `RenderBackend.renderLayer` und liefern 8-Bit-RGBA, vormultipliziert, sRGB-kodiert. `planFrame` fasst benachbarte Nodes eines fusionierbaren Backends zusammen. `layer`-Nodes und gemischte Gruppen werden Compositor-Layer.

## Folgen

Backends komponieren nie selbst mit fremden Layern. Gemischte Gruppen wenden Opacity je Unter-Layer an; exakte Gruppen-Opacity liefert ein `layer`.
