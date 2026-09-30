# OpenVideo für Coding Agents

OpenVideo rendert Videos aus einer JSON-Beschreibung, der **Composition IR**.
Du beschreibst, prüfst, siehst dir Frames an, änderst gezielt und renderst das Video.
Jeder Frame ist eine reine Funktion von Composition, Assets, Frame-Nummer und Seed.

Englische Fassung (maßgeblich, auch als MCP-Resource `openvideo://agents.md`): [AGENTS.md](AGENTS.md). Die JSON-Blöcke beider Fassungen sind identisch (geprüft von `packages/render/test/docs.test.ts`).

## 1. Der Kreislauf

| Schritt | Agent API / MCP-Tool | CLI |
|---|---|---|
| Projekt anlegen oder öffnen | `project.create`, `project.open` | `openvideo create hello` |
| Können und Schema abfragen | `capabilities.get`, `schema.get` | `openvideo op capabilities.get --input '{"nodeType":"text"}'` |
| Prüfen | `composition.validate` | `openvideo validate --json` |
| Frame ansehen | `frame.render` (liefert PNG) | `openvideo render-frame --frame 2s` |
| Mehrere Frames | `frame.renderMany`, `preview.contactSheet` | `openvideo contact-sheet --frames 0,2s,4s` |
| Verstehen | `frame.inspect`, `scene.describe`, `scene.tree`, `timeline.inspect` | `openvideo inspect --frame 2s` |
| Gezielt ändern | `composition.patch` | `openvideo patch --input @patches.json` |
| Importieren | `asset.import`, `project.import`, `subtitles.transcribe` | `openvideo import logo.svg` |
| Video rendern | `video.render` → `render.status` | `openvideo render --format mp4` |
| Plugins | `plugins.list`, `plugin.<name>` | `openvideo op plugins.list --input '{"projectId":"demo"}'` |

Alle 31 Operationen laufen gleich über HTTP (`POST /v1/<name>`), MCP und CLI (`openvideo op <name> --input <json|@datei>`; `openvideo op --list`).
Eingaben, Rückgabefelder und ein Beispiel je Operation: [docs/guide/api.md](../guide/api.md) (generiert, Englisch).

### Verbinden

- **MCP (stdio):** `openvideo mcp --project ./hello` öffnet ein bestehendes Projekt (seine `projectId` steht in den MCP-Instructions); `openvideo mcp --workspace ./ov-workspace` startet mit einem leeren Workspace. Die Tools heißen wie die Operationen, mit `_` statt `.` (z. B. `frame_render`). [examples/mcp.json](../../examples/mcp.json) ist eine Client-Konfiguration.
- **MCP-Resources:** `openvideo://agents.md` (englische Fassung dieser Datei), `openvideo://schema.json` (JSON Schema der IR), `openvideo://capabilities.json` (Node-Typen, Komponenten, Operationen, Backends dieses Hosts).
- **HTTP:** `openvideo serve` (Standard `127.0.0.1:7788`; jede andere Adresse braucht ein Token, `Authorization: Bearer <token>`). `GET /v1/operations` listet alle Operationen.
- **CLI ohne Server:** `openvideo op <name> --input '<json>'`. Job-Operationen (`video.render`, `preview.render`) warten und geben den Endstand des Jobs aus.

### Was die Operationen liefern

`project.create` liefert die `projectId`, die jede weitere Operation braucht:

```jsonc
// project.create { "name": "demo", "width": 640, "height": 360, "duration": "2s" }
{ "projectId": "demo", "compositions": ["main"], "diagnostics": [] }
```

`composition.patch` liefert `ok`, Diagnosen und die Patches in `inverse` (Undo):

```jsonc
// composition.patch { "projectId": "demo", "patches": [{ "op": "addNode", "parentId": null, "node": { "id": "headline", "type": "text", "text": "Hello" } }] }
{ "ok": true, "diagnostics": [], "inverse": [{ "op": "removeNode", "nodeId": "headline", "compositionId": "main" }], "sourceUpdated": false }
```

