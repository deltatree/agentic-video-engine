#!/usr/bin/env node
// Erzeugt Agent-Doku aus dem Code (FR-93): docs/ai/capabilities.json, docs/guide/api.md,
// docs/guide/cli.md, die Node-Beispiele in docs/reference/node-semantics.md (englisch) und
// docs/reference/node-semantics.de.md (deutsch) sowie packages/mcp/src/agents-doc.ts
// (docs/ai/AGENTS.md als MCP-Resource). Braucht gebaute Pakete (npm run build); danach packages/mcp neu bauen.
//
// Sprache (Entscheidung T2, Story 19.8): Die generierten Referenzen api.md und cli.md gibt es nur auf
// Englisch (Operationen, Optionen und Fehler sind ohnehin englisch). Handgeschriebene Dokumente mit
// generiertem Abschnitt (node-semantics) bekommen den Abschnitt in beiden Sprachfassungen.
//
// `--check` (Drift-Gate, Story 19.8): schreibt nichts, vergleicht jede erzeugte Datei mit dem Stand im
// Arbeitsbaum und endet mit Code 1, wenn eine abweicht (Teil von `npm run check` und CI).
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const check = process.argv.includes('--check');
// Maschinenabhängige Eingaben neutralisieren: Ohne eigenen Chromium-Pfad und ohne GPU-Modus nennen die
// Backends die Chromium-Version von playwright-core (ADR 0019); so ist die Ausgabe auf jeder Maschine gleich.
delete process.env.OPENVIDEO_CHROMIUM;
delete process.env.OPENVIDEO_BROWSER_GPU;
/** Erzeugte Dateien: Pfad relativ zum Repository → Inhalt. */
const outputs = new Map();
/** Merkt eine erzeugte Datei vor (geschrieben oder geprüft wird am Ende). */
function emit(rel, text) {
  outputs.set(rel, text);
}
/** Liest eine Datei des Repositorys (für Dokumente mit generiertem Abschnitt). */
function readRepo(rel) {
  return readFileSync(join(root, rel), 'utf8');
}
const schema = await import('@agentic-video/schema');
const timeline = await import('@agentic-video/timeline');
const { COMPONENTS } = await import('@agentic-video/components');
const { OPERATIONS, PATCH_EXAMPLES } = await import('@agentic-video/agent');
const { loadCanvasKitNode, createSkiaBackend } = await import('@agentic-video/renderer-skia');
const { loadFontSet } = await import('@agentic-video/fonts');
const { createLazyBrowserBackends } = await import('@agentic-video/renderer-browser');
const { createBlenderBackend } = await import('@agentic-video/renderer-blender');
const { runCli } = await import('@agentic-video/cli');
const { createTemplateCatalog } = await import('@agentic-video/templates');

const fonts = await loadFontSet({});
const canvasKit = await loadCanvasKitNode();
const noAssets = { get: () => undefined, bytes: () => Promise.reject(new Error('none')), videoFrame: () => Promise.reject(new Error('none')), all: () => [] };
const lazy = createLazyBrowserBackends({ assets: noAssets, fonts, width: 1920, height: 1080 });
const backends = [createSkiaBackend({ canvasKit, fonts }), lazy.browser, lazy.three, lazy.pixi, createBlenderBackend({ workDir: join(tmpdir(), 'ov-docs-blender') })];

// Story 19.7: je Node-Typ Property-Typen und ein gültiges JSON-Beispiel (dieselbe Quelle wie capabilities.get).
const nodeTypes = Object.fromEntries(Object.entries(schema.NODE_SCHEMAS).map(([type, s]) => [type, schema.summarizeNodeType(type, s)]));
const manifest = {
  generated: 'scripts/generate-docs.mjs',
  product: schema.PRODUCT_NAME,
  schemaVersion: schema.SCHEMA_VERSION,
  nodeTypes,
  components: COMPONENTS.map((c) => ({ name: c.name, description: c.description, props: c.propsSchema, example: c.example })),
  operations: [...OPERATIONS.values()].map((op) => ({ name: op.name, summary: op.summary, job: op.job === true, example: op.example.input })),
  patchOps: Object.keys(PATCH_EXAMPLES),
  backends: backends.map((b) => ({ id: b.id, nodeTypes: b.nodeTypes, capabilities: b.capabilities, fusable: b.fusable, versions: b.versions() })),
  easings: [...Object.keys(timeline.EASINGS), 'ease', 'easeIn', 'easeOut', 'easeInOut', 'cubic-bezier(x1,y1,x2,y2)', 'steps(n,start|end)', 'spring(stiffness,damping[,mass])'],
  transitions: [...schema.TRANSITION_TYPES],
  blendModes: [...schema.BLEND_MODES],
  layerEffects: schema.LayerEffect.anyOf.map((e) => e.properties.type.const),
  filters: schema.Filter.anyOf.map((e) => e.properties.type.const),
  expressionFunctions: Object.keys(timeline.EXPR_FUNCTIONS),
  outputFormats: [...schema.OUTPUT_FORMATS],
  videoCodecs: [...schema.VIDEO_CODECS],
  assetTypes: [...schema.ASSET_TYPES],
  bundledFonts: [...new Set(fonts.all().map((f) => f.family))],
  templates: createTemplateCatalog().list().map((t) => ({ name: t.name, title: t.title, description: t.description, width: t.width, height: t.height, fps: t.fps, durationSeconds: t.durationSeconds })),
};
emit('docs/ai/capabilities.json', `${JSON.stringify(manifest, null, 2)}\n`);

