# Getting started

[Deutsche Fassung](getting-started.de.md)

## Requirements

| Tool | Purpose | Required |
|---|---|---|
| Node.js 22.13 or newer | Runtime | yes |
| FFmpeg 6 or newer (CI and images use 7.1) | Video encoding, media | yes, for videos |
| Chromium (via Playwright) | HTML/CSS, PixiJS, Three.js | only for these node types |
| Docker | Sandbox for TSX and HTML scripts, Docker workers | only for agent code |
| Blender 4.2 LTS | `blender` nodes | no |
| Piper or espeak-ng, whisper.cpp | Voiceover, transcription | no |

## Installation

OpenVideo is not published on npm; everyone builds it from the repository. The simplest way is to let
your coding assistant do it: tell it to read [SETUP.md](../../SETUP.md) and follow it. By hand:

```bash
git clone https://github.com/deltatree/agentic-video-engine.git ~/openvideo
cd ~/openvideo
npm run setup
```

`npm run setup` checks Node.js and FFmpeg, runs `npm ci` and `npm run build`, downloads Chromium, links the
command `openvideo` globally (`npm install -g ./packages/cli`, a link to the checkout) and runs `openvideo doctor`.
Options such as `--with-deps` (Linux system libraries for Chromium) and `--no-link` are described in SETUP.md.
Without the global link use `alias openvideo="node ~/openvideo/packages/cli/dist/bin.js"`.
Update later with `git pull && npm run setup -- --skip-browser`.

Check everything with `openvideo doctor`. Every line names a fix when needed.

## Create a project and look at it

1. Create a project: `openvideo create hello` (`--tsx` for TypeScript/JSX, `--template <name>` for one of the 15 templates; `openvideo templates` lists them).
2. Change into the folder: `cd hello`.
3. Start the Studio: `openvideo dev`. The browser opens with the project; the address (with the token in the `#token=` fragment) is also printed.

The Studio shows the composition. Changes in the Studio land as patches in `project.json`.

`openvideo dev` watches `src/**` and `project.json`:

- When you save in your editor, `dev` recompiles TSX projects and writes the IR to `project.json`. Compile errors appear in the terminal; the Studio keeps the last good state.
- When an agent (MCP, Agent API, `openvideo patch`) or your editor changes the project, the Studio reloads at once (Server-Sent Events `GET /v1/events`, see [ADR 0025](../adr/0025-live-sync-ueber-inhaltsrevisionen.md)). Undo steps from before the external change expire. If the code panel has unsaved changes, the Studio warns instead of overwriting them.
- `--no-open` does not open a browser (in CI and without a graphical session `dev` never opens one). `openvideo serve --open` also opens the Studio for the Agent API server.

In the Studio, `?` shows all keyboard shortcuts (among them J/K/L, I/O, M for markers, Ctrl+←/→ for keyframes).

## Render

1. Look at a frame: `openvideo render-frame --frame 2s --out out/frame.png`.
2. Render the video: `openvideo render --format mp4 --codec h264`.
3. Next to the video lies `<file>.render-manifest.json` with all versions and frame hashes.

`render` uses several worker processes by default (cores − 1, at most one per 1.5 GB of the memory budget – half the RAM, at most the free memory – and at most 16); `--workers 1` renders in the process.
A second run re-renders only changed frames; the rest comes from the cache in `.openvideo/cache`. An identical render reuses the whole output file.

## TSX instead of JSON

1. Create a TSX project: `openvideo create hello --tsx`.
2. The source lives in `src/video.tsx`. JSX is only syntax; the result is the same IR.
3. TSX is code. OpenVideo runs it in a Docker container without network.
4. For your own project you can run it on the host with `--trusted`.

## For agents

- Agent API: `openvideo serve --port 7788` (HTTP, `GET /v1/operations`).
- MCP: `openvideo mcp` (stdio). Example for Claude Code: `claude mcp add openvideo -- openvideo mcp --workspace ~/ov`, for an existing project `openvideo mcp --project ./hello`. [examples/mcp.json](../../examples/mcp.json) is a client configuration.
- Every operation also without a server: `openvideo op <name> --input '<json>'` (list: `openvideo op --list`).
- Then read [docs/ai/AGENTS.md](../ai/AGENTS.md).

## Useful environment variables

| Variable | Effect |
|---|---|
| `OPENVIDEO_FFMPEG`, `OPENVIDEO_FFPROBE` | Paths to FFmpeg and FFprobe |
| `OPENVIDEO_CHROMIUM`, `OPENVIDEO_BLENDER` | Paths to Chromium and Blender |
| `OPENVIDEO_PIPER`, `OPENVIDEO_PIPER_MODEL`, `OPENVIDEO_ESPEAK`, `OPENVIDEO_WHISPER`, `OPENVIDEO_WHISPER_MODEL` | Speech synthesis and recognition |
| `OPENVIDEO_API_TOKEN` | Bearer token of the Agent API (required on any non-loopback address) |
| `OPENVIDEO_WORKSPACE`, `OPENVIDEO_PROJECT_ROOTS` | Workspace folder; folders that `project.open` may open |
| `OPENVIDEO_WORKERS`, `OPENVIDEO_ENCODER_THREADS` | Local render processes; encoder threads (default fixed 4 for bit-identical files, `auto` for speed) |
| `OPENVIDEO_CACHE_DIR`, `OPENVIDEO_CACHE_MAX_BYTES`, `OPENVIDEO_OUTPUT_CACHE` | Cache location, size limit, reuse of whole output files (`0` = off) |
| `OPENVIDEO_RENDER_ISOLATION`, `OPENVIDEO_WORKER_IMAGE`, `OPENVIDEO_WORKER_GPUS` | Render chunks in Docker containers, with image and GPU quota |
| `OPENVIDEO_BROWSER_GPU` | `1` renders WebGL/WebGPU on the host GPU instead of SwiftShader (not bit-identical) |
| `OPENVIDEO_ALLOW_HTML_SCRIPTS`, `OPENVIDEO_ALLOW_PLUGINS`, `OPENVIDEO_PLUGIN_PERMISSIONS` | Allow HTML scripts (only with the Chromium OS sandbox) and plugins |

Cluster settings (coordinator, S3, role tokens, metrics) are in [deploy/README.md](../../deploy/README.md).