`frame.render` liefert das Bild (Datei, URL unter `/v1/files/…` und Base64-Daten, außer mit `"inline": false`; MCP zeigt es als Bild), den Frame-Schlüssel und ein Kurzmanifest (Abschnitt 12):

```jsonc
// frame.render { "projectId": "demo", "frame": "1s", "scale": 0.5, "inline": false }
{
  "image": { "file": "…/projects/demo/out/frames/main-30-c9780de1dd.png", "url": "/v1/files/demo/out/frames/main-30-c9780de1dd.png", "mimeType": "image/png", "width": 320, "height": 180 },
  "key": "sha256:c441…", "cached": false, "diagnostics": [],
  "manifest": { "kind": "frames", "frames": [{ "frame": 30, "key": "sha256:c441…", "hash": "sha256:cb83…", "cached": false }], "renderBackend": ["skia"], "…": "…" }
}
```

`video.render` startet einen Job; frage `render.status` ab, bis `state` `succeeded`, `failed` oder `cancelled` ist:

```jsonc
// video.render { "projectId": "demo", "profile": { "format": "mp4", "codec": "h264" } }
{ "jobId": "job-3a519d85-…", "state": "queued" }
// render.status { "jobId": "job-3a519d85-…" }
{
  "id": "job-3a519d85-…", "kind": "video.render", "projectId": "demo", "state": "succeeded",
  "progress": { "stage": "encode", "done": 60, "total": 60 },
  "result": { "outputs": [{ "file": "…/out/main.mp4", "url": "/v1/files/demo/out/main.mp4" }], "manifest": "…/out/main.mp4.render-manifest.json", "frames": 60, "framesRendered": 1, "framesFromCache": 59, "warnings": 0 }
}
```

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
- **3D**: Meter, y nach oben, Rotation in Grad; 3D-Nodes nur in `scene3d`/`blender`/`group3d`.
- **Keine Uhr, kein Zufall**: `random(i)` in Expressions ist deterministisch (Seed).

## 4. Animation

Jede animierbare Property ist ein Wert **oder** genau eine dieser Formen:

```jsonc
{ "$keyframes": [{ "t": 0, "v": 0 }, { "t": "1s", "v": 100, "ease": "easeOutCubic" }] }
{ "$spring": { "from": 0, "to": 1, "at": 20, "stiffness": 170, "damping": 26 } }
{ "$expr": "sin(time * 2) * 40" }
{ "$sampled": { "start": 0, "values": [0, 12, 24, 36] } }
{ "$ref": "theme.colors.primary" }
```

- `ease` gilt für das Segment, das **auf** den Keyframe zuläuft. Standard `linear`.
- Easings: `linear`, `hold`, `easeIn|Out|InOut` + `Sine|Quad|Cubic|Quart|Quint|Expo|Circ|Back|Elastic|Bounce`, `ease`, `easeIn`, `easeOut`, `easeInOut`, `cubic-bezier(x1,y1,x2,y2)`, `steps(n,start|end)`, `spring(stiffness,damping[,mass])`.
- Keyframes: `"loop": "repeat" | "pingpong"`, `"repeat": 3`, `"delay": "0.5s"`.
- Expressions: `frame`, `time`, `fps`, `duration`, `progress`, `seed`; Funktionen `sin cos clamp lerp mix smoothstep random randomRange noise wiggle ease marker event …` (vollständig: `expressionFunctions` in `capabilities.get`).
- `$sampled`: ein Wert je Frame. `values[i]` gilt im lokalen Frame `start + i` der Node (ohne `timing` gleich dem Frame der Composition); vor `start` gilt der erste Wert, nach dem Ende der letzte; Zwischenframes (z. B. mit `timing.speed`) werden linear interpoliert. Der TSX-Compiler schreibt Werte, die sich je Frame ändern, als `$sampled` (Abschnitt 10); von Hand brauchst du es selten.
- `$ref`: ein Wert aus dem Theme (`settings.theme`), z. B. `theme.colors.primary`.
- Benannte Events: Marker mit `kind: "event"` und `data`. `event("hit")` liefert die lokale Zeit des Events in Sekunden, `event("hit", "power")` ein Datenfeld (Wahrheitswerte als 0/1), z. B. `{ "$expr": "time >= event(\"hit\") ? 1 : 0" }`.

