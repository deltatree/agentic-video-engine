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

- **shader**: füllt die Box. SkSL-Signatur `half4 main(float2 coord)`, `coord` in lokalen Pixeln. Uniforms `time` (Sekunden), `frame`, `resolution` (float2) plus eigene.
- **particles**: Zustand aus `particles2d(node, localTimeSeconds, fps)`. Form `circle` (Standard), `square`, `spark` (Strich in Bewegungsrichtung, Länge = 3 × Größe). Koordinaten relativ zur Box.

### Browser

- **html**: Chromium rendert `html` + `css` in eine Box `width × height`; die Box wird mit der Node-Matrix platziert. Die Seite erhält pro Frame die Zeit über `window.openvideo` (siehe Browser-Renderer-Doku). CSS-Animationen werden pausiert und auf die lokale Zeit gesetzt.

### 3D

- **scene3d**: rendert Kinder mit Three.js in eine Box `width × height`, platziert mit der Node-Matrix. `background` Standard transparent. `camera` Standard: erste `camera3d`; ohne Kamera eine Perspektivkamera bei `[0, 0, 5]` mit Blick auf den Ursprung.
- **camera3d**: `fov` 50, `near` 0.1, `far` 1000, `projection` `perspective`. `target` bestimmt die Blickrichtung, sonst gilt `rotation`.
- **light3d**: `intensity` 1, `color` `#FFFFFF`.
- **mesh3d**, **model3d**, **instances3d**, **particles3d**, **group3d**: Position in Metern, Rotation XYZ in Grad.
- **blender**: wie `scene3d`, gerendert mit Blender. `particles3d` wird als Instanzen übertragen (je lebendes Partikel eine unbeleuchtete Kugel, gleiche Formel wie Three.js). `motionBlur: true`: Der Frame-Render übergibt die Zustände bei ±0,25 Frames (Verschlusszeit ½ Frame); Blender interpoliert Position, Rotation und Skalierung linear dazwischen.
