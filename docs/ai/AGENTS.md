# OpenVideo for coding agents

OpenVideo renders videos from a JSON description, the **Composition IR**.
You describe, validate, look at frames, change things precisely and render the video.
Every frame is a pure function of composition, assets, frame number and seed.

German version: [AGENTS.de.md](AGENTS.de.md). The MCP resource `openvideo://agents.md` is this English file.

## 1. The loop

| Step | Agent API / MCP tool | CLI |
|---|---|---|
| Create or open a project | `project.create`, `project.open` | `openvideo create hello` |
| Ask what the host can do | `capabilities.get`, `schema.get` | `openvideo op capabilities.get --input '{"nodeType":"text"}'` |
| Validate | `composition.validate` | `openvideo validate --json` |
| Look at a frame | `frame.render` (returns a PNG) | `openvideo render-frame --frame 2s` |
| Several frames | `frame.renderMany`, `preview.contactSheet` | `openvideo contact-sheet --frames 0,2s,4s` |
| Understand | `frame.inspect`, `scene.describe`, `scene.tree`, `timeline.inspect` | `openvideo inspect --frame 2s` |
| Change precisely | `composition.patch` | `openvideo patch --input @patches.json` |
| Import | `asset.import`, `project.import`, `subtitles.transcribe` | `openvideo import logo.svg` |
| Render the video | `video.render` → `render.status` | `openvideo render --format mp4` |
| Plugins | `plugins.list`, `plugin.<name>` | `openvideo op plugins.list --input '{"projectId":"demo"}'` |

All 31 operations work the same over HTTP (`POST /v1/<name>`), MCP and the CLI (`openvideo op <name> --input <json|@file>`; `openvideo op --list`).
Inputs, return fields and one example per operation: [docs/guide/api.md](../guide/api.md) (generated).

### Connect

- **MCP (stdio):** `openvideo mcp --project ./hello` opens an existing project (its `projectId` is in the MCP instructions); `openvideo mcp --workspace ./ov-workspace` starts with an empty workspace. Tools are named like the operations with `_` instead of `.` (for example `frame_render`). [examples/mcp.json](../../examples/mcp.json) is a client configuration.
- **MCP resources:** `openvideo://agents.md` (this file), `openvideo://schema.json` (JSON Schema of the IR), `openvideo://capabilities.json` (node types, components, operations, backends of this host).
- **HTTP:** `openvideo serve` (default `127.0.0.1:7788`; any other address needs a token, `Authorization: Bearer <token>`). `GET /v1/operations` lists all operations.
- **CLI without a server:** `openvideo op <name> --input '<json>'`. Job operations (`video.render`, `preview.render`) wait and print the final job status.

### What the operations return

`project.create` returns the `projectId` you pass to every other operation:

```jsonc
// project.create { "name": "demo", "width": 640, "height": 360, "duration": "2s" }
{ "projectId": "demo", "compositions": ["main"], "diagnostics": [] }
```

`composition.patch` returns `ok`, diagnostics and the `inverse` patches (undo):

```jsonc
// composition.patch { "projectId": "demo", "patches": [{ "op": "addNode", "parentId": null, "node": { "id": "headline", "type": "text", "text": "Hello" } }] }
{ "ok": true, "diagnostics": [], "inverse": [{ "op": "removeNode", "nodeId": "headline", "compositionId": "main" }], "sourceUpdated": false }
```

`frame.render` returns the image (a file, a URL under `/v1/files/…`, and base64 data unless `"inline": false`; MCP shows it as an image), the frame cache key and a short manifest (section 12):

```jsonc
// frame.render { "projectId": "demo", "frame": "1s", "scale": 0.5, "inline": false }
{
  "image": { "file": "…/projects/demo/out/frames/main-30-c9780de1dd.png", "url": "/v1/files/demo/out/frames/main-30-c9780de1dd.png", "mimeType": "image/png", "width": 320, "height": 180 },
  "key": "sha256:c441…", "cached": false, "diagnostics": [],
  "manifest": { "kind": "frames", "frames": [{ "frame": 30, "key": "sha256:c441…", "hash": "sha256:cb83…", "cached": false }], "renderBackend": ["skia"], "…": "…" }
}
```

