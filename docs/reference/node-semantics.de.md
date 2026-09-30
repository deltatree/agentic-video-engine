# Render-Semantik der Node-Typen

Dieses Dokument ist der verbindliche Vertrag für alle Renderer (Skia, PixiJS, Browser, Three.js, Blender).
Gemeinsame Rechenregeln liegen als reine Funktionen in `@agentic-video/core` (`semantics.ts`, `props.ts`, `matrix.ts`, `path.ts`).
Ein Renderer, der davon abweicht, meldet das als Capability-Einschränkung.

## 1. Allgemeine Regeln

### 1.1 Ausgabe eines Renderers

- Ein Renderer liefert ein `RgbaImage` in Ausgabegröße `request.width × request.height`.
- Format: 8 Bit je Kanal, **vormultipliziertes Alpha**, sRGB-kodiert, Zeilen von oben nach unten.
- Der Hintergrund ist transparent. Die Composition-Hintergrundfarbe setzt der Compositor.
- Vorschau-Skalierung: Der Renderer stellt allen Transformationen `scale(request.scale)` voran.

### 1.2 Koordinaten und Transform (ADR 0004)

- 2D-Einheit ist das Pixel der Composition. Ursprung oben links, y nach unten.
- `x`, `y` ist die linke obere Ecke der **lokalen Box** der Node.
- Rotation, Scherung und Skalierung wirken um `origin` (relativ zur Box, Standard `{ x: 0.5, y: 0.5 }`).
- Die lokale Matrix berechnet `localMatrix(node, measured)` aus `@agentic-video/core`.
- Ein Bewegungspfad (`motionPath`) addiert seinen Punkt zu `x`/`y` (siehe `getTransform`).
- Kinder zeichnen im Koordinatensystem ihrer Eltern: `Welt = Eltern-Matrix × lokale Matrix`.
- Winkel sind immer Grad.

### 1.3 Lokale Box je Typ

| Typ | Box |
|---|---|
| `rect`, `ellipse`, `image`, `video`, `svg`, `sprite`, `lottie`, `shader`, `particles`, `html`, `scene3d`, `blender` | `(0, 0, width, height)` |
| `group`, `layer`, `sequence` | `(0, 0, width ?? 0, height ?? 0)` |
| `line` | Hülle von `from` und `to` |
| `polyline`, `polygon` | Hülle der Punkte |
| `path` | Hülle aller Koordinaten (`pathBounds`) |
| `text`, `rich-text` | `(0, 0, gemessene Breite, gemessene Höhe)`; mit `width` ist die Breite fest |

Fehlen bei `image`, `video`, `svg`, `sprite` die Maße, gilt die Eigengröße des Assets.

### 1.4 Darstellung

| Property | Bedeutung | Standard |
|---|---|---|
| `opacity` | Multipliziert die Deckkraft der Node und aller Kinder (als Gruppe). | 1 |
| `zIndex` | Zeichenreihenfolge unter Geschwistern (animierbar). Höhere Werte liegen oben; gleiche Werte behalten die Reihenfolge im Dokument (stabile Sortierung). Die ausgewertete Szene, der Planner und der Szenenbaum nutzen die sortierte Reihenfolge. | 0 |
| `blendMode` | Mischt die Node mit allem, was unter ihr liegt, auch mit Layern anderer Backends und mit der Hintergrundfarbe der Composition (im Arbeitsfarbraum). Gruppen und `layer` sind isoliert: Ihre Kinder mischen nur mit Inhalt derselben Gruppe. Siehe 1.6. | `normal` |
| `filters` | Liste, in Reihenfolge angewendet. `blur.radius` ist die Standardabweichung in Pixeln (wie CSS `blur()`). `brightness`, `contrast`, `saturate`, `grayscale`, `sepia`, `invert`, `hue-rotate` wie CSS. | – |
| `shadow` | Schlagschatten der ganzen Node. `blur` ist die Standardabweichung. | – |
| `mask` | Die Masken-Node liegt im **lokalen Koordinatensystem der maskierten Node** (sie bewegt sich mit). `alpha`: Deckkraft der Maske; `luminance`: Helligkeit × Alpha. `invert` kehrt um. Masken- und maskierte Node dürfen verschiedene Backends nutzen (1.6). | `alpha` |
| `clip` (nur `group`) | Beschneidet Kinder auf die Box der Gruppe. | `false` |
| `reveal` (aus Übergängen) | Beschneidet die Node auf `revealShape(reveal, box)` in lokalen Box-Koordinaten. Bei Gruppen ohne Maße ist `box` die Hülle der Kinder. Gilt für alle Node-Typen, auch `layer`, `scene3d`, `html`, `blender` (1.6). | – |