Eine Node, die vorberechneten Werten folgt:

```json
{ "id": "dot", "type": "ellipse", "width": 40, "height": 40, "y": 500,
  "x": { "$sampled": { "start": 0, "values": [100, 140, 190, 250, 320] } } }
```

Zeitfenster und Übergänge stehen an der Node:

```json
{ "id": "card", "type": "rect", "width": 400, "height": 200,
  "timing": { "from": "1s", "duration": "3s" },
  "transition": { "in": { "type": "fade", "duration": "0.5s" }, "out": { "type": "wipe-left", "duration": "0.4s" } } }
```

`timing` kennt außerdem `speed`, `reverse`, `loop` + `loopDuration`, `pingPong`, `remap` (Sekunden als animierte Zahl) und `hold`.
Übergänge: `fade`, `slide-left|right|up|down`, `wipe-left|right|up|down`, `zoom-in`, `zoom-out`, `blur`, `iris`.

## 5. Node-Typen

| Typ | Wichtige Properties |
|---|---|
| `group`, `layer` | `children`, `clip` (group); `blendMode`, `effects`, `colorSpace`, `crop`, `motionBlur` (layer) |
| `sequence` | `children` (je `timing.duration`) nacheinander; `between` / `transitions` (`{ "type": "fade", "duration": "0.5s" }` oder `{ "type": "cut" }`) überlappen und blenden automatisch über |
| `rect`, `ellipse` | `width`, `height`, `cornerRadius`, `fill`, `stroke`, `strokeWidth` |
| `line`, `polyline`, `polygon`, `path` | `from`/`to`, `points`, `d`; `trimStart`/`trimEnd` für Linien-Animation |
| `text`, `rich-text` | `text`/`spans`, `fontFamily`, `fontSize`, `fontWeight`, `width`, `textAlign`, `textAnimation`, `textPath`, `background` |
| `image`, `video`, `svg`, `sprite`, `lottie` | `asset`, `width`, `height`, `fit` |
| `shader` | `sksl` (Skia) und/oder `glsl` (PixiJS), `uniforms` |
| `particles` | `count`, `seed`, `emitter`, `lifetime`, `speed`, `gravity`, `size`, `color` |
| `html` | `html`, `css`, `width`, `height` (Chromium, virtuelle Zeit; Skripte nur mit `--trusted`) |
| `scene3d` | `children` (`camera3d`, `light3d`, `mesh3d`, `model3d`, `instances3d`, `particles3d`, `group3d`), `postprocessing`, `environment`, `backend` (`auto`, `webgpu`, `webgl2`) |
| `blender` | wie `scene3d`, dazu `engine` (`cycles`/`eevee`), `samples`, `pass` |
| `component` | `component` (z. B. `LowerThird`), `props` |
| `subtitles` | `track` (Untertitel-Track der Composition), `style` (`word-highlight`, `karaoke`, `pop` …) |
| `composition-ref` | `composition` (verschachtelte Composition, mit `timing.remap`) |

Alle 2D-Nodes haben `x`, `y`, `rotation`, `scale` (`{x,y}`), `skew`, `origin`, `opacity`, `zIndex` (animierbare Zeichenreihenfolge unter Geschwistern), `blendMode` (17 Blend Modes), `filters`, `shadow`, `mask`, `motionPath`.
Blend Mode, Maske und Wipe/Iris wirken auch über Backend-Grenzen (z. B. Text mit `overlay` über `scene3d`); animierte GIF/APNG in `image` laufen als Video.
Vollständige Felder: `packages/schema/openvideo.schema.json`. Render-Semantik: [docs/reference/node-semantics.de.md](../reference/node-semantics.de.md).
Ein gültiges JSON-Beispiel je Node-Typ und die Typen aller Properties liefert `capabilities.get` mit `{ "nodeType": "<typ>" }` (Felder `example`, `propertyTypes`); alle Beispiele stehen auch in `docs/reference/node-semantics.md` (Abschnitt 3).