`video.render` starts a job; poll `render.status` until `state` is `succeeded`, `failed` or `cancelled`:

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

## 2. Minimal project

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

## 3. Rules that always apply

- **IDs**: every node has a unique `id` (`^[A-Za-z][A-Za-z0-9_-]*$`). Patches address nodes by id.
- **Coordinates**: pixels, origin top left. `x`/`y` is the top left corner of the box. Rotation in degrees around `origin` (default: center).
- **Time**: a number is frames. Text: `"2s"`, `"500ms"`, `"48f"`, `"00:00:02:00"`, `"marker:intro+10f"`.
- **Colors**: `#RRGGBB` or `#RRGGBBAA`.
- **3D**: meters, y up, rotation in degrees; 3D nodes only inside `scene3d`/`blender`/`group3d`.
- **No clock, no randomness**: `random(i)` in expressions is deterministic (seed).

## 4. Animation

Every animatable property is a value **or** exactly one of these forms:

```jsonc
{ "$keyframes": [{ "t": 0, "v": 0 }, { "t": "1s", "v": 100, "ease": "easeOutCubic" }] }
{ "$spring": { "from": 0, "to": 1, "at": 20, "stiffness": 170, "damping": 26 } }
{ "$expr": "sin(time * 2) * 40" }
{ "$sampled": { "start": 0, "values": [0, 12, 24, 36] } }
{ "$ref": "theme.colors.primary" }
```

- `ease` applies to the segment that runs **into** the keyframe. Default `linear`.
- Easings: `linear`, `hold`, `easeIn|Out|InOut` + `Sine|Quad|Cubic|Quart|Quint|Expo|Circ|Back|Elastic|Bounce`, `ease`, `easeIn`, `easeOut`, `easeInOut`, `cubic-bezier(x1,y1,x2,y2)`, `steps(n,start|end)`, `spring(stiffness,damping[,mass])`.
- Keyframes: `"loop": "repeat" | "pingpong"`, `"repeat": 3`, `"delay": "0.5s"`.
- Expressions: `frame`, `time`, `fps`, `duration`, `progress`, `seed`; functions `sin cos clamp lerp mix smoothstep random randomRange noise wiggle ease marker event …` (full list: `expressionFunctions` in `capabilities.get`).
- `$sampled`: one value per frame. `values[i]` applies at local frame `start + i` of the node (equal to the composition frame without `timing`); before `start` the first value holds, after the end the last; fractional frames (e.g. with `timing.speed`) interpolate linearly. The TSX compiler writes values that change per frame as `$sampled` (section 10); you rarely write it by hand.
- `$ref`: a value from the theme (`settings.theme`), for example `theme.colors.primary`.
- Named events: markers with `kind: "event"` and `data`. `event("hit")` returns the local time of the event in seconds, `event("hit", "power")` a data field (booleans as 0/1), for example `{ "$expr": "time >= event(\"hit\") ? 1 : 0" }`.

A node that follows precomputed values:

```json
{ "id": "dot", "type": "ellipse", "width": 40, "height": 40, "y": 500,
  "x": { "$sampled": { "start": 0, "values": [100, 140, 190, 250, 320] } } }
```

Time window and transitions live on the node:

```json
{ "id": "card", "type": "rect", "width": 400, "height": 200,
  "timing": { "from": "1s", "duration": "3s" },
  "transition": { "in": { "type": "fade", "duration": "0.5s" }, "out": { "type": "wipe-left", "duration": "0.4s" } } }
```

`timing` also knows `speed`, `reverse`, `loop` + `loopDuration`, `pingPong`, `remap` (seconds as an animated number) and `hold`.
Transitions: `fade`, `slide-left|right|up|down`, `wipe-left|right|up|down`, `zoom-in`, `zoom-out`, `blur`, `iris`.

