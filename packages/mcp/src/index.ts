/**
 * @packageDocumentation
 * MCP-Server von OpenVideo (FR-22): jede Agent-Operation ist ein MCP-Tool.
 * API, MCP und CLI teilen dieselben Operationsdefinitionen (AD-9).
 *
 * Tool-Namen nutzen `_` statt `.` (z. B. `frame_render`), weil viele MCP-Clients
 * nur `[A-Za-z0-9_-]` erlauben. Bildergebnisse kommen als MCP-Bildinhalt zurück,
 * damit der Agent sie direkt sieht.
 *
 * Resources (Story 19.3): `openvideo://agents.md` (Agent-Leitfaden), `openvideo://schema.json`
 * (JSON Schema der IR) und `openvideo://capabilities.json` (Capability-Manifest dieses Hosts).
 *
 * @example
 * ```ts
 * import { serveStdio } from '@agentic-video/mcp';
 * await serveStdio(services);
 * ```
 */
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListResourcesRequestSchema, ListToolsRequestSchema, ReadResourceRequestSchema, type CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { OPERATIONS, invokeOperation, type AgentServices, type OperationDefinition } from '@agentic-video/agent';
import { OpenVideoError, PATCH_OPS, PRODUCT_NAME, formatDiagnostic, isRecord } from '@agentic-video/core';
import { AGENTS_MD } from './agents-doc.js';

export { AGENTS_MD } from './agents-doc.js';

/** Wandelt einen Operationsnamen in einen MCP-Tool-Namen um. */
export function toolName(operation: string): string {
  return operation.replace(/\./gu, '_');
}

/** Optionen für {@link createMcpServer}. */
export interface McpServerOptions {
  readonly version?: string;
  readonly extraOperations?: ReadonlyMap<string, OperationDefinition>;
  /** Bereits geöffnetes Projekt (`openvideo mcp --project <dir>`); steht in den Instructions. */
  readonly projectId?: string;
}

/**
 * Anleitung, die der MCP-Client beim Verbinden erhält. Nennt Kreislauf, Selbstbeschreibung,
 * Patch-Arten, Zeit- und Koordinatenregeln und wie Fehler zu lesen sind.
 *
 * @example
 * ```ts
 * mcpInstructions('launch-video'); // "... The project \"launch-video\" is open ..."
 * ```
 */
export function mcpInstructions(projectId?: string): string {
  return [
    `${PRODUCT_NAME} renders videos from a JSON document, the Composition IR. Every frame is a pure function of composition, assets, frame and seed.`,
    '',
    'Start:',
    projectId !== undefined
      ? `- The project "${projectId}" is open. Pass "projectId": "${projectId}" to the tools. project_inspect summarizes it.`
      : '- project_inspect lists the projects. project_create makes a new one (template, JSON or empty); project_open opens an existing folder inside the allowed roots.',
    '- Read the resource openvideo://agents.md once: rules, animation, node types, patches, diagnostics.',
    '- capabilities_get tells what this host can do (filter with nodeType or component); schema_get returns JSON Schemas (nodeType, name: "patch", operation).',
    '',
    'Loop: composition_validate → frame_render / frame_renderMany / preview_contactSheet (look at the images) → composition_patch → frame_render again → video_render → render_status (poll until done).',
    '',
    `Edit with composition_patch instead of rewriting the IR. Patch kinds (field "op"): ${PATCH_OPS.join(', ')}. A patch list is applied all or nothing; the result has "inverse" for undo; "dryRun": true only checks.`,
    'Understand a frame without pixels: frame_inspect (tree, bounds, diagnostics), scene_describe (sentences), timeline_inspect (timing, keyframes, markers).',
    'Bring in media and designs: asset_import (files, URLs, base64), project_import (SVG, Lottie, glTF, HTML, anime.js timeline, Motion Canvas scenes; lossy parts come back as OV_IMPORT_LOSSY warnings), subtitles_transcribe (speech to subtitle cues).',
    '',
    'Rules: times are frames (48) or text ("2s", "500ms", "00:00:02:00", "marker:intro+10f"); coordinates are pixels from the top-left, x/y is the top-left corner of the box, rotation in degrees; colors are #RRGGBB or #RRGGBBAA; node ids are unique.',
    'Errors are diagnostics with code, path (e.g. patches[2].nodeId), expected, received and suggestions. Apply the first suggestion; "Did you mean" names the closest valid value.',
  ].join('\n');
}

/** Adressen der MCP-Resources. */
export const MCP_RESOURCES = [
  { uri: 'openvideo://agents.md', name: 'agents.md', title: 'OpenVideo guide for coding agents', description: 'Workflow, rules, animation, node types, patches, diagnostics.', mimeType: 'text/markdown' },
  { uri: 'openvideo://schema.json', name: 'schema.json', title: 'JSON Schema of the Composition IR', description: 'Full JSON Schema (draft-07) of project.json.', mimeType: 'application/json' },
  { uri: 'openvideo://capabilities.json', name: 'capabilities.json', title: 'Capability manifest of this host', description: 'Node types, components, operations, patch ops, backends, easings, formats.', mimeType: 'application/json' },
] as const;