### 1.6 Compositing über Backend-Grenzen (Frame Plan)

Der Planner (`planFrame`) teilt die Szene in Layer; jedes Backend rendert seine Layer, der Compositor setzt sie zusammen.
Damit keine Eigenschaft an einer Backend-Grenze verloren geht, gelten diese Regeln:

- **Gruppen** mit Nachfahren aus mehreren Backends, und Gruppen, deren Kinder ein Backend ohne eigene Gruppen-Unterstützung brauchen (`scene3d`, `html`, `blender`), setzt der Compositor zusammen. Er wendet in dieser Reihenfolge an: Kinder → `colorSpace` (nur `layer`) → `effects` → `crop` → `clip` → Maske → `filters` → `shadow` → Reveal → Transform → `opacity` → `blendMode`. `filters` und `shadow` rechnet der Compositor wie das Skia-Backend (Story 17.11): Farbfilter auf nicht vormultiplizierten, sRGB-kodierten Werten, `blur` und Schatten auf vormultiplizierten sRGB-Werten, Längen in lokalen Einheiten (mit der Vorschau-Skalierung bzw. Node-Matrix in Pixel umgerechnet).
- **Isolierte Nodes:** Eine Node wird isoliert, wenn ihr Backend eine Eigenschaft nicht über die Layer-Grenze anwenden kann:
  - `scene3d`, `html`, `blender` mit `blendMode ≠ normal`, `mask` oder Reveal;
  - 2D-Nodes (Skia, PixiJS) mit `blendMode ≠ normal`, wenn unter ihnen Inhalt außerhalb ihres Layers liegt (ein anderer Layer oder die Hintergrundfarbe der Composition);
  - 2D-Nodes, deren Masken-Node ein anderes Backend braucht.

  Das Backend rendert die Node dann ohne diese Eigenschaften (mit Transform und Opacity), der Compositor wendet Reveal, Maske (mit der Node-Matrix transformiert) und Blend Mode auf den fertigen Layer an. Reveal-Kanten werden mit 4 × 4 Stichproben geglättet.
- **`filters` und `shadow` an `scene3d` und `blender`:** Three.js und Blender zeichnen sie nicht selbst. Der Compositor wendet sie auf den fertigen Layer an (Reihenfolge Maske → `filters` → `shadow` → Reveal), isoliert oder nicht; Blur-Radien skalieren mit √|det| der Node-Matrix, Schatten-Offsets mit ihrem linearen Anteil. 2D-Backends und `html` (CSS) zeichnen sie selbst.
- Blend Modes innerhalb eines 2D-Layers ohne Hintergrundfarbe rechnet das Backend selbst (Skia/PixiJS).
- **2D-Backend (`settings.renderer2d`):** Standard ist Skia. Mit `renderer2d: 'pixi'` rendert PixiJS jede 2D-Node, deren eigene Eigenschaften es darstellen kann; alle anderen rendert Skia (Rückfall pro Node, Info `OV_PIXI_FALLBACK`, ADR 0018). Kann Pixi die Eigenschaften einer Gruppe nicht zeichnen, rendert Skia die ganze Gruppe. Ein explizites `renderer` an der Node hat Vorrang.

### 1.7 Farbräume

- Backends liefern sRGB-kodierte Pixel (1.1). Der Compositor mischt im **Arbeitsfarbraum**: `composition.colorSpace`, sonst `settings.workingColorSpace`, sonst `srgb`. Effekte rechnen immer in linearem Licht.
- `layer.colorSpace` erklärt, wie die Pixel der Kinder kodiert sind: `linear` (lineares Licht) oder `rec709` (BT.709-OETF). Der Compositor liest sie mit dieser Kodierung statt sRGB und überführt sie in den Arbeitsfarbraum. `srgb` ist der Standard und ändert nichts.
- `settings.outputColorSpace` kodiert die Ausgabe-Pixel: `srgb` (Standard), `rec709` oder `linear` (lineares Licht in 8 Bit; für Weiterverarbeitung, sichtbar gröbere Abstufung in dunklen Tönen). Der Wert geht in den Frame-Schlüssel ein. Das Video-Tag (`color_trc`) setzt `renderProfile.colorSpace` (Standard `srgb`); weichen beide ab, warnt der Validator mit `OV_COLORSPACE_MISMATCH`.

