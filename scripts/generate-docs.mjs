#!/usr/bin/env node
// Erzeugt Agent-Doku aus dem Code (FR-93): docs/ai/capabilities.json, docs/guide/api.md,
// docs/guide/cli.md, die Node-Beispiele in docs/reference/node-semantics.md und packages/mcp/src/agents-doc.ts (docs/ai/AGENTS.md als MCP-Resource).
// Braucht gebaute Pakete (npm run build); danach packages/mcp neu bauen.
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const schema = await import('@agentic-video/schema');
const timeline = await import('@agentic-video/timeline');
const { COMPONENTS } = await import('@agentic-video/components');
const { OPERATIONS, PATCH_EXAMPLES } = await import('@agentic-video/agent');
const { loadCanvasKitNode, createSkiaBackend } = await import('@agentic-video/renderer-skia');
const { loadFontSet } = await import('@agentic-video/fonts');
const { createLazyBrowserBackends } = await import('@agentic-video/renderer-browser');
const { createBlenderBackend } = await import('@agentic-video/renderer-blender');
const { runCli } = await import('@agentic-video/cli');

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
};
mkdirSync(join(root, 'docs', 'ai'), { recursive: true });
writeFileSync(join(root, 'docs', 'ai', 'capabilities.json'), `${JSON.stringify(manifest, null, 2)}\n`);

const api = [
  '# Agent API',
  '',
  `Generiert von \`scripts/generate-docs.mjs\`. Jede der ${OPERATIONS.size} Operationen ist über HTTP (\`POST /v1/<name>\`), MCP (Tool \`<name>\` mit \`_\` statt \`.\`) und die CLI (\`openvideo op <name> --input <json|@datei>\`) erreichbar (ADR 0009).`,
  'Der MCP-Server bietet zusätzlich die Resources `openvideo://agents.md`, `openvideo://schema.json` und `openvideo://capabilities.json`.',
  '',
  '| Operation | Zweck | Job |',
  '|---|---|---|',
];
for (const op of OPERATIONS.values()) api.push(`| \`${op.name}\` | ${op.summary} | ${op.job === true ? 'ja' : ''} |`);
api.push('', '## Beispiele', '');
for (const op of OPERATIONS.values()) api.push(`### ${op.name}`, '', op.summary, '', '```json', JSON.stringify(op.example.input, null, 2), '```', '');
api.push('## Patch-Arten', '', '`composition.patch` nimmt eine Liste typisierter Patches; das Feld `op` wählt die Art (JSON Schema: `schema.get` mit `{ "name": "patch" }`). Jedes Beispiel läuft gegen ein Projekt mit der Composition `main` und den Text-Nodes `headline` und `f1`; vorbereitende Patches stehen davor.', '');
for (const [op, patches] of Object.entries(PATCH_EXAMPLES)) api.push(`### ${op}`, '', '```json', JSON.stringify({ projectId: 'demo', patches }, null, 2), '```', '');
api.push('## Fehler', '', 'Fehler kommen als `{ "error": Diagnostic }` mit HTTP 400 (Eingabe), 401 (Token), 403 (Sicherheit), 404 (unbekannt) oder 500 (Fehler in OpenVideo).', 'Jede Diagnose hat `code`, `problem`, `path` (bei Patches mit Index, z. B. `patches[3].nodeId`), `expected`, `received` und mindestens einen Vorschlag in `suggestions`.', '');
writeFileSync(join(root, 'docs', 'guide', 'api.md'), api.join('\n'));

let help = '';
await runCli(['--help'], { stdout: (t) => (help += t), stderr: () => undefined, cwd: root, env: process.env });
writeFileSync(join(root, 'docs', 'guide', 'cli.md'), ['# Kommandozeile `openvideo`', '', 'Generiert von `scripts/generate-docs.mjs` aus `openvideo --help`.', '', '```text', help.trim(), '```', '', '## Beispiel aus dem Auftrag (A28)', '', '```bash', 'openvideo render src/video.tsx \\', '  --composition hero \\', '  --format mp4 \\', '  --codec h264 \\', '  --width 3840 \\', '  --height 2160 \\', '  --fps 60', '```', ''].join('\n'));
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

// Beispiele je Node-Typ in docs/reference/node-semantics.md (zwischen den Markierungen, Story 19.7).
const semanticsFile = join(root, 'docs', 'reference', 'node-semantics.md');
const semantics = readFileSync(semanticsFile, 'utf8');
const START = '<!-- node-examples:start -->';
const END = '<!-- node-examples:end -->';
if (!semantics.includes(START) || !semantics.includes(END)) throw new Error(`${semanticsFile} braucht die Markierungen ${START} und ${END}.`);
const exampleBlocks = [START, '', `Generiert von \`scripts/generate-docs.mjs\` aus \`NODE_EXAMPLES\` (\`@agentic-video/schema\`). Jedes Beispiel ist gültig; \`exampleProject(type)\` bettet es in ein Projekt mit Composition \`main\` (640 × 360, 30 fps, 2 s) ein. 3D-Nodes stehen dort in einer \`scene3d\` mit Kamera und Licht. Verweise: Assets ${schema.EXAMPLE_ASSETS.map((a) => `\`${a.id}\` (${a.type}, \`${a.src}\`)`).join(', ')}; Untertitel-Track \`captions\`; Composition \`intro\`.`, ''];
for (const [type, summary] of Object.entries(nodeTypes)) {
  exampleBlocks.push(`### \`${type}\``, '', summary.description, '', '```json', compactJson(summary.example), '```', '');
}
exampleBlocks.push(END);
writeFileSync(semanticsFile, semantics.slice(0, semantics.indexOf(START)) + exampleBlocks.join('\n') + semantics.slice(semantics.indexOf(END) + END.length));

const agentsMd = readFileSync(join(root, 'docs', 'ai', 'AGENTS.md'), 'utf8');
writeFileSync(
  join(root, 'packages', 'mcp', 'src', 'agents-doc.ts'),
  ['// Generiert von scripts/generate-docs.mjs aus docs/ai/AGENTS.md. Nicht von Hand ändern.', '', '/** Inhalt von `docs/ai/AGENTS.md` (MCP-Resource `openvideo://agents.md`). */', `export const AGENTS_MD: string = ${JSON.stringify(agentsMd)};`, ''].join('\n'),
);
await lazy.dispose();
console.log(`Doku erzeugt: ${Object.keys(nodeTypes).length} Node-Typen, ${manifest.components.length} Komponenten, ${manifest.operations.length} Operationen, ${manifest.backends.length} Backends.`);