## 5. Node types

| Type | Important properties |
|---|---|
| `group`, `layer` | `children`, `clip` (group); `blendMode`, `effects`, `colorSpace`, `crop`, `motionBlur` (layer) |
| `sequence` | `children` (each with `timing.duration`) one after another; `between` / `transitions` (`{ "type": "fade", "duration": "0.5s" }` or `{ "type": "cut" }`) overlap and cross-fade automatically |
| `rect`, `ellipse` | `width`, `height`, `cornerRadius`, `fill`, `stroke`, `strokeWidth` |
| `line`, `polyline`, `polygon`, `path` | `from`/`to`, `points`, `d`; `trimStart`/`trimEnd` to draw lines on |
| `text`, `rich-text` | `text`/`spans`, `fontFamily`, `fontSize`, `fontWeight`, `width`, `textAlign`, `textAnimation`, `textPath`, `background` |
| `image`, `video`, `svg`, `sprite`, `lottie` | `asset`, `width`, `height`, `fit` |
| `shader` | `sksl` (Skia) and/or `glsl` (PixiJS), `uniforms` |
| `particles` | `count`, `seed`, `emitter`, `lifetime`, `speed`, `gravity`, `size`, `color` |
| `html` | `html`, `css`, `width`, `height` (Chromium, virtual time; scripts only with `--trusted`) |
| `scene3d` | `children` (`camera3d`, `light3d`, `mesh3d`, `model3d`, `instances3d`, `particles3d`, `group3d`), `postprocessing`, `environment`, `backend` (`auto`, `webgpu`, `webgl2`) |
| `blender` | like `scene3d`, plus `engine` (`cycles`/`eevee`), `samples`, `pass` |
| `component` | `component` (for example `LowerThird`), `props` |
| `subtitles` | `track` (subtitle track of the composition), `style` (`word-highlight`, `karaoke`, `pop` …) |
| `composition-ref` | `composition` (nested composition, with `timing.remap`) |

All 2D nodes have `x`, `y`, `rotation`, `scale` (`{x,y}`), `skew`, `origin`, `opacity`, `zIndex` (animatable drawing order among siblings), `blendMode` (17 blend modes), `filters`, `shadow`, `mask`, `motionPath`.
Blend mode, mask and wipe/iris reveals also work across backend boundaries (for example text with `overlay` on top of a `scene3d`); animated GIF/APNG in `image` play as video.
Full fields: `packages/schema/openvideo.schema.json`. Render semantics: [docs/reference/node-semantics.md](../reference/node-semantics.md).
`capabilities.get` with `{ "nodeType": "<type>" }` returns a valid JSON example and the types of all properties (fields `example`, `propertyTypes`); all examples are also in `docs/reference/node-semantics.md` (section 3).

## 6. Change precisely (patches)

```json
{ "projectId": "demo", "patches": [
  { "op": "setProperty", "nodeId": "headline", "property": "fontSize", "value": 82 },
  { "op": "setProperty", "nodeId": "headline", "property": "y", "value": 720 }
] }
```

A list is applied all or nothing. The answer contains `inverse` for undo; `"dryRun": true` only checks.
In TSX projects OpenVideo writes the change back into the source code through the AST (`sourceUpdated: true`).
The field `op` selects the patch kind; every kind has fixed fields (`schema.get` with `{ "name": "patch" }` returns the JSON Schema).
`compositionId` is optional while the node id is unique. `value: null` deletes a property, except with `"keepNull": true`.

`setProperty` – set a property (also paths like `scale.x`, and animations):

```json
{ "projectId": "demo", "patches": [{ "op": "setProperty", "nodeId": "headline", "property": "fontSize", "value": 82 }] }
```

`addNode` – insert a node; `parentId` is a node id or `null` (top level), `index` the position:

```json
{ "projectId": "demo", "patches": [{ "op": "addNode", "parentId": null, "node": { "id": "badge", "type": "rect", "x": 96, "y": 96, "width": 240, "height": 64, "cornerRadius": 12, "fill": "#FF5A1F" } }] }
```