### 1.5 Füllung und Kontur

- `fill` und `stroke` sind Farbe oder Verlauf.
- Fehlen `fill` und `stroke`, füllt die Form mit `#FFFFFF` (`effectiveFill`).
- Verläufe nutzen standardmäßig relative Koordinaten (`units: 'relative'`): 0..1 der Box.
  - `linear`: `start` Standard `{0, 0}`, `end` Standard `{1, 0}`.
  - `radial`: `center` Standard `{0.5, 0.5}`, `radius` Standard 0.5, relativ zur größeren Box-Seite.
  - `conic`: `center` Standard `{0.5, 0.5}`, `angle` in Grad, 0 = rechts, im Uhrzeigersinn.
- `strokeWidth` Standard 1, wenn `stroke` gesetzt ist. Die Kontur liegt mittig auf der Kante.
- `strokeCap` Standard `butt`, `strokeJoin` Standard `miter`.
- `strokeDash`: Strich- und Lückenlängen in Pixeln.
- `trimStart`, `trimEnd` (0..1) und `trimOffset` (0..1, zyklisch) beschneiden die Kontur entlang der Pfadlänge.

## 2. Node-Typen

### Struktur

- **group**: zeichnet Kinder in Reihenfolge. Transform, Opacity, Filter, Maske wirken auf das Gruppenbild.
- **layer**: wie `group`, bildet aber immer einen eigenen Compositor-Layer. Zusätzlich `colorSpace` (1.7), `crop`, `effects`, `motionBlur`.
- **sequence**: spielt ihre Kinder nacheinander ab und wird vor dem Rendern zu einer `group` (T9). Jedes Kind braucht `timing.duration` (eine `composition-ref` ohne Dauer nimmt die Dauer ihrer Composition); fehlt sie, wird das Kind mit `OV_SEQUENCE_DURATION` übersprungen. `timing.from` der Kinder wird ersetzt (`OV_SEQUENCE_FROM_IGNORED`). Zwischen Kind i und i + 1 gilt `transitions[i] ?? between ?? { type: 'cut' }`:
  - `cut`: Kind i + 1 beginnt am Ende von Kind i.
  - Übergang mit `type` (wie `transition`: `fade`, `slide-*`, `wipe-*`, `zoom-in`, `zoom-out`, `blur`, `iris`) und `duration` d: Kind i + 1 beginnt d vor dem Ende von Kind i (d wird auf die kürzere der beiden Dauern begrenzt). Kind i + 1 erhält den Übergang als `in` und liegt über Kind i, das bis zum Ende der Überlappung stehen bleibt (Überblendung; bei deckenden Clips exakt ein Crossfade). Bei `slide-*` erhält Kind i denselben Übergang als `out` (Push: beide Clips bewegen sich in dieselbe Richtung).
  - Eigene `transition`-Einträge der Kinder gelten an Stellen ohne Sequenz-Übergang (z. B. `in` des ersten und `out` des letzten Kinds).
  - Die Gesamtdauer ist die Summe der Kinddauern minus der Überlappungen.
- **composition-ref**, **component**, **subtitles**: werden vor dem Rendern expandiert. Renderer sehen sie nie.
  Eine `composition-ref` bringt den Ton ihrer Composition mit (Spuren, Video-Ton, weitere Refs, rekursiv), versetzt und abgebildet mit der lokalen Zeit der Ref (`from`, `speed`, `reverse`, `remap` wirken wie bei Video-Ton). Lautheit und Limiter der verschachtelten Composition wirken nicht; gemastert wird nur die äußere.

### Formen

- **rect**: Rechteck `width × height`. `cornerRadius` als Zahl oder `[oben links, oben rechts, unten rechts, unten links]`.
- **ellipse**: Ellipse in der Box.
- **line**: Strecke `from` → `to`. Ohne `stroke` zeichnet sie mit `fill`-Farbe als Kontur der Breite `strokeWidth ?? 1`.
- **polyline**: offene Linie; Standard ist nur Kontur mit Farbe `#FFFFFF`, Breite 1, wenn weder `fill` noch `stroke` gesetzt sind.
- **polygon**: geschlossene Fläche.
- **path**: SVG-Pfaddaten `d`, `fillRule` Standard `nonzero`.

### Text

