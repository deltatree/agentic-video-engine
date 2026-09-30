# Render-Manifest und Kurzmanifest

[English version](render-manifest.md)

`renderVideo` schreibt neben jede Ausgabe `<datei>.render-manifest.json` (Schema `RenderManifestSchema` in
`@agentic-video/render`, Prüfung mit `validateManifest`). Frame-Operationen liefern ein Kurzmanifest
(`FrameManifestSchema`, `validateFrameManifest`).

## Felder, die die Umgebung beschreiben (Story 21.5)

| Feld | Inhalt |
|---|---|
| `renderBackend` | Tatsächlich genutzte Backends aus den Frame-Plänen (z. B. `["skia"]`), nicht alle registrierten. |
| `chromiumVersion` | Version aus `browser.version()` des Prozesses, der Browser-Layer gerendert hat (auch aus Workern); sonst `{ version: null, reason }`. |
| `gpu` | GPU des Hosts aus `probeHostGpu` (`nvidia-smi`: Name und Speicher; sonst `/dev/dri`), sonst Begründung. |
| `graphics.browserGpu` | `swiftshader` (Standard) oder `native` (`OPENVIDEO_BROWSER_GPU=1`, ADR 0019). |
| `graphics.webgl2`, `graphics.webgpu` | WebGL2-Renderer und WebGPU-Adapter der Render-Seite, wenn Chromium mit Grafik lief; sonst Begründung. |
| `graphics.threeBackends` | Gewählte Three.js-Backends der gerenderten `scene3d`-Nodes (`webgpu`/`webgl2`; `auto` nur ohne Probe). |
| `voiceHashes` | Stimmen der Tonspur: ID → Cache-Schlüssel (Provider, Version, Text, Einstellungen). |
| `encoder` | Encoder und Argumente. Ohne `hardwareAcceleration` im Profil immer CPU (`libx264` …). |
| `cache.output` | Cache-Ebene `encoding`: `hit` (Bytes eines früheren identischen Renders), `miss` oder `off` (ADR 0021). |

## Kurzmanifest (`kind: "frames"`)

`frame.render`, `frame.renderMany` und `preview.contactSheet` liefern es als `manifest`; in der CLI schreiben
`openvideo render-frame --manifest` und `openvideo contact-sheet --manifest` es als `<bild>.manifest.json`.

| Feld | Inhalt |
|---|---|
| `compositionId`, `compositionHash`, `projectHash` | Eingaben. |
| `scale`, `resolution`, `seed` | Ausgabe. |
| `frames[]` | `frame`, Frame-Schlüssel `key`, Pixel-Hash `hash` (wie `frameHashes` im Render-Manifest), `cached`. |
| `renderBackend`, `graphics`, `chromiumVersion`, `gpu`, `os`, `containerImage` | wie oben. |
| `dependencyVersions`, `trusted`, `timestamp` | Versionen aller Komponenten, Vertrauensmodus, Zeitpunkt. |