`removeNode` – remove a node with its children:

```json
{ "projectId": "demo", "patches": [{ "op": "removeNode", "nodeId": "f1" }] }
```

`moveNode` – change parent or order (z order; `zIndex` overrides the order among siblings):

```json
{ "projectId": "demo", "patches": [{ "op": "moveNode", "nodeId": "headline", "parentId": null, "index": 1 }] }
```

`addKeyframe` – set a keyframe; a fixed value becomes `$keyframes`:

```json
{ "projectId": "demo", "patches": [{ "op": "addKeyframe", "nodeId": "headline", "property": "opacity", "keyframe": { "t": "1s", "v": 1, "ease": "easeOutCubic" } }] }
```

`removeKeyframe` – remove the keyframe at time `t`:

```json
{ "projectId": "demo", "patches": [
  { "op": "addKeyframe", "nodeId": "headline", "property": "opacity", "keyframe": { "t": "1s", "v": 1 } },
  { "op": "removeKeyframe", "nodeId": "headline", "property": "opacity", "t": "1s" }
] }
```

`addAsset`, `replaceAsset`, `removeAsset` – declare, swap, remove assets (`asset.import` also copies the file):

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

`setCompositionProperty` and `setProjectProperty` – change the composition (background, duration, markers) or the project (metadata, theme, settings):

```json
{ "projectId": "demo", "patches": [{ "op": "setCompositionProperty", "compositionId": "main", "property": "background", "value": "#101218" }] }
```

```json
{ "projectId": "demo", "patches": [{ "op": "setProjectProperty", "property": "metadata.title", "value": "Launch video" }] }
```

### Preview without saving

`frame.render` takes the same patch list as `patches`: they apply only to this render and are never saved (the Studio uses this while you drag). Rejected patches fail with `OV_PREVIEW_PATCH`. Check a candidate change this way, then send it with `composition.patch`:

```json
{ "projectId": "demo", "frame": "2s", "scale": 0.5, "patches": [{ "op": "setProperty", "nodeId": "headline", "property": "fill", "value": "#FF5A1F" }] }
```

## 7. Read diagnostics

Every error has `code`, `problem`, `path` (for example `composition.main.nodes.logo.scale.x`, or `patches[3]` / `patches[3].nodeId` for patches), `expected`, `received` and at least one entry in `suggestions`.
For typos (node id, patch kind, field name, component) the first suggestion names the closest valid name:

```jsonc
// composition.patch with "nodeId": "headlin"
{ "ok": false, "inverse": [], "sourceUpdated": false, "diagnostics": [{
  "code": "OV_PATCH_INVALID", "severity": "error", "errorClass": "PatchError",
  "problem": "Patch 1 (setProperty): Node \"headlin\" does not exist.",
  "path": "patches[0]", "nodeId": "headlin", "expected": "an existing node id", "received": "\"headlin\"",
  "suggestions": ["Did you mean \"headline\"?", "Use scene.tree or composition.get to list node ids."]
}] }
```

Important codes:

