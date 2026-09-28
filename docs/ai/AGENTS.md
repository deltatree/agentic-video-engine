# OpenVideo für Coding Agents

OpenVideo rendert Videos aus einer JSON-Beschreibung, der **Composition IR**.
Du beschreibst, prüfst, siehst dir Frames an, änderst gezielt und renderst das Video.
Jeder Frame ist eine reine Funktion von Composition, Assets, Frame-Nummer und Seed.

## 1. Der Kreislauf

| Schritt | Agent API / MCP-Tool | CLI |
|---|---|---|
| Projekt anlegen | `project.create` | `openvideo create hello` |
| Prüfen | `composition.validate` | `openvideo validate --json` |
| Frame ansehen | `frame.render` (liefert PNG) | `openvideo render-frame --frame 2s` |
| Mehrere Frames | `preview.contactSheet` | – |
| Verstehen | `frame.inspect`, `scene.describe`, `timeline.inspect` | `openvideo inspect --frame 2s` |
| Gezielt ändern | `composition.patch` | Datei bearbeiten |
| Video rendern | `video.render` → `render.status` | `openvideo render --format mp4` |

MCP einrichten (stdio): `openvideo mcp --workspace ./ov-workspace`.
Die Tools heißen wie die Operationen, mit `_` statt `.` (z. B. `frame_render`).

## 2. Minimales Projekt

```json
{
  "schemaVersion": "1.0.0",
  "compositions": [{
    "id": "main", "width": 1920, "height": 1080, "fps": 30, "duration": "5s", "background": "#0B0D12",
    "nodes": [
      { "id": "headline", "type": "text", "text": "Hello", "fontSize": 120, "x": 96, "y": 440, "width": 1728, "textAlign": "center" }
    ]
  }]
}
```

## 3. Regeln, die immer gelten

- **IDs**: jede Node hat eine eindeutige `id` (`^[A-Za-z][A-Za-z0-9_-]*$`). Patches adressieren Nodes über die ID.
- **Koordinaten**: Pixel, Ursprung oben links. `x`/`y` ist die linke obere Ecke der Box. Rotation in Grad um `origin` (Standard Mitte).
- **Zeit**: Zahl = Frames. Text: `"2s"`, `"500ms"`, `"48f"`, `"00:00:02:00"`, `"marker:intro+10f"`.
- **Farben**: `#RRGGBB` oder `#RRGGBBAA`.
- **3D**: Meter, y nach oben, Rotation in Grad, Nodes nur in `scene3d`/`blender`/`group3d`.
- **Keine Uhr, kein Zufall**: `random(i)` in Expressions ist deterministisch (Seed).

## 4. Animation

Jede animierbare Property ist ein Wert **oder** genau eine dieser Formen:

```jsonc
{ "$keyframes": [{ "t": 0, "v": 0 }, { "t": "1s", "v": 100, "ease": "easeOutCubic" }] }
{ "$spring": { "from": 0, "to": 1, "at": 20, "stiffness": 170, "damping": 26 } }
{ "$expr": "sin(time * 2) * 40" }
{ "$ref": "theme.colors.primary" }
```

- `ease` gilt für das Segment, das **auf** den Keyframe zuläuft. Standard `linear`.
- Easings: `linear`, `hold`, `easeIn|Out|InOut` + `Sine|Quad|Cubic|Quart|Quint|Expo|Circ|Back|Elastic|Bounce`, `cubic-bezier(a,b,c,d)`, `steps(n,end)`, `spring(stiffness,damping)`.
- Keyframes: `"loop": "repeat" | "pingpong"`, `"repeat": 3`, `"delay": "0.5s"`.
- Expressions: `frame`, `time`, `fps`, `duration`, `progress`, `seed`; Funktionen `sin cos clamp lerp smoothstep random noise wiggle ease marker …`.

Zeitfenster und Übergänge stehen an der Node:

```json
{ "id": "card", "type": "rect", "width": 400, "height": 200,
  "timing": { "from": "1s", "duration": "3s" },
  "transition": { "in": { "type": "fade", "duration": "0.5s" }, "out": { "type": "wipe-left", "duration": "0.4s" } } }
```

`timing` kennt außerdem `speed`, `reverse`, `loop` + `loopDuration`, `pingPong`, `remap` (Sekunden als animierte Zahl), `hold`.

## 5. Node-Typen

