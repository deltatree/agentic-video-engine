import { describe, expect, it } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { MemoryStore, createCache } from '@agentic-video/cache';
import { Registry } from '@agentic-video/core';
import { encodePng } from '@agentic-video/png';
import { createTelemetry } from '@agentic-video/telemetry';
import { JobManager, Workspace, type AgentServices } from '@agentic-video/agent';
import { createMcpServer, toolName } from '@agentic-video/mcp';

function services(): AgentServices {
  const root = mkdtempSync(join(tmpdir(), 'ov-mcp-'));
  const telemetry = createTelemetry({ serviceName: 'mcp-test', exporter: 'memory', logSink: () => undefined });
  const registry = new Registry();
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
        composite: (r) => ({ width: r.width, height: r.height, data: new Uint8Array(r.width * r.height * 4).fill(255) }),
        accumulate: (i) => i[0] ?? { width: 1, height: 1, data: new Uint8Array(4) },
        versions: {},
        trusted: false,
        platform: { os: 'linux' },
      }),
  };
}

describe('MCP-Server (FR-22)', () => {
  it('listet alle Operationen als Tools und ruft sie auf', async () => {
    const server = createMcpServer(services());
    const [a, b] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: 'test', version: '1.0.0' });
    await Promise.all([server.connect(a), client.connect(b)]);
    const tools = await client.listTools();
    expect(tools.tools).toHaveLength(24);
    expect(tools.tools.map((t) => t.name)).toContain('composition_validate');
    expect(tools.tools.every((t) => /^[A-Za-z0-9_-]{1,64}$/u.test(t.name))).toBe(true);
    const created = await client.callTool({ name: toolName('project.create'), arguments: { name: 'Mcp', project: { schemaVersion: '1.0.0', compositions: [{ id: 'main', width: 8, height: 8, fps: 10, duration: 5, nodes: [] }] } } });
    const text = (created.content as { type: string; text: string }[])[0]?.text ?? '';
    const projectId = (JSON.parse(text) as { projectId: string }).projectId;
    const validated = await client.callTool({ name: 'composition_validate', arguments: { projectId } });
    expect(validated.isError).not.toBe(true);
    const frame = await client.callTool({ name: 'frame_render', arguments: { projectId, frame: 0 } });
    const content = frame.content as { type: string; mimeType?: string }[];
    expect(content[0]?.type).toBe('image');
    expect(content[0]?.mimeType).toBe('image/png');
    const failed = await client.callTool({ name: 'composition_get', arguments: { projectId: 'missing' } });
    expect(failed.isError).toBe(true);
    await client.close();
  });
});