| Code | Meaning | Typical fix |
|---|---|---|
| `OV_SCHEMA_*` | Value does not match the schema | Apply the suggestion |
| `OV_COMPONENT_PROPS` | Wrong component props | Allowed props from the message |
| `OV_TEXT_OVERFLOW`, `OV_OVERFLOW` | Text does not fit / leaves the frame | Lower `fontSize`, set `width` |
| `OV_SAFE_AREA` | Outside the safe area | Move inwards |
| `OV_FONT_MISSING`, `OV_ASSET_MISSING` | File missing | `project.fonts` / `asset.import` |
| `OV_*_UNSUPPORTED` | A backend cannot do a feature | Another backend (`renderer`) |
| `OV_PIXI_FALLBACK` (info) | With `renderer2d: "pixi"` Skia renders this node | Nothing to do; see `details.features` |
| `OV_SANDBOX_REQUIRED` | HTML scripts without a container | Container worker, or remove the script |
| `OV_PATCH_INVALID` | A patch does not fit (field, type, unknown node) | Read `path` and `expected`, apply the suggestion |
| `OV_PREVIEW_PATCH` | Preview patches of `frame.render` rejected | Check with `composition.patch` and `"dryRun": true` |
| `OV_IMPORT_LOSSY` | An import dropped something (warning) | Rebuild the effect with IR means |
| `OV_ASR_UNAVAILABLE` | No speech recognition installed | Install whisper.cpp, or write cues yourself |
| `OV_PLUGIN_NOT_ALLOWED` | The project has `settings.plugins`, the host does not allow plugins | `--trusted` or `OPENVIDEO_ALLOW_PLUGINS=1` |
| `OV_THREE_GRAPHICS_MISMATCH` | The GPU allows smaller textures than the cached graphics probe in the key | `openvideo cache clear --tier layer`, or render on the machine of the probe |

## 8. Components and templates

`templates.list` shows 15 templates (Product Launch, SaaS Explainer, Logo Reveal …); `project.create` with `"template": "<name>"` starts from one.
Components (29): Title, Subtitle, LowerThird, Callout, Badge, Card, BrowserWindow, CodeEditor, Terminal, Chart, BarChart, LineChart, PieChart, Table, Logo, DeviceFrame, Phone, Laptop, Cursor, Arrow, Connector, Grid, ParticleField, GradientBackground, Spotlight, GlassPanel, ProgressBar, Counter, Typewriter.

```json
{ "id": "lt", "type": "component", "component": "LowerThird", "props": { "name": "Ada Lovelace", "role": "Engineer" }, "x": 96, "y": 860 }
```

`capabilities.get` with `{ "component": "<name>" }` returns the props schema and an example (also in `docs/ai/capabilities.json`).
A theme (`settings.theme`) recolors all components.

## 9. Audio, voice, subtitles

```jsonc
"audio": [{ "id": "vo", "voice": { "provider": "piper", "text": "Welcome to OpenVideo." } }],
"compositions": [{ "tracks": [
  { "id": "voice", "kind": "audio", "role": "voiceover", "clips": [{ "id": "c1", "source": "vo", "start": "0.5s" }] },
  { "id": "music", "kind": "audio", "role": "music", "clips": [{ "id": "m", "source": "song", "start": 0, "volume": 0.6 }], "ducking": { "by": "voice", "amount": -12 } },
  { "id": "subs", "kind": "subtitle", "cues": [{ "start": "0.5s", "end": "2.5s", "text": "Welcome to OpenVideo." }] }
] }]
```

Voices are generated once and cached. A `subtitles` node with `track: "subs"` shows the subtitles.
`subtitles.transcribe` (`{ "projectId": "demo", "trackId": "subs", "source": "vo-file" }`) creates cues from a recording with an installed ASR provider (whisper.cpp); `tracks[].fromAudio` sets source and provider.

## 10. TSX projects

`openvideo create hello --tsx` writes `src/video.tsx`; `project.create` takes TSX as `source`. JSX is only syntax: the compiler turns the file into the same IR and writes it to `project.json`.

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

- TSX is code. OpenVideo compiles and runs it in a Docker container without network; `--trusted` runs your **own** project on the host.
- Values that change per frame (`frame * 4`) become `$sampled`. The helpers `animate`, `keyframes`, `spring({ from, to, … })`, `expr` and `ref` produce `$keyframes`, `$spring`, `$expr` and `$ref` (smaller IR, editable with `addKeyframe`); `spring({ frame, … })` (Remotion style) returns a number and therefore becomes `$sampled`; `stagger` and `sequence` compute start frames.
- `composition.patch` edits the TSX source through the AST (`sourceUpdated: true`); give every element you want to change an `id` attribute. A patch that cannot be written back is rejected and the source stays unchanged.
- `openvideo dev` recompiles on save; compile errors appear in the terminal and the Studio keeps the last good state.
- More: [`packages/sdk/README.md`](../../packages/sdk/README.md) and [`examples/explainer-tsx`](../../examples/explainer-tsx/README.md).