- `fontFamily` Standard: `settings.defaultFont`, sonst `Inter`. Emoji fallen auf `Noto Color Emoji` zurück.
- `fontSize` 48, `fontWeight` 400, `fontStyle` normal, `lineHeight` 1.2, `letterSpacing` 0, `textAlign` `left`, `direction` `auto`.
- Ohne `width` bricht der Text nur an `\n` um; die Box ist so breit wie die längste Zeile.
- Mit `width` bricht der Text an Wortgrenzen um. `textAlign` richtet innerhalb von `width` aus.
- `maxLines` begrenzt die Zeilen; mit `ellipsis` wird die letzte Zeile gekürzt. Mehr Text als Platz ist **Überlauf** (Diagnose `OV_TEXT_OVERFLOW`).
- `fontFeatures` (z. B. `{ liga: 0, tnum: 1 }`) und `fontVariations` (z. B. `{ wght: 650 }`) gehen direkt an den Textsatz.
- `textPath`: Glyphen folgen dem Pfad ab `offset` Pixeln. `background` wird dann zu einem Band entlang des Pfads (Zeilenhöhe plus `paddingY`, `paddingX` vor und nach dem Text, `radius > 0` rundet die Enden); `textAnimation` wirkt je Einheit um ihre Mitte auf dem Pfad.
- `fill` als Verlauf füllt die Textbox; `stroke` zeichnet Glyphenkonturen.
- `textAnimation`: Jede Einheit (Zeichen, Wort, Zeile) geht von `from` in den Normalzustand über. Den Zustand berechnet `textUnitState(node, i, count, localFrame, fps)`; die Aufteilung `splitTextUnits`. Verschiebung und Skalierung wirken um die Mitte der Einheit. Einheit i beginnt bei `starts[i]`, sonst bei `start + Position · stagger`.
- **subtitles** (Makro): siehe `packages/subtitles/README.md` – ASS-Stile, Umbruch mit echter Textmessung, Karaoke-Fill im laufenden Wort, `textAnimation` je Wort ab seiner Wortzeit, `fromAudio` vor dem Render transkribiert.
- `background`: Box hinter dem gemessenen Text (`color`, `paddingX`, `paddingY`, `radius`); mit `perLine: true` eine Box je Zeile. Die Box gehört zur Node (Opacity, Transform, Maske wirken mit).
- `rich-text`: `spans` mit eigenen Stilen; Stil-Properties der Node sind Standard für alle Spans.

### Medien

- **image**: `fit` Standard `fill` bei gesetzten Maßen. `contain`/`cover` zentrieren. `smoothing` Standard `linear`. Animierte Bilder (GIF, APNG, animiertes WebP) normalisiert die Asset-Pipeline zu einem verlustfreien Video; die Node zeigt dann den Frame zur lokalen Zeit, in einer Endlosschleife über die Dauer des Bildes (Video-Frame-Pfad wie bei `video`, `loop: true`, stumm). Animiertes WebP braucht ein FFmpeg, das animiertes WebP dekodiert (FFmpeg 6.1 kann das nicht; der Import meldet dann einen Fehler).
- **video**: Quellzeit = `startFrom + localTime · playbackRate`; mit `loop` modulo Dauer, sonst geklemmt. Das Bild liefert `AssetResolver.videoFrame(asset, sekunden)`.
  Ton (ohne `muted`): In einfacher Einbettung (nur `timing.from`/`duration` an der Node und allen Vorfahren, nicht in `sequence` oder Komponenten) ist er ein Clip; `playbackRate` ändert das Tempo bei gleicher Tonhöhe. Sonst (`speed`, `reverse`, `remap`, `loop`, `pingPong`, `hold` an der Node oder einem Vorfahren) folgt der Ton der Quellzeit des Bildes, je Frame abgetastet und linear interpoliert, und läuft wie ein Band (Tonhöhe folgt der Geschwindigkeit, `reverse` spielt rückwärts).
