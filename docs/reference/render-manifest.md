# Render manifest and short manifest

[Deutsche Fassung](render-manifest.de.md)

`renderVideo` writes `<file>.render-manifest.json` next to every output (schema `RenderManifestSchema` in
`@agentic-video/render`, checked with `validateManifest`). Frame operations return a short manifest
(`FrameManifestSchema`, `validateFrameManifest`).

## Fields that describe the environment (story 21.5)

| Field | Content |
|---|---|
| `renderBackend` | Backends actually used by the frame plans (for example `["skia"]`), not all registered ones. |
| `chromiumVersion` | Version from `browser.version()` of the process that rendered browser layers (also from workers); otherwise `{ version: null, reason }`. |
| `gpu` | GPU of the host from `probeHostGpu` (`nvidia-smi`: name and memory; otherwise `/dev/dri`), otherwise a reason. |
| `graphics.browserGpu` | `swiftshader` (default) or `native` (`OPENVIDEO_BROWSER_GPU=1`, ADR 0019). |
| `graphics.webgl2`, `graphics.webgpu` | WebGL2 renderer and WebGPU adapter of the render page when Chromium ran with graphics; otherwise a reason. |
| `graphics.threeBackends` | Chosen Three.js backends of the rendered `scene3d` nodes (`webgpu`/`webgl2`; `auto` only without a probe). |
| `voiceHashes` | Voices of the soundtrack: id → cache key (provider, version, text, settings). |
| `encoder` | Encoder and arguments. Without `hardwareAcceleration` in the profile always CPU (`libx264` …). |
| `cache.output` | Cache tier `encoding`: `hit` (bytes of an earlier identical render), `miss` or `off` (ADR 0021). The key (`output-2`) covers the frame keys of all output frames, the soundtrack hash, the encoder settings including threads, the available hardware encoders when `hardware` ≠ `none`, and the runner fingerprint (`describeChunkRunner`). `off` with `reuseOutput: false` or `OPENVIDEO_OUTPUT_CACHE=0`, for image sequences, remote workers (`OPENVIDEO_COORDINATOR_URL`), runners without a description, and `hardware` ≠ `none` without information about hardware encoders. |
| `stages` | Seconds per stage that ran (for example `audioPipeline`, `outputKey`, `outputCache`, `renderFrames`, `ffmpeg`). `outputKey` evaluates the frame keys of all output frames for the output cache key (scene evaluation without rendering); it is missing when the output cache is off. |

## Short manifest (`kind: "frames"`)

`frame.render`, `frame.renderMany` and `preview.contactSheet` return it as `manifest`; in the CLI
`openvideo render-frame --manifest` and `openvideo contact-sheet --manifest` write it as `<image>.manifest.json`.

| Field | Content |
|---|---|
| `compositionId`, `compositionHash`, `projectHash` | Inputs. |
| `scale`, `resolution`, `seed` | Output. |
| `frames[]` | `frame`, frame cache key `key`, pixel hash `hash` (like `frameHashes` in the render manifest), `cached`. |
| `renderBackend`, `graphics`, `chromiumVersion`, `gpu`, `os`, `containerImage` | As above. |
| `dependencyVersions`, `trusted`, `timestamp` | Versions of all components, trust mode, time. |
