/**
 * Story 21.1: Agent Tools aus Plugins des geöffneten Projekts erscheinen als MCP-Tools.
 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { describe, expect, it } from 'vitest';
import { MemoryStore, createCache } from '@agentic-video/cache';
import { Registry, isPlugin, isRecord } from '@agentic-video/core';
import { encodePng } from '@agentic-video/png';
import { createTelemetry } from '@agentic-video/telemetry';
import { JobManager, OPERATIONS, Workspace, invokeOperation, type AgentServices } from '@agentic-video/agent';
import { createMcpServer } from '@agentic-video/mcp';

const ENTRY = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', 'examples', 'plugin-hello', 'index.mjs');

async function services(): Promise<AgentServices> {
  const root = mkdtempSync(join(tmpdir(), 'ov-mcp-plugins-'));
  const telemetry = createTelemetry({ serviceName: 'mcp-test', exporter: 'memory', logSink: () => undefined });
  const registry = new Registry();
  const mod: unknown = await import(pathToFileURL(ENTRY).href);
  const plugin = isRecord(mod) ? mod['default'] : undefined;
  if (!isPlugin(plugin)) throw new Error('example plugin has no default export');
  await registry.use(plugin, { readFile: () => Promise.resolve(new Uint8Array()), writeFile: () => Promise.resolve() }, { origin: ENTRY });
  return {
    workspace: new Workspace(root),
    jobs: new JobManager(join(root, 'jobs'), telemetry),
    telemetry,
    isolation: 'container',
    encodePng,
    withEnvironment: (_dir, _project, fn) =>
      fn({
        registry,
        assets: { get: () => undefined, bytes: () => Promise.reject(new Error('x')), videoFrame: () => Promise.reject(new Error('x')), all: () => [] },
        fonts: { all: () => [], has: () => true, fallbacks: () => [] },
        cache: createCache(new MemoryStore()),
        telemetry,
        composite: (r) => ({ width: r.width, height: r.height, data: new Uint8Array(r.width * r.height * 4) }),
        accumulate: (i) => i[0] ?? { width: 1, height: 1, data: new Uint8Array(4) },
        versions: {},
        trusted: false,
        platform: { os: 'linux' },
      }),
  };
}

describe('MCP: Agent Tools aus Plugins (21.1)', () => {
  it('listet plugin_hello_greet für das geöffnete Projekt und ruft es mit Standard-projectId auf', async () => {
    const s = await services();
    const created = await invokeOperation(OPERATIONS, 'project.create', { name: 'Mcp plugins', project: { schemaVersion: '1.0.0', compositions: [{ id: 'main', width: 8, height: 8, fps: 10, duration: 5, nodes: [] }] } }, { services: s, via: 'test' });
    if (!created.ok || !isRecord(created.result) || typeof created.result['projectId'] !== 'string') throw new Error('project.create failed');
    const server = createMcpServer(s, { projectId: created.result['projectId'] });
    const [a, b] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: 'test', version: '1.0.0' });
    await Promise.all([server.connect(a), client.connect(b)]);
    const tools = await client.listTools();
    const tool = tools.tools.find((t) => t.name === 'plugin_hello_greet');
    expect(tool?.title).toBe('plugin.hello.greet');
    expect(tool?.inputSchema.required).toEqual(['name']);
    const r = await client.callTool({ name: 'plugin_hello_greet', arguments: { name: 'Mcp' } });
    const content = Array.isArray(r.content) ? r.content : [];
    expect(content).toEqual([{ type: 'text', text: JSON.stringify({ greeting: 'Hello, Mcp!' }, null, 2) }]);
    await client.close();
  });

  it('ohne geöffnetes Projekt keine Plugin-Tools', async () => {
    const server = createMcpServer(await services());
    const [a, b] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: 'test', version: '1.0.0' });
    await Promise.all([server.connect(a), client.connect(b)]);
    expect((await client.listTools()).tools.some((t) => t.name.startsWith('plugin_'))).toBe(false);
    await client.close();
  });
});