function stripBase64(value: unknown): unknown {
  if (!isRecord(value)) return value;
  const { base64: _dropped, ...rest } = value;
  return rest;
}

function withoutImageData(result: unknown): unknown {
  if (!isRecord(result)) return result;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(result)) {
    if (k === 'image') out[k] = stripBase64(v);
    else if (k === 'images' && Array.isArray(v)) out[k] = v.map(stripBase64);
    else out[k] = v;
  }
  return out;
}

/** Alle Bilder eines Ergebnisses (`image` und `images[]`) mit Base64-Daten. */
function imagesOf(result: unknown): string[] {
  if (!isRecord(result)) return [];
  const list: unknown[] = [result['image'], ...(Array.isArray(result['images']) ? Array.from<unknown>(result['images']) : [])];
  return list.flatMap((img) => (isRecord(img) && typeof img['base64'] === 'string' ? [img['base64']] : []));
}

/**
 * Erzeugt einen MCP-Server mit allen Operationen als Tools.
 *
 * @example
 * ```ts
 * const server = createMcpServer(services);
 * await server.connect(transport);
 * ```
 */
export function createMcpServer(services: AgentServices, options: McpServerOptions = {}): McpServer {
  const operations = new Map<string, OperationDefinition>([...OPERATIONS, ...(options.extraOperations ?? new Map<string, OperationDefinition>())]);
  const byTool = new Map([...operations.values()].map((op) => [toolName(op.name), op]));
  const mcp = new McpServer({ name: 'openvideo', version: options.version ?? '0.1.0' }, { capabilities: { tools: {}, resources: {} }, instructions: mcpInstructions(options.projectId) });
  // Die Operationen haben JSON Schemas (TypeBox); darum die Protokoll-Ebene statt registerTool (zod).
  const server = mcp.server;

  server.setRequestHandler(ListToolsRequestSchema, () =>
    Promise.resolve({
      tools: [...operations.values()].map((op) => ({
        name: toolName(op.name),
        title: op.name,
        description: `${op.summary}${op.job === true ? ' Returns a jobId; poll render_status.' : ''} Example: ${JSON.stringify(op.example.input)}`,
        inputSchema: { type: 'object' as const, ...Object.fromEntries(Object.entries(op.input).filter(([k]) => k !== 'type')) },
      })),
    }),
  );

  server.setRequestHandler(CallToolRequestSchema, async (request): Promise<CallToolResult> => {
    const op = byTool.get(request.params.name) ?? operations.get(request.params.name);
    const name = op?.name ?? request.params.name;
    const r = await invokeOperation(operations, name, request.params.arguments ?? {}, { services, via: 'mcp' });
    if (!r.ok) {
      return { isError: true, content: [{ type: 'text', text: `${formatDiagnostic(r.error)}\n\n${JSON.stringify({ error: r.error })}` }] };
    }
    const content: CallToolResult['content'] = [];
    const result = r.result;
    for (const data of imagesOf(result)) content.push({ type: 'image', data, mimeType: 'image/png' });
    content.push({ type: 'text', text: JSON.stringify(withoutImageData(result), null, 2) });
    return { content };
  });

  server.setRequestHandler(ListResourcesRequestSchema, () => Promise.resolve({ resources: MCP_RESOURCES.map((r) => ({ ...r })) }));

  server.setRequestHandler(ReadResourceRequestSchema, async (request) => {
    const uri = request.params.uri;
    const json = async (operation: string, pick: (result: unknown) => unknown): Promise<string> => {
      const r = await invokeOperation(operations, operation, {}, { services, via: 'mcp' });
      if (!r.ok) throw new OpenVideoError(r.error);
      return JSON.stringify(pick(r.result), null, 2);
    };
    let text: string;
    if (uri === 'openvideo://agents.md') text = AGENTS_MD;
    else if (uri === 'openvideo://schema.json') text = await json('schema.get', (result) => (isRecord(result) ? result['schema'] : result));
    else if (uri === 'openvideo://capabilities.json') text = await json('capabilities.get', (result) => result);
    else {
      throw new OpenVideoError({ code: 'OV_MCP_RESOURCE_UNKNOWN', errorClass: 'ApiError', problem: `Unknown resource "${uri}".`, suggestions: [`Use one of: ${MCP_RESOURCES.map((r) => r.uri).join(', ')}.`] });
    }
    const meta = MCP_RESOURCES.find((r) => r.uri === uri);
    return { contents: [{ uri, mimeType: meta?.mimeType ?? 'text/plain', text }] };
  });
  return mcp;
}

/**
 * Startet den MCP-Server über stdio (für Agent-Clients wie Claude Code).
 *
 * @example
 * ```ts
 * await serveStdio(services);
 * ```
 */
export async function serveStdio(services: AgentServices, options: McpServerOptions = {}): Promise<McpServer> {
  const server = createMcpServer(services, options);
  await server.connect(new StdioServerTransport());
  return server;
}