## 11. Imports

`project.import` takes SVG, Lottie, glTF, HTML (a file in the project via `path`, or the content via `content`) and an Anime.js timeline or Motion Canvas scenes as JSON.
Whatever does not transfer produces a warning `OV_IMPORT_LOSSY` with a path; `"dryRun": true` shows the result without saving.
Anime.js example: `{ "projectId": "demo", "format": "anime", "content": { "entries": [{ "targets": "headline", "params": { "opacity": [0, 1], "y": [40, 0], "duration": 600, "ease": "outCubic" } }] } }`.

## 12. Manifests

- `video.render` writes `<file>.render-manifest.json` next to the video: versions of all components, used backends, graphics mode, GPU, encoder arguments and one hash per frame.
- `frame.render`, `frame.renderMany` and `preview.contactSheet` return a **short manifest** (`kind: "frames"`) as `manifest`: inputs (`compositionHash`, `projectHash`), `frames[]` with cache `key` and pixel `hash`, `renderBackend`, `graphics`, `chromiumVersion`, `gpu`. The CLI writes it with `render-frame --manifest` and `contact-sheet --manifest`.
- The same inputs give the same pixel hash. Compare hashes instead of images to check that a change did (or did not) touch a frame.

Fields: [docs/reference/render-manifest.md](../reference/render-manifest.md).

## 13. Plugins

A project lists plugin modules in `settings.plugins`; they load only when the host allows it (`--trusted` or `OPENVIDEO_ALLOW_PLUGINS=1`, permissions via `OPENVIDEO_PLUGIN_PERMISSIONS`).

- `plugins.list { "projectId": "demo" }` returns `plugins`, `tools` (with input schema), `codecs`, `exporters`, `assetLoaders` and `studioPanels`.
- Agent tools of plugins are operations `plugin.<name>`: `POST /v1/plugin.<name>`, MCP tool `plugin_<name with _>` (listed when the MCP server has an open project), `openvideo op plugin.<name> --project <dir> --trusted --input '<json>'`. The input is `projectId` plus the tool's fields.
- Codecs and exporters appear as `"codec": "plugin:<id>"` and `"format": "plugin:<id>"` in a render profile.

Details: [docs/guide/plugins.md](../guide/plugins.md).

## 14. Live sync with humans

`openvideo dev` (Studio) and agents work on the same project at the same time. `GET /v1/events?projectId=<id>` streams Server-Sent Events `revision` (`{ "projectId", "revision" }`, the first message is the current state); the revision is the SHA-256 of `project.json` and also its `ETag` under `/v1/files/<projectId>/project.json`. After an external change, re-read the project (`composition.get`) before you patch coordinates you computed earlier.

## 15. Renderers and determinism

- 2D renders with Skia by default (bit-identical on every machine). `settings.renderer2d: "pixi"` uses PixiJS (WebGL in Chromium) where it can and falls back to Skia per node (`OV_PIXI_FALLBACK`); an explicit `renderer` on a node wins.
- `scene3d` with `backend: "auto"` (default) prefers WebGPU and falls back to WebGL2; the choice is probed once per Chromium and recorded in the manifest (`graphics.threeBackends`).
- `OPENVIDEO_BROWSER_GPU=1` renders WebGL/WebGPU on the host GPU instead of SwiftShader: faster, not bit-identical, separate cache keys.
- A second render only redraws frames whose inputs changed; an identical video render reuses the whole output file.

## 16. Recipes and examples

See [docs/guide/recipes.md](../guide/recipes.md): fade in a headline, move the camera, a feature list synced to the voiceover, scene changes, data visualization, 3D product, code tutorial, transparent lower third.
Five complete example projects with README and test live in `examples/` (`product-launch`, `explainer-tsx`, `data-story`, `3d-showcase`, `social-vertical`).