## 6. Gezielt ändern (Patches)

```json
{ "projectId": "demo", "patches": [
  { "op": "setProperty", "nodeId": "headline", "property": "fontSize", "value": 82 },
  { "op": "setProperty", "nodeId": "headline", "property": "y", "value": 720 }
] }
```

Eine Liste wird ganz oder gar nicht angewendet. Die Antwort enthält `inverse` für Undo; `"dryRun": true` prüft nur.
Bei TSX-Projekten schreibt OpenVideo die Änderung per AST in den Quellcode zurück (`sourceUpdated: true`).
Das Feld `op` wählt die Patch-Art; jede Art hat feste Felder (`schema.get` mit `{ "name": "patch" }` liefert das JSON Schema).
`compositionId` ist optional, solange die Node-ID eindeutig ist. `value: null` löscht eine Property, außer mit `"keepNull": true`.

`setProperty` – eine Property setzen (auch Pfade wie `scale.x` und Animationen):

```json
{ "projectId": "demo", "patches": [{ "op": "setProperty", "nodeId": "headline", "property": "fontSize", "value": 82 }] }
```

`addNode` – neue Node einfügen; `parentId` ist eine Node-ID oder `null` (oberste Ebene), `index` die Position:

```json
{ "projectId": "demo", "patches": [{ "op": "addNode", "parentId": null, "node": { "id": "badge", "type": "rect", "x": 96, "y": 96, "width": 240, "height": 64, "cornerRadius": 12, "fill": "#FF5A1F" } }] }
```

`removeNode` – Node mit Kindern entfernen:

```json
{ "projectId": "demo", "patches": [{ "op": "removeNode", "nodeId": "f1" }] }
```

`moveNode` – Eltern oder Reihenfolge ändern (Z-Order; `zIndex` hat unter Geschwistern Vorrang):

```json
{ "projectId": "demo", "patches": [{ "op": "moveNode", "nodeId": "headline", "parentId": null, "index": 1 }] }
```

`addKeyframe` – Keyframe setzen; ein fester Wert wird zu `$keyframes`:

```json
{ "projectId": "demo", "patches": [{ "op": "addKeyframe", "nodeId": "headline", "property": "opacity", "keyframe": { "t": "1s", "v": 1, "ease": "easeOutCubic" } }] }
```

`removeKeyframe` – Keyframe zur Zeit `t` entfernen:

```json
{ "projectId": "demo", "patches": [
  { "op": "addKeyframe", "nodeId": "headline", "property": "opacity", "keyframe": { "t": "1s", "v": 1 } },
  { "op": "removeKeyframe", "nodeId": "headline", "property": "opacity", "t": "1s" }
] }
```

`addAsset`, `replaceAsset`, `removeAsset` – Assets deklarieren, austauschen, entfernen (`asset.import` kopiert zusätzlich die Datei):

```json
{ "projectId": "demo", "patches": [{ "op": "addAsset", "asset": { "id": "music", "type": "audio", "src": "assets/music.wav" } }] }
```

```json
{ "projectId": "demo", "patches": [
  { "op": "addAsset", "asset": { "id": "music", "type": "audio", "src": "assets/music.wav" } },
  { "op": "replaceAsset", "assetId": "music", "src": "assets/music-v2.wav" }
] }
```

```json
{ "projectId": "demo", "patches": [
  { "op": "addAsset", "asset": { "id": "music", "type": "audio", "src": "assets/music.wav" } },
  { "op": "removeAsset", "assetId": "music" }
] }
```

`setCompositionProperty` und `setProjectProperty` – Composition (Hintergrund, Dauer, Marker) oder Projekt (Metadaten, Theme, Einstellungen) ändern:

```json
{ "projectId": "demo", "patches": [{ "op": "setCompositionProperty", "compositionId": "main", "property": "background", "value": "#101218" }] }
```

```json
{ "projectId": "demo", "patches": [{ "op": "setProjectProperty", "property": "metadata.title", "value": "Launch video" }] }
```

### Vorschau ohne Speichern

