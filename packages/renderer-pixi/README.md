# @agentic-video/renderer-pixi

PixiJS-2D-Renderer aus der IR (läuft im Browser).

Das Paket zeichnet dieselben 2D-Nodes wie Skia, soweit PixiJS es kann.
Es nutzt keine Node-APIs. Den Chromium-Host baut `@agentic-video/renderer-browser`.

## API

```ts
import { PixiLayerRenderer, checkPixiNode, PIXI_CAPABILITIES, PIXI_VERSION } from '@agentic-video/renderer-pixi';

const renderer = new PixiLayerRenderer();
const canvas = await renderer.render({
  nodes, // ausgewertete Nodes des Layers, Zeichenreihenfolge
  width: 1920, height: 1080, scale: 0.5,
  frame: 12, time: 0.4, fps: 30, seed: 1,
  assetUrl: (id) => `/assets/${id}`,
  videoFrame: (id, seconds) => loadFrame(id, seconds),
  defaultFont: 'Inter',
});
renderer.dispose();
```

- `render()` liefert ein neues 2D-Canvas der Größe `width·scale × height·scale`, Hintergrund transparent.
- `checkPixiNode(irNode)` meldet, was PixiJS nicht kann: `OV_PIXI_UNSUPPORTED` mit Vorschlag `renderer: 'skia'`.

## Unterstützt

group (mit `clip`), rect, ellipse, line, polyline, polygon, path, text (mit `background`, auch `perLine`),
image, video, sprite, shader (GLSL), particles.
Farben, lineare und radiale Verläufe, Kontur, Opacity als Gruppe, Blend Modes (ohne `hue`),
Filter blur und alle Farbfilter, Masken (`alpha`, `luminance`, `invert`), Reveal-Clips.

## GLSL-Vertrag für `shader`

```glsl
void mainImage(out vec4 fragColor, in vec2 fragCoord) {
  fragColor = vec4(fragCoord / resolution, 0.5 + 0.5 * sin(time), 1.0);
}
```

- `fragCoord` ist die lokale Pixelposition in der Box (oben links, y nach unten).
- Uniforms: `time` (Sekunden), `frame`, `resolution` (Box in Pixeln), dazu jede Zahl aus `uniforms`.
- Die Farbe ist nicht vormultipliziert.

## Einschränkungen

- Nicht unterstützt: rich-text, svg, lottie, SkSL, konische Verläufe, `hue`, Schatten, `strokeDash`,
  `trim*`, `fillRule: 'evenodd'`, Text-Features (`textPath`, `textAnimation`, `maxLines`, `ellipsis`,
  `fontFeatures`, `fontVariations`, `decoration`, `rtl`, `fontStretch`).
- `blur` ist angenähert: PixiJS-Stärke = 2 · σ · `scale`.
- Video mit `loop`: Die Eingabe kennt die Videodauer nicht; der Host klemmt die Zeit.
