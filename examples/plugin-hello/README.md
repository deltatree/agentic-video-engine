# Example plugin: `hello`

One extension of every kind, in plain JavaScript (no build step):

| Kind | Registered as | Used by |
|---|---|---|
| Agent tool | `hello.greet` | Operation `plugin.hello.greet` (API, MCP, `openvideo op`) |
| Codec | `x264-fast` | Render profile `codec: "plugin:x264-fast"` (mp4, mov) |
| Exporter | `hello-frames` | Render profile `format: "plugin:hello-frames"` (writes `.ovhf`) |
| Asset loader | `hello-csv` | `.csv` assets become type `data` with `header` and `rows` metadata |
| Studio panel | `hello-panel` | Tab "Plugins" in the Studio |

Use it in a project:

```bash
mkdir -p my-video/plugins && cp -r examples/plugin-hello my-video/plugins/hello
```

```json
{ "settings": { "plugins": ["./plugins/hello/index.mjs"] } }
```

```bash
# Plugins are code: they load only when you allow it. The exporter needs file access.
OPENVIDEO_PLUGIN_PERMISSIONS=fs:read,fs:write openvideo render my-video --trusted
openvideo op plugin.hello.greet --project my-video --trusted --input '{"name":"Ada"}'
```

See [docs/guide/plugins.md](../../docs/guide/plugins.md).
