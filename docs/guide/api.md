# Agent API

Generiert von `scripts/generate-docs.mjs`. Jede der 31 Operationen ist über HTTP (`POST /v1/<name>`), MCP (Tool `<name>` mit `_` statt `.`) und die CLI (`openvideo op <name> --input <json|@datei>`) erreichbar (ADR 0009).
Der MCP-Server bietet zusätzlich die Resources `openvideo://agents.md`, `openvideo://schema.json` und `openvideo://capabilities.json`.

| Operation | Zweck | Job |
|---|---|---|
| `capabilities.get` | What this host can do: node types (property types + example), components (props + example), operations, patch ops, backends, easings, formats. Filter with nodeType or component. |  |
| `schema.get` | JSON Schema of the Composition IR, of one node type, of the patch format, or of an operation input/output. |  |
| `project.create` | Create a project from a template, a JSON project, TSX source, or an empty composition. |  |
| `project.open` | Open an existing project folder (openvideo.json or project.json) inside the allowed project roots and return its projectId. |  |
| `project.import` | Import SVG, Lottie, glTF, HTML, an anime.js timeline or Motion Canvas scenes into a project; lossy conversions are reported as OV_IMPORT_LOSSY warnings. |  |
| `project.inspect` | List projects, or summarize one project (compositions, assets, fonts, profiles). |  |
| `project.update` | Replace the whole IR of a JSON project after validation (used by code editors). |  |
| `composition.create` | Add a composition to a project. |  |
| `composition.get` | Return the IR of a composition. |  |
| `composition.validate` | Validate schema, references, fonts, assets and backend capabilities before rendering. |  |
| `composition.patch` | Apply semantic patches atomically; TSX projects are updated through AST edits. |  |
| `asset.import` | Import a file, URL or base64 data into the project (content-addressed, normalized). |  |
| `asset.inspect` | Return metadata of an asset (dimensions, duration, codec, color space, license). |  |
| `frame.render` | Render one frame to PNG; returns the image, diagnostics and the frame cache key. |  |
| `frame.renderMany` | Render several frames to separate PNGs in one call (e.g. before/after a change); returns one image per frame. |  |
| `frame.inspect` | Scene tree with bounds, text layout and diagnostics for one frame (no pixels). |  |
| `preview.render` | Render a low-resolution preview video (job). | ja |
| `preview.contactSheet` | Render several frames into one labeled contact sheet image. |  |
| `video.render` | Render the final video with a render profile (job); writes a render manifest. | ja |
| `render.status` | Status, progress and result of a render job; without jobId, all jobs (optionally of one project), newest first. |  |
| `render.cancel` | Cancel a queued or running render job. |  |
| `diagnostics.get` | All diagnostics: validation, backend checks, and (with frame) scene diagnostics. |  |
| `subtitles.transcribe` | Transcribe an audio/video asset with an ASR provider (e.g. whisper.cpp) into a subtitle track with word timings. |  |
| `fonts.list` | List the fonts available to a project (bundled defaults plus project fonts). |  |
| `templates.list` | List available templates. |  |
| `templates.inspect` | Return the source files and IR of a template. |  |
| `scene.describe` | Describe a frame in plain sentences (nodes, positions, text). |  |
| `scene.tree` | Scene tree of a frame with bounds and opacity. |  |
| `timeline.inspect` | Timing windows, animated properties, keyframe times, markers and tracks. |  |
| `benchmark.run` | Run a reproducible benchmark scenario and return the measurements. |  |
| `plugins.list` | List the plugins of a project and what they add: agent tools (operations plugin.<name>), codecs, exporters (output formats plugin:<id>), asset loaders and Studio panels. |  |

## Beispiele

### capabilities.get

What this host can do: node types (property types + example), components (props + example), operations, patch ops, backends, easings, formats. Filter with nodeType or component.

```json
{
  "nodeType": "text"
}
```

### schema.get

JSON Schema of the Composition IR, of one node type, of the patch format, or of an operation input/output.

```json
{
  "nodeType": "rect"
}
```

### project.create

Create a project from a template, a JSON project, TSX source, or an empty composition.

```json
{
  "name": "Launch video",
  "template": "product-launch"
}
```

### project.open

Open an existing project folder (openvideo.json or project.json) inside the allowed project roots and return its projectId.

```json
{
  "path": "launch-video"
}
```

### project.import