`frame.render` nimmt dieselbe Patch-Liste als `patches`: Sie gilt nur für diesen Render und wird nie gespeichert (das Studio nutzt das beim Ziehen). Abgelehnte Patches scheitern mit `OV_PREVIEW_PATCH`. Prüfe so eine geplante Änderung und sende sie dann mit `composition.patch`:

```json
{ "projectId": "demo", "frame": "2s", "scale": 0.5, "patches": [{ "op": "setProperty", "nodeId": "headline", "property": "fill", "value": "#FF5A1F" }] }
```

## 7. Diagnosen lesen

Jeder Fehler hat `code`, `problem`, `path` (z. B. `composition.main.nodes.logo.scale.x`, bei Patches `patches[3]` oder `patches[3].nodeId`), `expected`, `received` und mindestens einen Eintrag in `suggestions`.
Bei Tippfehlern (Node-ID, Patch-Art, Feldname, Komponente) nennt der erste Vorschlag den nächsten gültigen Namen:

```jsonc
// composition.patch with "nodeId": "headlin"
{ "ok": false, "inverse": [], "sourceUpdated": false, "diagnostics": [{
  "code": "OV_PATCH_INVALID", "severity": "error", "errorClass": "PatchError",
  "problem": "Patch 1 (setProperty): Node \"headlin\" does not exist.",
  "path": "patches[0]", "nodeId": "headlin", "expected": "an existing node id", "received": "\"headlin\"",
  "suggestions": ["Did you mean \"headline\"?", "Use scene.tree or composition.get to list node ids."]
}] }
```

Wichtige Codes:

| Code | Bedeutung | Typische Lösung |
|---|---|---|
| `OV_SCHEMA_*` | Wert passt nicht zum Schema | Vorschlag übernehmen |
| `OV_COMPONENT_PROPS` | Falsche Komponenten-Props | Erlaubte Props aus der Meldung |
| `OV_TEXT_OVERFLOW`, `OV_OVERFLOW` | Text passt nicht / ragt aus dem Bild | `fontSize` senken, `width` setzen |
| `OV_SAFE_AREA` | Außerhalb der sicheren Zone | nach innen verschieben |
| `OV_FONT_MISSING`, `OV_ASSET_MISSING` | Datei fehlt | `project.fonts` / `asset.import` |
| `OV_*_UNSUPPORTED` | Backend kann ein Feature nicht | anderes Backend (`renderer`) |
| `OV_PIXI_FALLBACK` (Info) | Mit `renderer2d: "pixi"` rendert Skia diese Node | nichts zu tun; siehe `details.features` |
| `OV_SANDBOX_REQUIRED` | HTML-Skripte ohne Container | Container-Worker oder Skript entfernen |
| `OV_PATCH_INVALID` | Patch passt nicht (Feld, Typ, unbekannte Node) | `path` und `expected` lesen, Vorschlag übernehmen |
| `OV_PREVIEW_PATCH` | Vorschau-Patches von `frame.render` abgelehnt | mit `composition.patch` und `"dryRun": true` prüfen |
| `OV_IMPORT_LOSSY` | Import hat etwas nicht übernommen (Warnung) | Effekt mit IR-Mitteln nachbauen |
| `OV_ASR_UNAVAILABLE` | Keine Spracherkennung installiert | whisper.cpp installieren oder Cues selbst schreiben |
| `OV_PLUGIN_NOT_ALLOWED` | Projekt hat `settings.plugins`, der Host erlaubt keine Plugins | `--trusted` oder `OPENVIDEO_ALLOW_PLUGINS=1` |
| `OV_THREE_GRAPHICS_MISMATCH` | Die GPU erlaubt kleinere Texturen als die gespeicherte Grafik-Probe im Schlüssel | `openvideo cache clear --tier layer` oder auf der Maschine der Probe rendern |

## 8. Komponenten und Templates

