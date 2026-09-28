#!/usr/bin/env node
// Erzeugt Agent-Doku aus dem Code (FR-93): docs/ai/capabilities.json, docs/guide/api.md,
// docs/guide/cli.md. Braucht gebaute Pakete (npm run build).
import { writeFileSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const schema = await import('@agentic-video/schema');
const timeline = await import('@agentic-video/timeline');
const { COMPONENTS } = await import('@agentic-video/components');
const { OPERATIONS } = await import('@agentic-video/agent');
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

const nodeTypes = Object.fromEntries(
  Object.entries(schema.NODE_SCHEMAS).map(([type, s]) => [type, { description: s.description, properties: Object.keys(s.properties).filter((k) => !['id', 'type', 'name', 'comment', 'meta'].includes(k)), required: (s.required ?? []).filter((k) => k !== 'id' && k !== 'type') }]),
);
const manifest = {
  generated: 'scripts/generate-docs.mjs',
  product: schema.PRODUCT_NAME,
  schemaVersion: schema.SCHEMA_VERSION,
  nodeTypes,
  components: COMPONENTS.map((c) => ({ name: c.name, description: c.description, props: c.propsSchema, example: c.example })),
  operations: [...OPERATIONS.values()].map((op) => ({ name: op.name, summary: op.summary, job: op.job === true, example: op.example.input })),
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

const api = ['# Agent API', '', 'Generiert von `scripts/generate-docs.mjs`. Jede Operation ist über HTTP (`POST /v1/<name>`), MCP (Tool `<name>` mit `_` statt `.`) und teilweise die CLI erreichbar.', '', '| Operation | Zweck | Job |', '|---|---|---|'];
for (const op of OPERATIONS.values()) api.push(`| \`${op.name}\` | ${op.summary} | ${op.job === true ? 'ja' : ''} |`);
api.push('', '## Beispiele', '');
for (const op of OPERATIONS.values()) api.push(`### ${op.name}`, '', op.summary, '', '```json', JSON.stringify(op.example.input, null, 2), '```', '');
api.push('## Fehler', '', 'Fehler kommen als `{ "error": Diagnostic }` mit HTTP 400 (Eingabe), 401 (Token), 403 (Sicherheit), 404 (unbekannt) oder 500 (Fehler in OpenVideo).', '');
writeFileSync(join(root, 'docs', 'guide', 'api.md'), api.join('\n'));

let help = '';
await runCli(['--help'], { stdout: (t) => (help += t), stderr: () => undefined, cwd: root, env: process.env });
writeFileSync(join(root, 'docs', 'guide', 'cli.md'), ['# Kommandozeile `openvideo`', '', 'Generiert von `scripts/generate-docs.mjs` aus `openvideo --help`.', '', '```text', help.trim(), '```', '', '## Beispiel aus dem Auftrag (A28)', '', '```bash', 'openvideo render src/video.tsx \\', '  --composition hero \\', '  --format mp4 \\', '  --codec h264 \\', '  --width 3840 \\', '  --height 2160 \\', '  --fps 60', '```', ''].join('\n'));
await lazy.dispose();
console.log(`Doku erzeugt: ${Object.keys(nodeTypes).length} Node-Typen, ${manifest.components.length} Komponenten, ${manifest.operations.length} Operationen, ${manifest.backends.length} Backends.`);