Import SVG, Lottie, glTF, HTML, an anime.js timeline or Motion Canvas scenes into a project; lossy conversions are reported as OV_IMPORT_LOSSY warnings.

```json
{
  "projectId": "launch-video",
  "path": "assets/logo.svg",
  "idPrefix": "logo"
}
```

### project.inspect

List projects, or summarize one project (compositions, assets, fonts, profiles).

```json
{
  "projectId": "launch-video"
}
```

### project.update

Replace the whole IR of a JSON project after validation (used by code editors).

```json
{
  "projectId": "launch-video",
  "project": {
    "schemaVersion": "1.0.0",
    "compositions": []
  }
}
```

### composition.create

Add a composition to a project.

```json
{
  "projectId": "launch-video",
  "composition": {
    "id": "outro",
    "width": 1920,
    "height": 1080,
    "fps": 30,
    "duration": "4s",
    "nodes": []
  }
}
```

### composition.get

Return the IR of a composition.

```json
{
  "projectId": "launch-video",
  "compositionId": "main"
}
```

### composition.validate

Validate schema, references, fonts, assets and backend capabilities before rendering.

```json
{
  "projectId": "launch-video"
}
```

### composition.patch

Apply semantic patches atomically; TSX projects are updated through AST edits.

```json
{
  "projectId": "launch-video",
  "patches": [
    {
      "op": "setProperty",
      "nodeId": "headline",
      "property": "fontSize",
      "value": 82
    },
    {
      "op": "setProperty",
      "nodeId": "headline",
      "property": "y",
      "value": 720
    }
  ]
}
```

### asset.import

Import a file, URL or base64 data into the project (content-addressed, normalized).

```json
{
  "projectId": "launch-video",
  "path": "assets/logo.svg",
  "id": "logo"
}
```

### asset.inspect

Return metadata of an asset (dimensions, duration, codec, color space, license).

```json
{
  "projectId": "launch-video",
  "assetId": "logo"
}
```

### frame.render

Render one frame to PNG; returns the image, diagnostics and the frame cache key.

```json
{
  "projectId": "launch-video",
  "frame": "2s",
  "scale": 0.5,
  "debug": {
    "showBounds": true
  }
}
```

### frame.renderMany

Render several frames to separate PNGs in one call (e.g. before/after a change); returns one image per frame.

```json
{
  "projectId": "launch-video",
  "frames": [
    0,
    "2s",
    "marker:outro"
  ],
  "scale": 0.5
}
```

### frame.inspect

Scene tree with bounds, text layout and diagnostics for one frame (no pixels).

```json
{
  "projectId": "launch-video",
  "frame": 90
}
```

### preview.render

Render a low-resolution preview video (job).

```json
{
  "projectId": "launch-video",
  "scale": 0.25
}
```

### preview.contactSheet

Render several frames into one labeled contact sheet image.

```json
{
  "projectId": "launch-video",
  "frames": [
    0,
    90,
    180,
    360
  ]
}
```

### video.render

Render the final video with a render profile (job); writes a render manifest.

```json
{
  "projectId": "launch-video",
  "profile": {
    "format": "mp4",
    "codec": "h264",
    "width": 3840
  }
}
```

### render.status

Status, progress and result of a render job; without jobId, all jobs (optionally of one project), newest first.

```json
{
  "jobId": "job-…"
}
```

### render.cancel

Cancel a queued or running render job.

```json
{
  "jobId": "job-…"
}
```

### diagnostics.get

All diagnostics: validation, backend checks, and (with frame) scene diagnostics.

```json
{
  "projectId": "launch-video",
  "frame": 120
}
```

### subtitles.transcribe

Transcribe an audio/video asset with an ASR provider (e.g. whisper.cpp) into a subtitle track with word timings.

```json
{
  "projectId": "launch-video",
  "trackId": "subs",
  "source": "voiceover",
  "provider": "whisper-cpp",
  "language": "en"
}
```

### fonts.list

List the fonts available to a project (bundled defaults plus project fonts).

```json
{
  "projectId": "launch-video"
}
```

### templates.list

List available templates.

```json
{}
```

### templates.inspect

Return the source files and IR of a template.

```json
{
  "name": "product-launch"
}
```

### scene.describe

Describe a frame in plain sentences (nodes, positions, text).

```json
{
  "projectId": "launch-video",
  "frame": "4s"
}
```

### scene.tree

Scene tree of a frame with bounds and opacity.

