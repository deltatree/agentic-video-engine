# OpenVideo – Agentic Video Engine

[![CI](https://github.com/deltatree/agentic-video-engine/actions/workflows/ci.yml/badge.svg)](https://github.com/deltatree/agentic-video-engine/actions/workflows/ci.yml)
[![License: Apache-2.0](https://img.shields.io/badge/License-Apache--2.0-blue.svg)](LICENSE)

[Deutsche Fassung](README.de.md)

OpenVideo is an open-source platform for **video as code**, built for coding agents.
An agent describes a video as JSON or TSX. OpenVideo renders frames, shows the result and accepts precise changes.

```text
frame = render(composition, assets, frame, seed)
```

Every frame is a pure function of its inputs.
Frame 471 is bit-identical whether or not frame 470 was rendered before.

## What OpenVideo does

| Area | Scope |
|---|---|
| Description | Composition IR (JSON Schema), TSX SDK, 31 node types, 29 components, 15 templates |
| Animation | Keyframes, springs, expressions, per-frame samples, motion paths, text animation, transitions, `sequence` with automatic cross-fades, named events |
| 2D | Skia/CanvasKit (default, bit-identical), PixiJS (WebGL in Chromium) with per-node fallback to Skia, SVG, Lottie, data visualization |
| 3D | Three.js (WebGPU with WebGL2 fallback), glTF, lights, camera, particles; Blender Cycles and Eevee |
| Web | HTML/CSS layers in Chromium with virtual time and network lock; browser GPU mode as opt-in |
| Image | Own compositor: 17 blend modes, masks, effects, color grading, color spaces, `zIndex`, all across backend boundaries |
| Audio | Mix and mastering, voiceover (Piper, espeak-ng), subtitles with word timing (whisper.cpp), ASS styles, karaoke |
| Output | MP4, WebM, MOV/ProRes, GIF, image sequences, alpha; render manifest with frame hashes; short manifest for single frames |
| Agents | HTTP API, MCP server, CLI – the same 31 operations, typed patches, preview patches without saving, self-description, structured errors with suggestions, live events |
| Plugins | Agent tools, codecs, exporters, asset loaders, Studio panels, node types, components, effects, backends – with permissions |
| Scale | Parallel rendering by default, frame/layer/compiled/encoding caches keyed by content hash, process, Docker and Kubernetes workers, S3 cache |
| Studio | Visual editing in the browser with live sync; every change is a semantic patch |

## Quick start

OpenVideo is not published on npm; you build it from this repository in a few minutes.
By default it runs in a container – Docker, Podman or Kubernetes, whichever is available or whichever you name – with an image built locally by that technology.

**The easy way – let your coding assistant do it.** Tell Claude Code, Cursor, Codex or any other assistant:

```text
Read https://raw.githubusercontent.com/deltatree/agentic-video-engine/main/SETUP.md and follow it to set up OpenVideo for me.
```

[SETUP.md](SETUP.md) walks the assistant through choosing the runtime, build, verification and MCP registration.

**By hand** (requirements: git, Node.js 22.13 or newer, and Docker, Podman or a Kubernetes cluster; without them OpenVideo installs natively and also needs FFmpeg):

```bash
git clone https://github.com/deltatree/agentic-video-engine.git ~/openvideo
cd ~/openvideo
npm run setup          # detects docker/podman/kubernetes (or --runtime <name>), builds the image, installs the `openvideo` wrapper
mkdir -p ~/openvideo-scratch && cd ~/openvideo-scratch && openvideo create hello && cd hello
openvideo render-frame --frame 2s --out out/frame.png
openvideo render --format mp4
```

`openvideo doctor` checks the environment and names a fix for every gap.
More in [Getting started](docs/guide/getting-started.md).

## For coding agents

1. Start the Agent API with `openvideo serve` or the MCP server with `openvideo mcp --project ./hello`. Without a server, `openvideo op <name> --input '<json>'` runs any operation.
2. Read [docs/ai/AGENTS.md](docs/ai/AGENTS.md) and [llms.txt](llms.txt) (over MCP also as the resource `openvideo://agents.md`).
3. The capabilities are machine-readable in [docs/ai/capabilities.json](docs/ai/capabilities.json) and live through `capabilities.get` and `schema.get`.
4. Learn from [examples](examples/README.md): five complete projects (JSON and TSX, 2D, 3D, 9:16, charts, subtitles) and one valid JSON example per node type (`capabilities.get` with `{ "nodeType": "text" }`). [examples/mcp.json](examples/mcp.json) configures MCP clients.

An agent changes a video with patches, not with text replacement:

```json
{ "patches": [{ "op": "setProperty", "nodeId": "headline", "property": "fill", "value": "#FF5A1F" }] }
```

After every patch OpenVideo re-renders only the frames that really change.

Coding agents that work **on this repository** start with [AGENTS.md](AGENTS.md).

## Documentation

| Document | Content |
|---|---|
| [Getting started](docs/guide/getting-started.md) | Installation, first project, Studio, rendering |
| [Recipes](docs/guide/recipes.md) | Ready IR snippets for common tasks |
| [Agent API](docs/guide/api.md) | All operations, HTTP endpoints, input examples, patch kinds (generated) |
| [Command line](docs/guide/cli.md) | All `openvideo` commands (generated) |
| [Plugins](docs/guide/plugins.md) | Agent tools, codecs, exporters, asset loaders and Studio panels from plugins; permissions |
| [Maintainers](docs/guide/maintainers.md) | Branch protection for `main` as a ruleset (gh api), required checks, repository settings |
| [API reference](https://deltatree.github.io/agentic-video-engine/) | All exported functions and types per package (TypeDoc, published by `.github/workflows/docs.yml`; `npm run docs` writes a Markdown copy to `docs/api/`) |
| [Examples](examples/README.md) | Five example projects with README, assets and test |
| [Render semantics](docs/reference/node-semantics.md) | Binding meaning and one JSON example of every node type |
| [Render manifest](docs/reference/render-manifest.md) | Fields of the render manifest and of the short manifest for frames |
| [Architecture decisions](docs/adr/README.md) | ADR 0001–0029 (German) |
| [Operations with Docker and Kubernetes](deploy/README.md) | Images, scaling, high availability, updates |

## Packages

| Package | Purpose |
|---|---|
| `@agentic-video/schema` | Composition IR, JSON Schema, validation, migration |
| `@agentic-video/timeline` | Time units, easing, keyframes, springs, expressions |
| `@agentic-video/core` | Frame evaluation, frame plan, patches, registry, plugins |
| `@agentic-video/sdk` | TSX SDK: `composition()`, JSX, animation helpers |
| `@agentic-video/compiler` | TSX → IR, sandboxed execution, write-back into the source |
| `@agentic-video/components` | Component library and themes |
| `@agentic-video/templates` | 15 templates as readable TSX source |
| `@agentic-video/render` | Render pipeline, frame cache, audio, encoding, manifest |
| `@agentic-video/renderer-skia` | 2D and text with Skia/CanvasKit |
| `@agentic-video/renderer-browser` | Chromium host for HTML/CSS, PixiJS and Three.js |
| `@agentic-video/renderer-three`, `renderer-pixi` | Scene building for Three.js and PixiJS |
| `@agentic-video/renderer-blender` | Blender Cycles and Eevee, headless |
| `@agentic-video/compositor` | Blend modes, masks, effects, color spaces |
| `@agentic-video/audio`, `ffmpeg` | Audio mix, encoding and decoding |
| `@agentic-video/speech`, `subtitles` | Voiceover, speech recognition, subtitles |
| `@agentic-video/assets`, `fonts`, `importers` | Assets, fonts, imports from SVG, Lottie, glTF, HTML, Anime.js, Motion Canvas |
| `@agentic-video/anime`, `motion-canvas-adapter` | APIs in the style of Anime.js and Motion Canvas |
| `@agentic-video/cache`, `scheduler`, `worker` | Cache, distributed rendering, workers |
| `@agentic-video/agent`, `mcp`, `cli` | Agent API, MCP server, command line |
| `@agentic-video/telemetry`, `benchmarks`, `testing` | Metrics, benchmarks, test tools |
| `@agentic-video/sandbox` | Container sandbox for untrusted code |
| `@agentic-video/png` | PNG encoding and decoding |
| `apps/studio` | OpenVideo Studio |

## CLI exit codes

| Code | Meaning |
|---|---|
| 0 | Success |
| 1 | The project or the render has errors; the diagnostics are in the output |
| 2 | Wrong usage, for example an unknown command or a missing option |

## Security

By default OpenVideo runs agent code in a Docker container without network.
Details and how to report a vulnerability: [SECURITY.md](SECURITY.md).

## Development

```bash
npm ci
npm run check   # dependency rules, build, lint, docs drift, licenses, tests
```

How to contribute: [CONTRIBUTING.md](CONTRIBUTING.md).

## License

Apache-2.0. See [LICENSE](LICENSE).
Licenses of the dependencies and of the contents of every container image (FFmpeg, Chromium, Blender in the image `openvideo-blender`): [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md), `licenses.json`, SBOM in `sbom.cdx.json`. `node scripts/licenses.mjs --check` fails when they no longer match `package-lock.json` and `deploy/docker/Dockerfile`.
