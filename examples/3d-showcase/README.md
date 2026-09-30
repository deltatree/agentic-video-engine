# Example: 3D showcase

A 6-second product shot rendered in real time with Three.js: a glTF gem turns on a pedestal while the
camera orbits, lit by three lights with shadows, surrounded by particles and bloom. A 2D title sits
on top of the 3D layer.

| Feature | Where in `project.json` |
|---|---|
| 3D scene | `stage` (`scene3d`: `environment` preset, `shadows`, `toneMapping`, `postprocessing.bloom`, `backend: "auto"`) |
| glTF model with its own animation clip | `gem-model` (`model3d`, `asset: "gem"`, `animation.clip: "bob"`, rotation keyframes) |
| Camera move | `cam` (`camera3d`, `position` keyframes, `target`) |
| Lights | `fill` (ambient), `key` (directional with shadow), `rim` (point, colored) |
| Built-in geometry | `pedestal` (cylinder), `floor` (plane) |
| Particles | `sparkles` (`particles3d`, seeded, additive) |
| 2D over 3D | `title`, `tagline` (`text` with per-character animation) |

Coordinates in 3D are meters with y up; rotations are degrees. `backend: "auto"` is the recommended
setting (and the default when the field is missing): OpenVideo renders with WebGPU when a small test
render in Chromium succeeds and falls back to WebGL2 otherwise. The probe runs once per Chromium
version and graphics mode and is cached; the chosen backend is part of the frame cache key and appears
in the render manifest as `graphics.threeBackends`. Pin `backend: "webgl2"` or `"webgpu"` only when you
need exactly that path, for example to compare results across machines.

## Run it

```bash
cd examples/3d-showcase
node generate-assets.mjs                # writes assets/gem.glb
npx openvideo validate                  # schema, assets, fonts, backends
npx openvideo render-frame --frame 3s   # out/frame-90.png (needs Chromium: npx playwright install chromium)
npx openvideo render --profile web      # out/main.mp4 + render manifest
```

Inside this repository use `node ../../packages/cli/dist/bin.js` instead of `npx openvideo` (after `npm run build`).
The same scene renders offline with Blender when you change `"type": "scene3d"` to `"type": "blender"`
(and drop the Three.js-only fields `backend` and `postprocessing`).

## Assets and license

`generate-assets.mjs` builds `assets/gem.glb` with plain Node.js: a faceted gem (16 triangles, flat
normals, PBR material) with a two-second animation clip `bob`. It is original, generated content
under [CC0-1.0](https://creativecommons.org/publicdomain/zero/1.0/); the generated file is not
checked in (`.gitignore`).

## Test

`3d-showcase.test.ts` generates the model, runs `openvideo validate` and renders one frame. The frame
needs Chromium; without it the test is skipped with a named reason (`skipUnless` from
`@agentic-video/testing`; CI with `OPENVIDEO_REQUIRE_ALL=1` fails instead): `npx vitest run examples/3d-showcase`.
