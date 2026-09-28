# Agent API

Generiert von `scripts/generate-docs.mjs`. Jede Operation ist über HTTP (`POST /v1/<name>`), MCP (Tool `<name>` mit `_` statt `.`) und teilweise die CLI erreichbar.

| Operation | Zweck | Job |
|---|---|---|
| `project.create` | Create a project from a template, a JSON project, TSX source, or an empty composition. |  |
| `project.inspect` | List projects, or summarize one project (compositions, assets, fonts, profiles). |  |
| `project.update` | Replace the whole IR of a JSON project after validation (used by code editors). |  |
| `composition.create` | Add a composition to a project. |  |
| `composition.get` | Return the IR of a composition. |  |
| `composition.validate` | Validate schema, references, fonts, assets and backend capabilities before rendering. |  |
| `composition.patch` | Apply semantic patches atomically; TSX projects are updated through AST edits. |  |
| `asset.import` | Import a file, URL or base64 data into the project (content-addressed, normalized). |  |
| `asset.inspect` | Return metadata of an asset (dimensions, duration, codec, color space, license). |  |
| `frame.render` | Render one frame to PNG; returns the image, diagnostics and the frame cache key. |  |
| `frame.inspect` | Scene tree with bounds, text layout and diagnostics for one frame (no pixels). |  |
| `preview.render` | Render a low-resolution preview video (job). | ja |
| `preview.contactSheet` | Render several frames into one labeled contact sheet image. |  |
| `video.render` | Render the final video with a render profile (job); writes a render manifest. | ja |
| `render.status` | Status, progress and result of a render job. |  |
| `render.cancel` | Cancel a queued or running render job. |  |
| `diagnostics.get` | All diagnostics: validation, backend checks, and (with frame) scene diagnostics. |  |
| `fonts.list` | List the fonts available to a project (bundled defaults plus project fonts). |  |
| `templates.list` | List available templates. |  |
| `templates.inspect` | Return the source files and IR of a template. |  |
| `scene.describe` | Describe a frame in plain sentences (nodes, positions, text). |  |
| `scene.tree` | Scene tree of a frame with bounds and opacity. |  |
| `timeline.inspect` | Timing windows, animated properties, keyframe times, markers and tracks. |  |
| `benchmark.run` | Run a reproducible benchmark scenario and return the measurements. |  |

## Beispiele

### project.create

Create a project from a template, a JSON project, TSX source, or an empty composition.

```json
{
  "name": "Launch video",
  "template": "product-launch"
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

Status, progress and result of a render job.

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

## Fehler

Fehler kommen als `{ "error": Diagnostic }` mit HTTP 400 (Eingabe), 401 (Token), 403 (Sicherheit), 404 (unbekannt) oder 500 (Fehler in OpenVideo).
