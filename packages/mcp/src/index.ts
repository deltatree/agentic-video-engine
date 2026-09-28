/**
 * @packageDocumentation
 * MCP-Server von OpenVideo (FR-22): jede Agent-Operation ist ein MCP-Tool.
 * API, MCP und CLI teilen dieselben Operationsdefinitionen (AD-9).
 *
 * Tool-Namen nutzen `_` statt `.` (z. B. `frame_render`), weil viele MCP-Clients
 * nur `[A-Za-z0-9_-]` erlauben. Bildergebnisse kommen als MCP-Bildinhalt zurück,
 * damit der Agent sie direkt sieht.
 *
 * @example
 * ```ts
 * import { serveStdio } from '@agentic-video/mcp';
 * await serveStdio(services);
 * ```
 */
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema, type CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { OPERATIONS, invokeOperation, type AgentServices, type OperationDefinition } from '@agentic-video/agent';
import { PRODUCT_NAME, formatDiagnostic, isRecord } from '@agentic-video/core';

/** Wandelt einen Operationsnamen in einen MCP-Tool-Namen um. */
export function toolName(operation: string): string {
  return operation.replace(/\./gu, '_');
}

/** Optionen für {@link createMcpServer}. */
export interface McpServerOptions {
  readonly version?: string;
  readonly extraOperations?: ReadonlyMap<string, OperationDefinition>;
}

const INSTRUCTIONS = [
  `${PRODUCT_NAME} renders videos from a JSON composition (Composition IR).`,
  'Typical loop: project_create → composition_validate → frame_render / preview_contactSheet → composition_patch → frame_render → video_render → render_status.',
  'Use composition_patch with setProperty/addNode/addKeyframe instead of rewriting whole compositions.',
  'Times accept frames (48) or strings ("2s", "500ms", "00:00:02:00", "marker:intro+10f").',
].join('\n');

function withoutImageData(result: unknown): unknown {
  if (!isRecord(result)) return result;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(result)) {
    if (k === 'image' && isRecord(v)) {
      const { base64: _dropped, ...rest } = v;
      out[k] = rest;
    } else out[k] = v;
  }
  return out;
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
  const mcp = new McpServer({ name: 'openvideo', version: options.version ?? '0.1.0' }, { capabilities: { tools: {} }, instructions: INSTRUCTIONS });
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
    if (isRecord(result) && isRecord(result['image']) && typeof result['image']['base64'] === 'string') {
      content.push({ type: 'image', data: result['image']['base64'], mimeType: 'image/png' });
    }
    content.push({ type: 'text', text: JSON.stringify(withoutImageData(result), null, 2) });
    return { content };
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
