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
| `group`, `layer` | `(0, 0, width ?? 0, height ?? 0)` |
| `line` | Hülle von `from` und `to` |
| `polyline`, `polygon` | Hülle der Punkte |
| `path` | Hülle aller Koordinaten (`pathBounds`) |
| `text`, `rich-text` | `(0, 0, gemessene Breite, gemessene Höhe)`; mit `width` ist die Breite fest |

Fehlen bei `image`, `video`, `svg`, `sprite` die Maße, gilt die Eigengröße des Assets.

### 1.4 Darstellung

| Property | Bedeutung | Standard |
|---|---|---|
| `opacity` | Multipliziert die Deckkraft der Node und aller Kinder (als Gruppe). | 1 |
| `blendMode` | Mischt die Node mit dem, was darunter im selben Layer liegt (sRGB-Raum). | `normal` |
| `filters` | Liste, in Reihenfolge angewendet. `blur.radius` ist die Standardabweichung in Pixeln (wie CSS `blur()`). `brightness`, `contrast`, `saturate`, `grayscale`, `sepia`, `invert`, `hue-rotate` wie CSS. | – |
| `shadow` | Schlagschatten der ganzen Node. `blur` ist die Standardabweichung. | – |
| `mask` | Die Masken-Node liegt im **lokalen Koordinatensystem der maskierten Node** (sie bewegt sich mit). `alpha`: Deckkraft der Maske; `luminance`: Helligkeit × Alpha. `invert` kehrt um. | `alpha` |
| `clip` (nur `group`) | Beschneidet Kinder auf die Box der Gruppe. | `false` |
| `reveal` (aus Übergängen) | Beschneidet die Node auf `revealShape(reveal, box)` in lokalen Box-Koordinaten. | – |

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
- **layer**: wie `group`, bildet aber immer einen eigenen Compositor-Layer. Zusätzlich `colorSpace`, `crop`, `effects`, `motionBlur`.
- **composition-ref**, **component**, **subtitles**: werden vor dem Rendern expandiert. Renderer sehen sie nie.

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
- `textPath`: Glyphen folgen dem Pfad ab `offset` Pixeln.
- `fill` als Verlauf füllt die Textbox; `stroke` zeichnet Glyphenkonturen.
- `textAnimation`: Jede Einheit (Zeichen, Wort, Zeile) geht von `from` in den Normalzustand über. Den Zustand berechnet `textUnitState(node, i, count, localFrame, fps)`; die Aufteilung `splitTextUnits`. Verschiebung und Skalierung wirken um die Mitte der Einheit.
- `background`: Box hinter dem gemessenen Text (`color`, `paddingX`, `paddingY`, `radius`); mit `perLine: true` eine Box je Zeile. Die Box gehört zur Node (Opacity, Transform, Maske wirken mit).
- `rich-text`: `spans` mit eigenen Stilen; Stil-Properties der Node sind Standard für alle Spans.

### Medien

- **image**: `fit` Standard `fill` bei gesetzten Maßen. `contain`/`cover` zentrieren. `smoothing` Standard `linear`.
- **video**: Quellzeit = `startFrom + localTime · playbackRate`; mit `loop` modulo Dauer, sonst geklemmt. Das Bild liefert `AssetResolver.videoFrame(asset, sekunden)`.
- **svg**: Asset oder `markup` in die Box skaliert (`fit` Standard `contain`).
- **sprite**: Rasterbild mit `columns × rows` Zellen, zeilenweise nummeriert. Index = `frame`, sonst `floor(localTime · frameRate)`; mit `loop` modulo `frameCount`, sonst geklemmt.
- **lottie**: Zeit = `localTime · speed + frameOffset / lottieFps`; mit `loop` modulo Dauer.

### Effekte

- **shader**: füllt die Box. SkSL-Signatur `half4 main(float2 coord)`, `coord` in lokalen Pixeln. Uniforms `time` (Sekunden), `frame`, `resolution` (float2) plus eigene.
- **particles**: Zustand aus `particles2d(node, localTimeSeconds, fps)`. Form `circle` (Standard), `square`, `spark` (Strich in Bewegungsrichtung, Länge = 3 × Größe). Koordinaten relativ zur Box.

### Browser

- **html**: Chromium rendert `html` + `css` in eine Box `width × height`; die Box wird mit der Node-Matrix platziert. Die Seite erhält pro Frame die Zeit über `window.openvideo` (siehe Browser-Renderer-Doku). CSS-Animationen werden pausiert und auf die lokale Zeit gesetzt.

### 3D

- **scene3d**: rendert Kinder mit Three.js in eine Box `width × height`, platziert mit der Node-Matrix. `background` Standard transparent. `camera` Standard: erste `camera3d`; ohne Kamera eine Perspektivkamera bei `[0, 0, 5]` mit Blick auf den Ursprung.
- **camera3d**: `fov` 50, `near` 0.1, `far` 1000, `projection` `perspective`. `target` bestimmt die Blickrichtung, sonst gilt `rotation`.
- **light3d**: `intensity` 1, `color` `#FFFFFF`.
- **mesh3d**, **model3d**, **instances3d**, **particles3d**, **group3d**: Position in Metern, Rotation XYZ in Grad.
- **blender**: wie `scene3d`, gerendert mit Blender.