- **svg**: Asset oder `markup` in die Box skaliert (`fit` Standard `contain`). Gezeichnet werden Formen, `g`, `use`, Verläufe, `pattern`, `clipPath` (`clipPathUnits`, `clip-rule`), `mask` (Luminanz × Alpha, `mask-type: alpha`, Maskenbereich), `image` und `text` mit `tspan` (`x`, `y`, `dx`, `dy`, eigener Stil). `<image>` lädt nur Data-URIs (PNG, JPEG, WebP, GIF, BMP) und Bild-Assets des Projects (`asset:<id>` oder ein Pfad relativ zur SVG-Datei innerhalb des Projects); andere Quellen meldet die Prüfung als `OV_SVG_IMAGE_BLOCKED`. Nicht unterstützte Elemente (z. B. `filter`, `foreignObject`) meldet sie als `OV_SVG_UNSUPPORTED`, auch für SVG-Assets (`checkProject`).
- **sprite**: Rasterbild mit `columns × rows` Zellen, zeilenweise nummeriert. Index = `frame`, sonst `floor(localTime · frameRate)`; mit `loop` modulo `frameCount`, sonst geklemmt.
- **lottie**: Zeit = `localTime · speed + frameOffset / lottieFps`; mit `loop` modulo Dauer.

### Effekte

- **shader**: füllt die Box. SkSL-Signatur `half4 main(float2 coord)`, `coord` in lokalen Pixeln. Uniforms `time` (Sekunden), `frame`, `resolution` (float2) plus eigene. `sksl` (Skia) und `glsl` (PixiJS, `mainImage(out vec4, in vec2)`) dürfen gleichzeitig stehen; jedes Backend nimmt seine Quelle (ADR 0020).
- **particles**: Zustand aus `particles2d(node, localTimeSeconds, fps)`. Form `circle` (Standard), `square`, `spark` (Strich in Bewegungsrichtung, Länge = 3 × Größe). Koordinaten relativ zur Box.

### Browser

- **html**: Chromium rendert `html` + `css` in eine Box `width × height`; die Box wird mit der Node-Matrix platziert. Die Seite erhält pro Frame die Zeit über `window.openvideo` (siehe Browser-Renderer-Doku). CSS-Animationen werden pausiert und auf die lokale Zeit gesetzt. Skripte laufen nur ausdrücklich erlaubt (`--trusted`, ADR 0008); ohne Skripte bleiben `<canvas>` (2D, WebGL, WebGPU) und Custom Elements ohne deklaratives Shadow DOM leer – `openvideo check` warnt mit `OV_HTML_CANVAS_NO_SCRIPTS` bzw. `OV_HTML_WEB_COMPONENTS_NO_SCRIPTS`.

### 3D

- **scene3d**: rendert Kinder mit Three.js in eine Box `width × height`, platziert mit der Node-Matrix. Bildtexturen über dem GPU-Maximum sind ein Fehler `OV_THREE_TEXTURE_TOO_LARGE`, mit `textureDownscale: true` werden sie verkleinert. `background` Standard transparent. `camera` Standard: erste `camera3d`; ohne Kamera eine Perspektivkamera bei `[0, 0, 5]` mit Blick auf den Ursprung.
- **camera3d**: `fov` 50, `near` 0.1, `far` 1000, `projection` `perspective`. `target` bestimmt die Blickrichtung, sonst gilt `rotation`.
- **light3d**: `intensity` 1, `color` `#FFFFFF`.
- **mesh3d**, **model3d**, **instances3d**, **particles3d**, **group3d**: Position in Metern, Rotation XYZ in Grad.
- **blender**: wie `scene3d`, gerendert mit Blender. `particles3d` wird als Instanzen übertragen (je lebendes Partikel eine unbeleuchtete Kugel, gleiche Formel wie Three.js). `motionBlur: true`: Der Frame-Render übergibt die Zustände bei ±0,25 Frames (Verschlusszeit ½ Frame); Blender interpoliert Position, Rotation und Skalierung linear dazwischen.

## 3. Beispiele je Node-Typ

Ein kleines, gültiges JSON-Beispiel je Node-Typ. Dieselben Beispiele liefern `capabilities.get` (Feld `example`), `docs/ai/capabilities.json` und das JSON Schema (`examples` je `Node_<typ>`).
Durchgehende Beispielprojekte liegen in [`examples/`](../../examples/README.md).

<!-- node-examples:start -->

Generiert von `scripts/generate-docs.mjs` aus `NODE_EXAMPLES` (`@agentic-video/schema`). Jedes Beispiel ist gültig; `exampleProject(type)` bettet es in ein Projekt mit Composition `main` (640 × 360, 30 fps, 2 s) ein. 3D-Nodes stehen dort in einer `scene3d` mit Kamera und Licht. Verweise: Assets `logo` (image, `assets/logo.png`), `clip` (video, `assets/clip.mp4`), `walk-sheet` (image, `assets/walk-sheet.png`), `spinner` (lottie, `assets/spinner.json`), `robot` (model, `assets/robot.glb`); Untertitel-Track `captions`; Composition `intro`.

