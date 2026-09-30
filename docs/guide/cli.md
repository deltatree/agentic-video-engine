# Kommandozeile `openvideo`

Generiert von `scripts/generate-docs.mjs` aus `openvideo --help`.

```text
OpenVideo 0.1.0 – Video-as-Code for coding agents

Usage: openvideo <command> [options]

Commands:
  create <dir>          Create a project (--tsx for TypeScript/JSX, --template <name>)
  templates             List the project templates
  dev [dir]             Studio with live preview; watches src/** and project.json, opens the browser (--no-open)
  studio [dir]          Same as dev
  validate [path]       Validate schema, assets, fonts and backends
  render [path]         Render a video (--format --codec --width --height --fps --out --workers <n>, default by cores and memory;
                        --isolation docker renders chunks in containers: --image <worker image> --gpus all|1|device=0)
  render-frame [path]   Render one frame to PNG (--frame 2s --scale 0.5 --debug bounds,safe; --manifest writes <out>.manifest.json)
  inspect [path]        Project summary, scene tree (--frame) or timeline (--timeline)
  op <name>             Run any Agent API operation, same as HTTP/MCP (--input <json|@file>; op --list)
  patch [path]          Apply semantic patches (--input <json|@file> with a patch list; --dry-run)
  contact-sheet [path]  Render several frames into one image (--frames 0,2s,4s | --count 8 --out sheet.png; --manifest writes <out>.manifest.json)
  import <file> [path]  Import SVG, Lottie, glTF, HTML, anime/motion-canvas JSON (--format --id-prefix)
  doctor                Check the environment and suggest fixes
  benchmark             Run reproducible benchmarks (--scenario --resolution --frames --compare)
  cache <stats|clear|prune>   Manage the cache (--tier frame --max-bytes 1e9; clear also removes retired tiers)
  fonts [list|check] [path]   List or check fonts
  assets <list|import|inspect> [path]   Manage assets
  serve                 Start the Agent API (HTTP) with the Studio (--project <dir> opens a project)
  mcp                   Start the MCP server on stdio (--project <dir> opens a project)
  migrate <file>        Upgrade an older project file (--write)
  worker                Start a render worker (--stdio or --coordinator <url>)
  coordinator           Start the render coordinator for remote workers (--port --journal; role tokens OPENVIDEO_SUBMIT_TOKEN, OPENVIDEO_WORKER_TOKEN, OPENVIDEO_METRICS_TOKEN)

Server options (serve, dev, studio):
  --host <addr>          Bind address (default 127.0.0.1; others need a token)
  --port <n>             Port (default 7788)
  --token <secret>       Bearer token (or OPENVIDEO_API_TOKEN); dev/studio create one
  --allowed-host <name>  Extra host name for the Host/Origin check (or OPENVIDEO_ALLOWED_HOSTS)
  --trust-proxy          Trust X-Forwarded-Proto from any peer, e.g. behind a TLS proxy on another host
                         (or OPENVIDEO_TRUST_PROXY=1; default: only from loopback)
  --workers <n>          Render videos with n local worker processes (default by cores and memory; 1 = in process)
  --isolation <mode>     Where video chunks render: process (default) or docker (OPENVIDEO_RENDER_ISOLATION;
                         image OPENVIDEO_WORKER_IMAGE / --image, GPU quota OPENVIDEO_WORKER_GPUS / --gpus)
  --open / --no-open     Open the Studio in the browser (default on for dev/studio, off for serve)

Project and workspace (serve, mcp, op):
  --project <dir>        Open this project folder (project.open may open folders inside it)
  --workspace <dir>      Workspace folder (or OPENVIDEO_WORKSPACE; default .openvideo-workspace)
  OPENVIDEO_PROJECT_ROOTS  Comma-separated folders that project.open may open

Global options:
  --json      Machine-readable output
  --trusted   Allow TSX and HTML scripts of YOUR OWN project to run on this host
  --help      Show help

Exit codes: 0 success, 1 project or render errors, 2 usage errors.
```

## Beispiel aus dem Auftrag (A28)

```bash
openvideo render src/video.tsx \
  --composition hero \
  --format mp4 \
  --codec h264 \
  --width 3840 \
  --height 2160 \
  --fps 60
```
