# Plugins

Plugins extend OpenVideo with **agent tools, codecs, exporters, asset loaders, Studio panels**, node
types, components, effects, backends and speech providers. A plugin is an ES module that registers
its extensions in an explicit `Registry` (ADR 0012). A complete example with one extension of every
kind lives in [`examples/plugin-hello`](../../examples/plugin-hello).

## Enable plugins in a project

List plugin modules in `settings.plugins`:

```json
{
  "schemaVersion": "1.0.0",
  "settings": { "plugins": ["./plugins/hello/index.mjs", "openvideo-plugin-lower-thirds"] },
  "compositions": []
}
```

- A path starting with `.` is resolved relative to the project and must stay inside it.
- Anything else is an npm package name, resolved from the project's `node_modules`
  (`exports["."]` with `import`/`default`, then `module`, then `main`).

## Trust and permissions

Plugins are **code that runs in the render process**. The permission system limits which host
services a plugin receives; it is not a sandbox (a plugin can still import Node modules).

| Setting | Effect |
|---|---|
| `--trusted` (CLI) or host option `trusted: true` | plugins may load |
| `OPENVIDEO_ALLOW_PLUGINS=1` | plugins may load (e.g. in a render container) |
| `OPENVIDEO_PLUGIN_PERMISSIONS=fs:read,fs:write` | grants these permissions, nothing else |
| host option `plugins: { load, permissions }` (`createNodeEnvironment`) | explicit policy for embedders |

Without permission to load, a project with `settings.plugins` fails with `OV_PLUGIN_NOT_ALLOWED`.
A plugin that requests a permission the host did not grant fails with `OV_PLUGIN_PERMISSION`
before its `setup` runs.

| Permission | Service in `ctx` | Limits |
|---|---|---|
| `fs:read` | `readFile(path)` | inside the project directory (symbolic links are resolved and must stay inside) |
| `fs:write` | `writeFile(path, bytes)` | inside the project directory (symbolic links are resolved and must stay inside) |
| `net` | `fetch(url)` | same rules as asset downloads (no private addresses, size limit) |
| `process:spawn` | `spawn(cmd, args, { input, timeoutMs })` | no shell, timeout (default 120 s); the child gets only a minimal environment (`PATH`, `HOME`, temp, locale …), the full host environment only with `env` |
| `env` | `env(name)` | read only |

## Writing a plugin

```js
/** @type {import('@agentic-video/core').Plugin} */
export default {
  name: 'hello',
  version: '1.0.0',
  permissions: ['fs:read', 'fs:write'],
  setup(ctx) {
    ctx.registerAgentTool({ name: 'hello.greet', description: 'Greet someone.', inputSchema: { type: 'object', properties: { name: { type: 'string' } }, required: ['name'] }, handler: async ({ name }) => ({ greeting: `Hello, ${name}!` }) });
  },
};
```

The module exports the plugin as `default` (an object or a factory without arguments) or as the
named export `plugin`. Names of tools, codecs, exporters, loaders and panels match
`^[A-Za-z][A-Za-z0-9_.-]{0,63}$`.

### Agent tools → operations `plugin.<name>`

`registerAgentTool({ name, description, inputSchema, handler })` becomes the operation
`plugin.<name>` in the HTTP API (`POST /v1/plugin.<name>`), in MCP (tool `plugin_<name with _>`,
listed when the MCP server has an open project) and in the CLI:

```bash
openvideo op plugin.hello.greet --project my-video --trusted --input '{"name":"Ada"}'
```

The input is `projectId` plus the fields of `inputSchema` (validated before the handler runs).
`plugins.list { projectId }` lists all tools with their schemas.

### Codecs → `codec: "plugin:<id>"`

```js
ctx.registerCodec({ id: 'x264-fast', formats: ['mp4', 'mov'], license: 'GPL-2.0-or-later (libx264)', encoderArgs: ({ quality, alpha }) => ['-pix_fmt', 'yuv420p', '-c:v', 'libx264', '-preset', 'ultrafast', '-crf', String(Math.round(40 - 0.25 * quality))] });
```

Use it in a render profile (`{ "format": "mp4", "codec": "plugin:x264-fast" }`). The arguments replace
the built-in video encoder arguments. They are checked against an allowlist (`OV_ENCODE_CODEC_ARGS`
otherwise): the list is made of `-option value` pairs only, every value directly follows an allowed
option and is checked for that option. Allowed are video encoder options such as `-c:v`/`-codec:v`/`-vcodec`
(required), `-crf`, `-qp`, `-q:v`, `-b:v`, `-maxrate`, `-bufsize`, `-preset`, `-tune`, `-profile:v`,
`-level`, `-pix_fmt`, color tags, `-g`, `-keyint_min`, `-bf`, `-x264-params`/`-x265-params`/`-svtav1-params`/`-aom-params`
(known `key=value` keys, no paths), `-row-mt`, `-cpu-used`, `-deadline`, `-quality`, `-speed`, `-tiles`
and `-movflags` (known flags). Filters (`-vf`, `-filter*`), inputs, outputs, muxers, mappings, `-threads`,
frame rate, size, progress and report files are set by OpenVideo and rejected. The license goes into
`codecLicenses` of the render manifest.

### Exporters → `format: "plugin:<id>"`

An exporter writes its own output format. OpenVideo renders the frames as a PNG sequence
(`frame-000000.png` …, straight alpha) into `<outPath>.frames/`, mixes the audio to a WAV file and
calls `export({ framesDir, frameCount, width, height, fps, audioPath, outPath })`. The exporter must
create `outPath`; the frames folder is removed afterwards.

```bash
OPENVIDEO_PLUGIN_PERMISSIONS=fs:read,fs:write openvideo op video.render --trusted --project my-video --input '{"profile":{"format":"plugin:hello-frames"}}'
```

### Asset loaders

`registerAssetLoader({ id, extensions, type, inspect })` handles files with these extensions
(checked before the built-in detection) when the render environment resolves `project.assets`
(render, check, inspect), and in `importAsset` of `@agentic-video/assets` when the host passes
`loaders`. `type` is an asset type of the schema (for new formats usually `data`); `inspect` returns
the metadata (for example the header and row count of a CSV file).

### Studio panels

`registerStudioPanel({ id, title, module })` adds a tab **Plugins** to the right panel of the Studio.
`module` is an ES module (`.js` or `.mjs`) relative to the plugin's entry file and must stay inside the
plugin's folder (also through symbolic links); otherwise the panel answers 404:

```js
export default function mount(root, ctx) {
  ctx.onProject((project) => { root.textContent = `${project.compositions.length} compositions`; });
  // ctx.notify('text') writes to the Studio status bar.
}
```

The panel runs in an `<iframe sandbox="allow-scripts">` with its own opaque origin and a strict CSP
(no network, no access to the API token). The CSP allows only the page's own nonce script and the one
panel module; the module cannot load further scripts (no `'strict-dynamic'`), so bundle the panel into one file. The Studio sends the current project (read only) with
`postMessage` after every change. The page URL comes from `plugins.list` and is signed per project,
panel and server process.

### Other extension points

`registerNodeType`, `registerComponent`, `registerExpander`, `registerBackend`, `registerEffect`,
`registerVoiceProvider` and `registerAsrProvider` extend validation, expansion, rendering and speech
the same way; see the TSDoc of `PluginContext` in `@agentic-video/core`.

## Determinism

Loaded plugins appear in the environment versions as `plugin:<name>` and therefore in frame cache
keys: a new plugin version invalidates cached frames. Keep plugins deterministic (no wall clock, no
`Math.random`) if they influence pixels.