### `group`

Groups children with a shared transform.

```json
{
  "id": "badge",
  "type": "group",
  "x": 220,
  "y": 148,
  "children": [
    { "id": "badge-bg", "type": "rect", "width": 200, "height": 64, "cornerRadius": 32, "fill": "#FF5A1F" },
    {
      "id": "badge-label",
      "type": "text",
      "text": "NEW",
      "y": 12,
      "width": 200,
      "textAlign": "center",
      "fontSize": 32,
      "fontWeight": 700,
      "fill": "#FFFFFF"
    }
  ]
}
```

### `layer`

Compositing boundary: always rendered as its own layer.

```json
{
  "id": "glow-layer",
  "type": "layer",
  "blendMode": "screen",
  "effects": [{ "type": "glow", "radius": 16, "intensity": 0.8 }],
  "children": [{ "id": "orb", "type": "ellipse", "x": 220, "y": 80, "width": 200, "height": 200, "fill": "#4F8CFF" }]
}
```

### `composition-ref`

Nested composition, evaluated at the remapped local time.

```json
{
  "id": "intro-ref",
  "type": "composition-ref",
  "composition": "intro",
  "timing": { "from": 0, "duration": "2s", "speed": 1 }
}
```

### `sequence`

Plays its children one after another (each needs timing.duration, or is a composition-ref). Consecutive children overlap by the transition duration and cross over automatically.

```json
{
  "id": "slides",
  "type": "sequence",
  "between": { "type": "fade", "duration": "0.5s" },
  "children": [
    {
      "id": "slide-1",
      "type": "rect",
      "width": 640,
      "height": 360,
      "fill": "#1B2A4A",
      "timing": { "duration": "1.25s" }
    },
    {
      "id": "slide-2",
      "type": "rect",
      "width": 640,
      "height": 360,
      "fill": "#FF5A1F",
      "timing": { "duration": "1.25s" }
    }
  ]
}
```

### `component`

Reusable component expanded at evaluation time.

```json
{
  "id": "name-tag",
  "type": "component",
  "component": "LowerThird",
  "props": { "name": "Ada Lovelace", "role": "Engineer" },
  "x": 40,
  "y": 250
}
```

### `rect`

Rectangle, optionally rounded.

```json
{
  "id": "card",
  "type": "rect",
  "x": 120,
  "y": 80,
  "width": 400,
  "height": 200,
  "cornerRadius": 24,
  "fill": {
    "type": "linear",
    "stops": [{ "offset": 0, "color": "#FF5A1F" }, { "offset": 1, "color": "#8A2BE2" }],
    "start": { "x": 0, "y": 0 },
    "end": { "x": 1, "y": 1 }
  },
  "stroke": "#FFFFFF",
  "strokeWidth": 4
}
```

### `ellipse`

Ellipse inside the box. Equal width and height = circle.

```json
{
  "id": "dot",
  "type": "ellipse",
  "x": { "$keyframes": [{ "t": 0, "v": 40 }, { "t": "1s", "v": 520, "ease": "easeInOutCubic" }] },
  "y": 140,
  "width": 80,
  "height": 80,
  "fill": "#FF5A1F"
}
```

### `line`

Straight line between two points.

```json
{
  "id": "underline",
  "type": "line",
  "from": { "x": 80, "y": 180 },
  "to": { "x": 560, "y": 180 },
  "stroke": "#FFFFFF",
  "strokeWidth": 8,
  "strokeCap": "round",
  "trimEnd": { "$keyframes": [{ "t": 0, "v": 0 }, { "t": "1s", "v": 1, "ease": "easeOutCubic" }] }
}
```

### `polyline`

Open line through points.

```json
{
  "id": "trend",
  "type": "polyline",
  "points": [[40, 300], [200, 220], [360, 260], [600, 80]],
  "stroke": "#4F8CFF",
  "strokeWidth": 6,
  "strokeJoin": "round"
}
```

### `polygon`

Closed shape through points.

```json
{ "id": "triangle", "type": "polygon", "points": [[320, 60], [520, 300], [120, 300]], "fill": "#FFC857" }
```

### `path`

Vector path from SVG path data.

```json
{
  "id": "check",
  "type": "path",
  "d": "M 200 180 L 280 260 L 440 100",
  "stroke": "#3DDC97",
  "strokeWidth": 16,
  "strokeCap": "round",
  "strokeJoin": "round"
}
```