/** Rückgabefelder einer Operation aus ihrem Ausgabe-Schema (TypeBox-Objekt), sonst „object“. */
function outputFields(op) {
  const props = op.output !== undefined && typeof op.output === 'object' && op.output !== null ? op.output.properties : undefined;
  return props !== undefined && props !== null ? Object.keys(props).map((k) => `\`${k}\``).join(', ') : 'object';
}

const api = [
  '# Agent API',
  '',
  '> Generated by `scripts/generate-docs.mjs` from the operation definitions. Do not edit by hand; run',
  '> `node scripts/generate-docs.mjs` (CI runs it with `--check`). This reference exists in English only.',
  '',
  `Each of the ${OPERATIONS.size} operations is available over HTTP (\`POST /v1/<name>\`), MCP (tool \`<name>\` with \`_\` instead of \`.\`) and the CLI (\`openvideo op <name> --input <json|@file>\`) (ADR 0009).`,
  'Agent tools of plugins add operations `plugin.<name>` (listed by `plugins.list`; MCP tool `plugin_<name with _>`).',
  'The MCP server also serves the resources `openvideo://agents.md`, `openvideo://schema.json` and `openvideo://capabilities.json`.',
  '',
  '## HTTP endpoints',
  '',
  '| Endpoint | Purpose |',
  '|---|---|',
  '| `GET /v1/health` | `{ "ok": true }`; the only route without a token |',
  '| `GET /v1/operations` | all operations with input schema and example |',
  '| `POST /v1/<operation>` | JSON input, JSON result or `{ "error": Diagnostic }` |',
  '| `GET /v1/jobs/<id>` | status of a render job (same as `render.status`) |',
  '| `GET /v1/files/<projectId>/<path>` | files of a project (frames, videos, manifests); the `ETag` of `project.json` is its content revision |',
  '| `GET /v1/events?projectId=<id>` | Server-Sent Events: `event: revision` with `{ "projectId", "revision" }` on every change of `project.json`; the first message is the current revision (ADR 0025) |',
  '',
  'With a token (`--token` or `OPENVIDEO_API_TOKEN`) every route except `/v1/health` needs `Authorization: Bearer <token>`.',
  '',
  '| Operation | Purpose | Job | Returns |',
  '|---|---|---|---|',
];
for (const op of OPERATIONS.values()) api.push(`| \`${op.name}\` | ${op.summary} | ${op.job === true ? 'yes' : ''} | ${outputFields(op)} |`);
api.push('', 'Job operations return `{ jobId, state }` over HTTP and MCP; poll `render.status { jobId }` until `state` is `succeeded`, `failed` or `cancelled`. `openvideo op` waits for the job and prints its final status.', '');
api.push('## Input examples', '');
for (const op of OPERATIONS.values()) api.push(`### ${op.name}`, '', op.summary, '', '```json', JSON.stringify(op.example.input, null, 2), '```', '');
api.push('## Patch kinds', '', '`composition.patch` takes a list of typed patches; the field `op` selects the kind (JSON Schema: `schema.get` with `{ "name": "patch" }`). `frame.render` accepts the same list as `patches` for a transient preview that is never saved. Every example runs against a project with the composition `main` and the text nodes `headline` and `f1`; preparing patches come first.', '');
for (const [op, patches] of Object.entries(PATCH_EXAMPLES)) api.push(`### ${op}`, '', '```json', JSON.stringify({ projectId: 'demo', patches }, null, 2), '```', '');
api.push('## Errors', '', 'Errors come as `{ "error": Diagnostic }` with HTTP 400 (input), 401 (token), 403 (security), 404 (unknown) or 500 (bug in OpenVideo).', 'Every diagnostic has `code`, `problem`, `path` (for patches with the index, e.g. `patches[3]` or `patches[3].nodeId`), `expected`, `received` and at least one entry in `suggestions`.', '');
emit('docs/guide/api.md', api.join('\n'));

