# Kommandozeile `openvideo`

Generiert von `scripts/generate-docs.mjs` aus `openvideo --help`.

```text
OpenVideo 0.1.0 – Video-as-Code for coding agents

Usage: openvideo <command> [options]

Commands:
  create <dir>          Create a project (--tsx for TypeScript/JSX)
  dev [dir]             Studio with live preview for a project
  studio [dir]          Same as dev
  validate [path]       Validate schema, assets, fonts and backends
  render [path]         Render a video (--format --codec --width --height --fps --out)
  render-frame [path]   Render one frame to PNG (--frame 2s --scale 0.5 --debug bounds,safe)
  inspect [path]        Project summary, scene tree (--frame) or timeline (--timeline)
  doctor                Check the environment and suggest fixes
  benchmark             Run reproducible benchmarks
  cache <stats|clear|prune>   Manage the cache (--tier frame --max-bytes 1e9)
  fonts [list|check] [path]   List or check fonts
  assets <list|import|inspect> [path]   Manage assets
  serve                 Start the Agent API (HTTP) with the Studio
  mcp                   Start the MCP server on stdio
  migrate <file>        Upgrade an older project file (--write)
  worker                Start a render worker (--stdio or --coordinator <url>)

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