### `text`

Single-style text with wrapping, shaping and per-unit animation.

```json
{
  "id": "headline",
  "type": "text",
  "text": "Hello OpenVideo",
  "x": 40,
  "y": 140,
  "width": 560,
  "textAlign": "center",
  "fontSize": 56,
  "fontWeight": 700,
  "fill": "#F5F7FF",
  "textAnimation": { "unit": "char", "stagger": 2, "duration": 12, "from": { "opacity": 0, "y": 20 } }
}
```

### `rich-text`

Text with differently styled spans.

```json
{
  "id": "tagline",
  "type": "rich-text",
  "x": 40,
  "y": 150,
  "width": 560,
  "textAlign": "center",
  "fontSize": 44,
  "fill": "#F5F7FF",
  "spans": [{ "text": "Video as " }, { "text": "code", "fill": "#FF5A1F", "fontWeight": 800 }]
}
```

### `image`

Raster image from an asset.

```json
{
  "id": "logo-image",
  "type": "image",
  "asset": "logo",
  "x": 220,
  "y": 80,
  "width": 200,
  "height": 200,
  "fit": "contain"
}
```

### `video`

Video from an asset; its audio joins the mix unless muted.

```json
{
  "id": "clip-video",
  "type": "video",
  "asset": "clip",
  "width": 640,
  "height": 360,
  "fit": "cover",
  "muted": true
}
```

### `svg`

SVG from an asset or inline markup.

```json
{
  "id": "star",
  "type": "svg",
  "x": 270,
  "y": 130,
  "width": 100,
  "height": 100,
  "markup": "<svg xmlns=\"http://www.w3.org/2000/svg\" viewBox=\"0 0 24 24\"><path d=\"M12 2l3 7h7l-5.5 4 2 7-6.5-4.5L5.5 20l2-7L2 9h7z\" fill=\"#FFC857\"/></svg>"
}
```

### `sprite`

Frame from a sprite sheet grid.

```json
{
  "id": "walker",
  "type": "sprite",
  "asset": "walk-sheet",
  "columns": 4,
  "rows": 1,
  "frameRate": 8,
  "loop": true,
  "x": 270,
  "y": 130,
  "width": 100,
  "height": 100
}
```

### `lottie`

Lottie animation, frame-exact.

```json
{
  "id": "spinner-anim",
  "type": "lottie",
  "asset": "spinner",
  "x": 220,
  "y": 80,
  "width": 200,
  "height": 200,
  "loop": true
}
```

### `shader`

Custom shader filling the box. Uniforms `time`, `frame`, `resolution` are provided.

```json
{
  "id": "plasma",
  "type": "shader",
  "width": 640,
  "height": 360,
  "sksl": "uniform float time;\nuniform float2 resolution;\nhalf4 main(float2 coord) {\n  float2 uv = coord / resolution;\n  return half4(half(uv.x), half(uv.y), half(0.5 + 0.5 * sin(time * 3.0)), 1.0);\n}"
}
```

### `particles`

Stateless 2D particle system: particle state is a pure function of time and seed.

```json
{
  "id": "sparks",
  "type": "particles",
  "width": 640,
  "height": 360,
  "count": 200,
  "seed": 7,
  "emitter": { "x": 320, "y": 180, "radius": 10, "shape": "circle" },
  "lifetime": { "min": 0.5, "max": 1.5 },
  "speed": { "min": 60, "max": 180 },
  "angle": { "min": 0, "max": 360 },
  "size": { "start": 6, "end": 1 },
  "color": { "start": "#FFC857", "end": "#FF5A1F" }
}
```

### `html`

HTML/CSS/SVG/Canvas/WebGL content rendered by Chromium.

```json
{
  "id": "html-card",
  "type": "html",
  "x": 120,
  "y": 80,
  "width": 400,
  "height": 200,
  "html": "<div class=\"card\">Hello from HTML</div>",
  "css": ".card { font: 600 40px sans-serif; color: #FFFFFF; padding: 72px 40px; }",
  "background": "#1B2A4A"
}
```

### `subtitles`

Animated captions from a subtitle track. textAnimation animates each word from its own start time.

```json
{
  "id": "captions-view",
  "type": "subtitles",
  "track": "captions",
  "fontSize": 36,
  "style": "karaoke",
  "color": "#FFFFFF",
  "highlightColor": "#FFC857",
  "position": "bottom"
}
```