let help = '';
await runCli(['--help'], { stdout: (t) => (help += t), stderr: () => undefined, cwd: root, env: {} });
emit(
  'docs/guide/cli.md',
  [
    '# Command line `openvideo`',
    '',
    '> Generated by `scripts/generate-docs.mjs` from `openvideo --help`. Do not edit by hand. This reference exists in English only.',
    '',
    '```text',
    help.trim(),
    '```',
    '',
    '## Example from the brief (A28)',
    '',
    '```bash',
    'openvideo render src/video.tsx \\',
    '  --composition hero \\',
    '  --format mp4 \\',
    '  --codec h264 \\',
    '  --width 3840 \\',
    '  --height 2160 \\',
    '  --fps 60',
    '```',
    '',
  ].join('\n'),
);
/** JSON mit kurzen Objekten und Listen auf einer Zeile (für lesbare Doku-Beispiele). */
function flatJson(value) {
  if (Array.isArray(value)) return `[${value.map(flatJson).join(', ')}]`;
  if (typeof value === 'object' && value !== null) return `{ ${Object.entries(value).map(([k, v]) => `${JSON.stringify(k)}: ${flatJson(v)}`).join(', ')} }`;
  return JSON.stringify(value) ?? 'null';
}
function compactJson(value, indent = '') {
  const flat = flatJson(value);
  if (flat.length + indent.length <= 110 || typeof value !== 'object' || value === null) return flat;
  const inner = `${indent}  `;
  if (Array.isArray(value)) return `[\n${value.map((v) => inner + compactJson(v, inner)).join(',\n')}\n${indent}]`;
  return `{\n${Object.entries(value).map(([k, v]) => `${inner}${JSON.stringify(k)}: ${compactJson(v, inner)}`).join(',\n')}\n${indent}}`;
}

// Beispiele je Node-Typ in docs/reference/node-semantics.md und .de.md (zwischen den Markierungen, Story 19.7).
const START = '<!-- node-examples:start -->';
const END = '<!-- node-examples:end -->';
const assetList = schema.EXAMPLE_ASSETS.map((a) => `\`${a.id}\` (${a.type}, \`${a.src}\`)`).join(', ');
const semanticsIntro = {
  'docs/reference/node-semantics.md': `Generated by \`scripts/generate-docs.mjs\` from \`NODE_EXAMPLES\` (\`@agentic-video/schema\`). Every example is valid; \`exampleProject(type)\` embeds it in a project with the composition \`main\` (640 × 360, 30 fps, 2 s). 3D nodes sit there in a \`scene3d\` with camera and light. References: assets ${assetList}; subtitle track \`captions\`; composition \`intro\`.`,
  'docs/reference/node-semantics.de.md': `Generiert von \`scripts/generate-docs.mjs\` aus \`NODE_EXAMPLES\` (\`@agentic-video/schema\`). Jedes Beispiel ist gültig; \`exampleProject(type)\` bettet es in ein Projekt mit Composition \`main\` (640 × 360, 30 fps, 2 s) ein. 3D-Nodes stehen dort in einer \`scene3d\` mit Kamera und Licht. Verweise: Assets ${assetList}; Untertitel-Track \`captions\`; Composition \`intro\`.`,
};
for (const [rel, intro] of Object.entries(semanticsIntro)) {
  const semantics = readRepo(rel);
  if (!semantics.includes(START) || !semantics.includes(END)) throw new Error(`${rel} braucht die Markierungen ${START} und ${END}.`);
  const exampleBlocks = [START, '', intro, ''];
  for (const [type, summary] of Object.entries(nodeTypes)) {
    exampleBlocks.push(`### \`${type}\``, '', summary.description, '', '```json', compactJson(summary.example), '```', '');
  }
  exampleBlocks.push(END);
  emit(rel, semantics.slice(0, semantics.indexOf(START)) + exampleBlocks.join('\n') + semantics.slice(semantics.indexOf(END) + END.length));
}

// Die MCP-Resource ist die englische Fassung (T2); die deutsche liegt daneben als docs/ai/AGENTS.de.md.
const agentsMd = readRepo('docs/ai/AGENTS.md');
emit(
  'packages/mcp/src/agents-doc.ts',
  ['// Generiert von scripts/generate-docs.mjs aus docs/ai/AGENTS.md. Nicht von Hand ändern.', '', '/** Inhalt von `docs/ai/AGENTS.md` (MCP-Resource `openvideo://agents.md`). */', `export const AGENTS_MD: string = ${JSON.stringify(agentsMd)};`, ''].join('\n'),
);
await lazy.dispose();

if (check) {
  const stale = [...outputs].filter(([rel, text]) => !existsSync(join(root, rel)) || readRepo(rel) !== text).map(([rel]) => rel);
  if (stale.length > 0) {
    console.error(`Generated docs are out of date: ${stale.join(', ')}.\nRun \`npm run build && node scripts/generate-docs.mjs\` and commit the result.`);
    process.exit(1);
  }
  console.log(`Generated docs are up to date (${String(outputs.size)} files).`);
} else {
  for (const [rel, text] of outputs) {
    mkdirSync(dirname(join(root, rel)), { recursive: true });
    writeFileSync(join(root, rel), text);
  }
  console.log(`Doku erzeugt (${String(outputs.size)} Dateien): ${Object.keys(nodeTypes).length} Node-Typen, ${manifest.components.length} Komponenten, ${manifest.operations.length} Operationen, ${manifest.templates.length} Templates, ${manifest.backends.length} Backends.`);
}