```json
{
  "projectId": "launch-video",
  "frame": 0
}
```

### timeline.inspect

Timing windows, animated properties, keyframe times, markers and tracks.

```json
{
  "projectId": "launch-video"
}
```

### benchmark.run

Run a reproducible benchmark scenario and return the measurements.

```json
{
  "scenario": "text-heavy",
  "resolution": "1080p30",
  "frames": 60
}
```

### plugins.list

List the plugins of a project and what they add: agent tools (operations plugin.<name>), codecs, exporters (output formats plugin:<id>), asset loaders and Studio panels.

```json
{
  "projectId": "launch-video"
}
```

## Patch-Arten

`composition.patch` nimmt eine Liste typisierter Patches; das Feld `op` wählt die Art (JSON Schema: `schema.get` mit `{ "name": "patch" }`). Jedes Beispiel läuft gegen ein Projekt mit der Composition `main` und den Text-Nodes `headline` und `f1`; vorbereitende Patches stehen davor.

### setProperty

```json
{
  "projectId": "demo",
  "patches": [
    {
      "op": "setProperty",
      "nodeId": "headline",
      "property": "fontSize",
      "value": 82
    }
  ]
}
```

### addNode

```json
{
  "projectId": "demo",
  "patches": [
    {
      "op": "addNode",
      "parentId": null,
      "node": {
        "id": "badge",
        "type": "rect",
        "x": 96,
        "y": 96,
        "width": 240,
        "height": 64,
        "cornerRadius": 12,
        "fill": "#FF5A1F"
      }
    }
  ]
}
```

### removeNode

```json
{
  "projectId": "demo",
  "patches": [
    {
      "op": "removeNode",
      "nodeId": "f1"
    }
  ]
}
```

### moveNode

```json
{
  "projectId": "demo",
  "patches": [
    {
      "op": "moveNode",
      "nodeId": "headline",
      "parentId": null,
      "index": 1
    }
  ]
}
```

### addKeyframe

```json
{
  "projectId": "demo",
  "patches": [
    {
      "op": "addKeyframe",
      "nodeId": "headline",
      "property": "opacity",
      "keyframe": {
        "t": "1s",
        "v": 1,
        "ease": "easeOutCubic"
      }
    }
  ]
}
```

### removeKeyframe

```json
{
  "projectId": "demo",
  "patches": [
    {
      "op": "addKeyframe",
      "nodeId": "headline",
      "property": "opacity",
      "keyframe": {
        "t": "1s",
        "v": 1
      }
    },
    {
      "op": "removeKeyframe",
      "nodeId": "headline",
      "property": "opacity",
      "t": "1s"
    }
  ]
}
```

### replaceAsset

```json
{
  "projectId": "demo",
  "patches": [
    {
      "op": "addAsset",
      "asset": {
        "id": "music",
        "type": "audio",
        "src": "assets/music.wav"
      }
    },
    {
      "op": "replaceAsset",
      "assetId": "music",
      "src": "assets/music-v2.wav"
    }
  ]
}
```

### addAsset

```json
{
  "projectId": "demo",
  "patches": [
    {
      "op": "addAsset",
      "asset": {
        "id": "music",
        "type": "audio",
        "src": "assets/music.wav"
      }
    }
  ]
}
```

### removeAsset

```json
{
  "projectId": "demo",
  "patches": [
    {
      "op": "addAsset",
      "asset": {
        "id": "music",
        "type": "audio",
        "src": "assets/music.wav"
      }
    },
    {
      "op": "removeAsset",
      "assetId": "music"
    }
  ]
}
```

### setCompositionProperty

```json
{
  "projectId": "demo",
  "patches": [
    {
      "op": "setCompositionProperty",
      "compositionId": "main",
      "property": "background",
      "value": "#101218"
    }
  ]
}
```

### setProjectProperty

```json
{
  "projectId": "demo",
  "patches": [
    {
      "op": "setProjectProperty",
      "property": "metadata.title",
      "value": "Launch video"
    }
  ]
}
```

## Fehler

Fehler kommen als `{ "error": Diagnostic }` mit HTTP 400 (Eingabe), 401 (Token), 403 (Sicherheit), 404 (unbekannt) oder 500 (Fehler in OpenVideo).
Jede Diagnose hat `code`, `problem`, `path` (bei Patches mit Index, z. B. `patches[3].nodeId`), `expected`, `received` und mindestens einen Vorschlag in `suggestions`.