### `scene3d`

Real-time 3D scene rendered with Three.js.

```json
{
  "id": "stage",
  "type": "scene3d",
  "width": 640,
  "height": 360,
  "camera": "cam",
  "background": "#0B0D12",
  "children": [
    { "id": "cam", "type": "camera3d", "position": [0, 1.5, 5], "target": [0, 0, 0], "fov": 45 },
    {
      "id": "key",
      "type": "light3d",
      "kind": "directional",
      "position": [3, 5, 4],
      "intensity": 2.5,
      "castShadow": true
    },
    {
      "id": "cube",
      "type": "mesh3d",
      "geometry": { "type": "box" },
      "material": { "color": "#FF5A1F", "roughness": 0.4 },
      "rotation": [20, 35, 0]
    }
  ]
}
```

### `blender`

Offline 3D scene rendered with Blender (Cycles or Eevee).

```json
{
  "id": "hero-shot",
  "type": "blender",
  "width": 640,
  "height": 360,
  "engine": "eevee",
  "samples": 16,
  "camera": "cam",
  "children": [
    { "id": "cam", "type": "camera3d", "position": [0, 1.5, 5], "target": [0, 0, 0], "fov": 45 },
    {
      "id": "key",
      "type": "light3d",
      "kind": "directional",
      "position": [3, 5, 4],
      "intensity": 2.5,
      "castShadow": true
    },
    {
      "id": "ball",
      "type": "mesh3d",
      "geometry": { "type": "sphere", "radius": 1 },
      "material": { "color": "#4F8CFF", "metalness": 0.2, "roughness": 0.3 }
    }
  ]
}
```

### `camera3d`

3D camera.

```json
{ "id": "cam", "type": "camera3d", "position": [0, 1.5, 5], "target": [0, 0, 0], "fov": 45 }
```

### `light3d`

3D light.

```json
{
  "id": "key",
  "type": "light3d",
  "kind": "directional",
  "position": [3, 5, 4],
  "intensity": 2.5,
  "castShadow": true
}
```

### `mesh3d`

3D mesh with built-in geometry.

```json
{
  "id": "spinning-cube",
  "type": "mesh3d",
  "geometry": { "type": "box", "width": 1, "height": 1, "depth": 1 },
  "material": { "color": "#FF5A1F", "roughness": 0.4 },
  "rotation": { "$keyframes": [{ "t": 0, "v": [0, 0, 0] }, { "t": "2s", "v": [0, 180, 0] }] }
}
```

### `model3d`

glTF, GLB or OBJ model.

```json
{ "id": "robot-model", "type": "model3d", "asset": "robot", "position": [0, -1, 0], "scale": [1, 1, 1] }
```

### `instances3d`

Many instances of one mesh.

```json
{
  "id": "dot-field",
  "type": "instances3d",
  "geometry": { "type": "sphere", "radius": 0.08 },
  "material": { "color": "#4F8CFF" },
  "count": 100,
  "seed": 3,
  "layout": { "type": "grid", "columns": 10, "spacing": 0.3 },
  "position": [-1.35, -1.35, 0]
}
```

### `particles3d`

Stateless 3D particle system.

```json
{
  "id": "dust",
  "type": "particles3d",
  "count": 500,
  "seed": 1,
  "emitter": { "shape": "sphere", "size": 2 },
  "lifetime": { "min": 1, "max": 3 },
  "speed": { "min": 0.1, "max": 0.5 },
  "size": { "start": 0.05, "end": 0 },
  "color": { "start": "#FFFFFF", "end": "#4F8CFF" },
  "additive": true
}
```

### `group3d`

Groups 3D nodes.

```json
{
  "id": "rig",
  "type": "group3d",
  "rotation": { "$keyframes": [{ "t": 0, "v": [0, 0, 0] }, { "t": "2s", "v": [0, 90, 0] }] },
  "children": [
    {
      "id": "rig-left",
      "type": "mesh3d",
      "geometry": { "type": "sphere", "radius": 0.4 },
      "position": [-1, 0, 0],
      "material": { "color": "#FF5A1F" }
    },
    {
      "id": "rig-right",
      "type": "mesh3d",
      "geometry": { "type": "sphere", "radius": 0.4 },
      "position": [1, 0, 0],
      "material": { "color": "#4F8CFF" }
    }
  ]
}
```

<!-- node-examples:end -->
