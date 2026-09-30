# ADR 0018: Rolle von PixiJS – optionaler GPU-2D-Renderer mit Rückfall pro Node auf Skia

- Status: angenommen
- Datum: 2026-09-30

## Kontext

Der Auftrag (§9) nennt PixiJS als GPU-2D-Renderer. PixiJS zeichnet in Chromium mit WebGL; die Ergebnisse hängen von GPU, Treiber und ANGLE ab und sind nicht bitgleich zu Skia auf der CPU. PixiJS kann außerdem weniger als Skia (u. a. `svg`, `lottie`, Schatten, konische Verläufe, `textPath`, Text-Animation, Blend Mode `hue`, `rich-text`). Mit `settings.renderer2d: 'pixi'` scheiterte bisher jede Node, die PixiJS nicht darstellt, hart (`OV_PIXI_UNSUPPORTED`); Untertitel (Text-Animation) brachen den Render ab (Audit 2026-09-30, §9).

## Entscheidung

- **Skia bleibt Standard** (`renderer2d` fehlt oder ist `skia`). Determinismus geht vor: Goldens, Frame-Hashes und Cache-Schlüssel beziehen sich auf Skia.
- **Rückfall pro Node:** Mit `renderer2d: 'pixi'` prüft `Registry.resolveBackend` für jede 2D-Node ohne explizites `renderer` die *eigenen* Eigenschaften (ohne Kinder und Maske) mit der Pixi-Prüfung. Meldet sie eine Warnung oder einen Fehler, rendert **Skia** diese Node. Info-Meldungen (z. B. `smoothing: 'cubic'` → linear) lösen keinen Rückfall aus.
- Der Planner (`planFrame`) nutzt dieselbe Entscheidung. Benachbarte Nodes desselben Backends werden weiter zu einem Layer verschmolzen; eine Gruppe mit Pixi- und Skia-Kindern wird zur Compositor-Gruppe (ADR 0024). Kann Pixi die Eigenschaften einer Gruppe selbst nicht zeichnen, rendert Skia die ganze Gruppe.
- Die Vorab-Prüfung (`checkProject`, `openvideo validate`) meldet jeden Rückfall als Info-Diagnose **`OV_PIXI_FALLBACK`** mit den auslösenden Merkmalen (`details.features`).
- Ein explizites `renderer: 'pixi'` an der Node erzwingt PixiJS ohne Rückfall; die Pixi-Meldungen gelten dann wie bisher.
- PixiJS bekommt `rich-text` (Spans über PixiJS-`tagStyles`, Span-Text bleibt wörtlich) und den Blend Mode `hue` (eigener `BlendModeFilter` nach W3C Compositing Level 1, `HueBlend`).

## Folgen

`renderer2d: 'pixi'` ist ein Beschleunigungsschalter ohne harte Fehler: Jedes Projekt, das mit Skia rendert, rendert auch mit Pixi, teils gemischt. Pixi-Layer bleiben GPU-abhängig und nicht bitgleich zu Skia; wer bitgleiche Ergebnisse braucht, nutzt Skia. Gemischte Szenen erzeugen mehr Layer und damit Compositor-Arbeit. Neue Pixi-Fähigkeiten verkleinern automatisch die Menge der Rückfälle, weil die Entscheidung allein aus `checkPixiNode` folgt.