| Typ | Wichtige Properties |
|---|---|
| `group`, `layer` | `children`, `clip` (group); `blendMode`, `effects`, `colorSpace`, `motionBlur` (layer) |
| `rect`, `ellipse` | `width`, `height`, `cornerRadius`, `fill`, `stroke`, `strokeWidth` |
| `line`, `polyline`, `polygon`, `path` | `from`/`to`, `points`, `d`; `trimStart`/`trimEnd` für Linien-Animation |
| `text`, `rich-text` | `text`/`spans`, `fontFamily`, `fontSize`, `fontWeight`, `width`, `textAlign`, `textAnimation`, `background` |
| `image`, `video`, `svg`, `sprite`, `lottie` | `asset`, `width`, `height`, `fit` |
| `shader` | `sksl`, `uniforms` |
| `particles` | `count`, `seed`, `emitter`, `lifetime`, `speed`, `gravity`, `size`, `color` |
| `html` | `html`, `css`, `width`, `height` (Chromium, virtuelle Zeit) |
| `scene3d` | `children` (camera3d, light3d, mesh3d, model3d, instances3d, particles3d, group3d), `postprocessing`, `environment`, `backend` |
| `blender` | wie `scene3d`, dazu `engine` (`cycles`/`eevee`), `samples`, `pass` |
| `component` | `component` (z. B. `LowerThird`), `props` |
| `subtitles` | `track` (Untertitel-Track der Composition), `style` (`word-highlight`, `karaoke`, `pop` …) |
| `composition-ref` | `composition` (verschachtelte Composition, mit `timing.remap`) |

Alle 2D-Nodes haben `x`, `y`, `rotation`, `scale` (`{x,y}`), `skew`, `origin`, `opacity`, `blendMode`, `filters`, `shadow`, `mask`, `motionPath`.
Vollständige Felder: `packages/schema/openvideo.schema.json`. Render-Semantik: `docs/reference/node-semantics.md`.

## 6. Gezielt ändern (Patches)

```json
{ "projectId": "demo", "patches": [
  { "op": "setProperty", "nodeId": "headline", "property": "fontSize", "value": 82 },
  { "op": "setProperty", "nodeId": "headline", "property": "y", "value": 720 }
] }
```

Operationen: `setProperty`, `addNode`, `removeNode`, `moveNode`, `addKeyframe`, `removeKeyframe`, `replaceAsset`, `addAsset`, `removeAsset`, `setCompositionProperty`, `setProjectProperty`.
Eine Liste wird ganz oder gar nicht angewendet. Die Antwort enthält `inverse` für Undo.
Bei TSX-Projekten schreibt OpenVideo die Änderung per AST in den Quellcode zurück.

## 7. Diagnosen lesen

Jeder Fehler hat `code`, `problem`, `path` (z. B. `composition.main.nodes.logo.scale.x`) und `suggestions`.
Wichtige Codes:

| Code | Bedeutung | Typische Lösung |
|---|---|---|
| `OV_SCHEMA_*` | Wert passt nicht zum Schema | Vorschlag übernehmen |
| `OV_COMPONENT_PROPS` | Falsche Komponenten-Props | Erlaubte Props aus der Meldung |
| `OV_TEXT_OVERFLOW`, `OV_OVERFLOW` | Text passt nicht / ragt aus dem Bild | `fontSize` senken, `width` setzen |
| `OV_SAFE_AREA` | Außerhalb der sicheren Zone | nach innen verschieben |
| `OV_FONT_MISSING`, `OV_ASSET_MISSING` | Datei fehlt | `project.fonts` / `asset.import` |
| `OV_*_UNSUPPORTED` | Backend kann ein Feature nicht | anderes Backend (`renderer`) |
| `OV_SANDBOX_REQUIRED` | HTML-Skripte ohne Container | Container-Worker oder Skript entfernen |

## 8. Komponenten und Templates

`templates.list` zeigt 15 Templates (Product Launch, SaaS Explainer, Logo Reveal …).
Komponenten (29): Title, Subtitle, LowerThird, Callout, Badge, Card, BrowserWindow, CodeEditor, Terminal, Chart, BarChart, LineChart, PieChart, Table, Logo, DeviceFrame, Phone, Laptop, Cursor, Arrow, Connector, Grid, ParticleField, GradientBackground, Spotlight, GlassPanel, ProgressBar, Counter, Typewriter.

```json
{ "id": "lt", "type": "component", "component": "LowerThird", "props": { "name": "Ada Lovelace", "role": "Engineer" }, "x": 96, "y": 860 }
```

Die Props jeder Komponente stehen im Capability-Manifest (`docs/ai/capabilities.json`).
Ein Theme (`settings.theme`) färbt alle Komponenten um.

## 9. Audio, Stimme, Untertitel

```jsonc
"audio": [{ "id": "vo", "voice": { "provider": "piper", "text": "Welcome to OpenVideo." } }],
"compositions": [{ "tracks": [
  { "id": "voice", "kind": "audio", "role": "voiceover", "clips": [{ "id": "c1", "source": "vo", "start": "0.5s" }] },
  { "id": "music", "kind": "audio", "role": "music", "clips": [{ "id": "m", "source": "song", "start": 0, "volume": 0.6 }], "ducking": { "by": "voice", "amount": -12 } },
  { "id": "subs", "kind": "subtitle", "cues": [{ "start": "0.5s", "end": "2.5s", "text": "Welcome to OpenVideo." }] }
] }]
```

Stimmen werden einmal erzeugt und gecacht. Untertitel zeigt eine `subtitles`-Node mit `track: "subs"`.

## 10. Rezepte

Siehe `docs/guide/recipes.md`: Headline einblenden, Kamera fahren, Feature-Liste synchron zum Voiceover, Szenenwechsel, Datenvisualisierung, 3D-Produkt, Code-Tutorial, transparentes Lower Third.