`templates.list` zeigt 15 Templates (Product Launch, SaaS Explainer, Logo Reveal …); `project.create` mit `"template": "<name>"` startet mit einem davon.
Komponenten (29): Title, Subtitle, LowerThird, Callout, Badge, Card, BrowserWindow, CodeEditor, Terminal, Chart, BarChart, LineChart, PieChart, Table, Logo, DeviceFrame, Phone, Laptop, Cursor, Arrow, Connector, Grid, ParticleField, GradientBackground, Spotlight, GlassPanel, ProgressBar, Counter, Typewriter.

```json
{ "id": "lt", "type": "component", "component": "LowerThird", "props": { "name": "Ada Lovelace", "role": "Engineer" }, "x": 96, "y": 860 }
```

`capabilities.get` mit `{ "component": "<name>" }` liefert das Props-Schema und ein Beispiel (auch in `docs/ai/capabilities.json`).
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
Cues aus einer Aufnahme erzeugt `subtitles.transcribe` (`{ "projectId": "demo", "trackId": "subs", "source": "vo-file" }`) mit einem installierten ASR-Provider (whisper.cpp); `tracks[].fromAudio` gibt Quelle und Provider vor.

## 10. TSX-Projekte

`openvideo create hello --tsx` schreibt `src/video.tsx`; `project.create` nimmt TSX als `source`. JSX ist nur Syntax: Der Compiler macht aus der Datei dieselbe IR und schreibt sie nach `project.json`.

```tsx
import { composition, Scene, Rect, Text, animate } from '@agentic-video/sdk';

export default composition({
  id: 'main', width: 1920, height: 1080, fps: 30, duration: '5s',
  scene: ({ frame }) => (
    <Scene background="#0B0D12">
      <Rect id="bar" x={96 + frame * 4} y={900} width={200} height={16} fill="#FF5A1F" />
      <Text id="headline" text="Hello" fontSize={120} x={96} y={440} width={1728} textAlign="center"
        opacity={animate(0, 1, { from: 0, duration: '0.6s' })} />
    </Scene>
  ),
});
```

- TSX ist Code. OpenVideo kompiliert und führt ihn in einem Docker-Container ohne Netz aus; `--trusted` führt dein **eigenes** Projekt auf dem Host aus. Läuft `openvideo` selbst in einem Container (Standard von `npm run setup`; `openvideo doctor` nennt die Laufzeit), gibt es darin kein Docker: Für dein eigenes Projekt `--trusted` nutzen – es läuft in diesem Container, der nur die eingehängten Ordner sieht.
- Werte, die sich je Frame ändern (`frame * 4`), werden `$sampled`. Die Helfer `animate`, `keyframes`, `spring({ from, to, … })`, `expr` und `ref` erzeugen `$keyframes`, `$spring`, `$expr` und `$ref` (kleinere IR, mit `addKeyframe` änderbar); `spring({ frame, … })` (Remotion-Form) liefert eine Zahl und wird deshalb `$sampled`; `stagger` und `sequence` berechnen Start-Frames.
- `composition.patch` ändert die TSX-Quelle über den AST (`sourceUpdated: true`); gib jedem Element, das du ändern willst, ein `id`-Attribut. Ein Patch, der sich nicht zurückschreiben lässt, wird abgelehnt; die Quelle bleibt unverändert.
- `openvideo dev` kompiliert beim Speichern neu; Kompilierfehler stehen im Terminal, das Studio behält den letzten guten Stand.
- Mehr: [`packages/sdk/README.md`](../../packages/sdk/README.md) und [`examples/explainer-tsx`](../../examples/explainer-tsx/README.md).

## 11. Importe

`project.import` übernimmt SVG, Lottie, glTF, HTML (Datei im Projekt über `path` oder Inhalt über `content`) sowie eine Anime.js-Timeline und Motion-Canvas-Szenen als JSON.
Was nicht übertragbar ist, meldet eine Warnung `OV_IMPORT_LOSSY` mit Pfad; `"dryRun": true` zeigt das Ergebnis ohne zu speichern.
Beispiel Anime.js: `{ "projectId": "demo", "format": "anime", "content": { "entries": [{ "targets": "headline", "params": { "opacity": [0, 1], "y": [40, 0], "duration": 600, "ease": "outCubic" } }] } }`.

## 12. Manifeste

- `video.render` schreibt `<datei>.render-manifest.json` neben das Video: Versionen aller Komponenten, genutzte Backends, Grafik-Modus, GPU, Encoder-Argumente und einen Hash je Frame.
- `frame.render`, `frame.renderMany` und `preview.contactSheet` liefern ein **Kurzmanifest** (`kind: "frames"`) als `manifest`: Eingaben (`compositionHash`, `projectHash`), `frames[]` mit Cache-Schlüssel `key` und Pixel-Hash `hash`, `renderBackend`, `graphics`, `chromiumVersion`, `gpu`. Die CLI schreibt es mit `render-frame --manifest` und `contact-sheet --manifest`.
- Gleiche Eingaben ergeben denselben Pixel-Hash. Vergleiche Hashes statt Bilder, um zu prüfen, ob eine Änderung einen Frame berührt hat (oder nicht).

Felder: [docs/reference/render-manifest.de.md](../reference/render-manifest.de.md).

## 13. Plugins

Ein Projekt nennt Plugin-Module in `settings.plugins`; sie laden nur, wenn der Host es erlaubt (`--trusted` oder `OPENVIDEO_ALLOW_PLUGINS=1`, Rechte über `OPENVIDEO_PLUGIN_PERMISSIONS`).

- `plugins.list { "projectId": "demo" }` liefert `plugins`, `tools` (mit Eingabe-Schema), `codecs`, `exporters`, `assetLoaders` und `studioPanels`.
- Agent Tools aus Plugins sind Operationen `plugin.<name>`: `POST /v1/plugin.<name>`, MCP-Tool `plugin_<name mit _>` (gelistet, wenn der MCP-Server ein offenes Projekt hat), `openvideo op plugin.<name> --project <ordner> --trusted --input '<json>'`. Die Eingabe ist `projectId` plus die Felder des Tools.
- Codecs und Exporter erscheinen als `"codec": "plugin:<id>"` und `"format": "plugin:<id>"` im Render-Profil.

Details: [docs/guide/plugins.md](../guide/plugins.md) (Englisch).

## 14. Live-Sync mit Menschen

`openvideo dev` (Studio) und Agents arbeiten gleichzeitig am selben Projekt. `GET /v1/events?projectId=<id>` liefert Server-Sent Events `revision` (`{ "projectId", "revision" }`, die erste Nachricht ist der aktuelle Stand); die Revision ist der SHA-256 von `project.json` und zugleich dessen `ETag` unter `/v1/files/<projectId>/project.json`. Lies das Projekt nach einer Fremdänderung neu (`composition.get`), bevor du früher berechnete Koordinaten patchst.

## 15. Renderer und Determinismus

- 2D rendert standardmäßig mit Skia (bitgleich auf jeder Maschine). `settings.renderer2d: "pixi"` nutzt PixiJS (WebGL in Chromium), wo es geht, und fällt pro Node auf Skia zurück (`OV_PIXI_FALLBACK`); ein explizites `renderer` an der Node hat Vorrang.
- `scene3d` mit `backend: "auto"` (Standard) bevorzugt WebGPU und fällt auf WebGL2 zurück; die Wahl wird je Chromium einmal geprüft und steht im Manifest (`graphics.threeBackends`).
- `OPENVIDEO_BROWSER_GPU=1` rendert WebGL/WebGPU auf der GPU des Hosts statt mit SwiftShader: schneller, nicht bitgleich, eigene Cache-Schlüssel.
- Ein zweiter Render zeichnet nur Frames neu, deren Eingaben sich geändert haben; ein identischer Video-Render nutzt die ganze Ausgabedatei wieder.

## 16. Rezepte und Beispiele

Siehe [docs/guide/recipes.de.md](../guide/recipes.de.md): Headline einblenden, Kamera fahren, Feature-Liste synchron zum Voiceover, Szenenwechsel, Datenvisualisierung, 3D-Produkt, Code-Tutorial, transparentes Lower Third.
Fünf vollständige Beispielprojekte mit README und Test liegen in `examples/` (`product-launch`, `explainer-tsx`, `data-story`, `3d-showcase`, `social-vertical`).
