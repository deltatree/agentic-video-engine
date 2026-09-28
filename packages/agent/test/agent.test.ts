import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MemoryStore, createCache } from '@agentic-video/cache';
import { Registry, getNumber, parseColor, type RenderBackend, type RgbaImage } from '@agentic-video/core';
import { encodePng } from '@agentic-video/png';
import { createTelemetry } from '@agentic-video/telemetry';
import type { RenderEnvironment } from '@agentic-video/render';
import { JobManager, OPERATIONS, Workspace, startAgentServer, type AgentServer, type AgentServices } from '@agentic-video/agent';

function rectBackend(): RenderBackend {
  return {
    id: 'skia',
    nodeTypes: ['rect', 'text'],
    capabilities: [],
    fusable: true,
    versions: () => ({ test: '1' }),
    check: () => ({ supported: true, diagnostics: [] }),
    renderLayer: (req) => {
      const data = new Uint8Array(req.width * req.height * 4);
      for (const n of req.nodes) {
        if (n.type !== 'rect') continue;
        const c = parseColor(typeof n.props['fill'] === 'string' ? n.props['fill'] : '#FFFFFF');
        for (let y = Math.round(getNumber(n, 'y', 0) * req.scale); y < Math.min(req.height, Math.round((getNumber(n, 'y', 0) + getNumber(n, 'height', 0)) * req.scale)); y++)
          for (let x = Math.round(getNumber(n, 'x', 0) * req.scale); x < Math.min(req.width, Math.round((getNumber(n, 'x', 0) + getNumber(n, 'width', 0)) * req.scale)); x++) {
            const o = (y * req.width + x) * 4;
            data[o] = Math.round(c.r * 255);
            data[o + 1] = Math.round(c.g * 255);
            data[o + 2] = Math.round(c.b * 255);
            data[o + 3] = 255;
          }
      }
      return Promise.resolve({ width: req.width, height: req.height, data });
    },
    dispose: () => Promise.resolve(),
  };
}

function testServices(root: string): AgentServices {
  const telemetry = createTelemetry({ serviceName: 'agent-test', exporter: 'memory', logSink: () => undefined });
  const cache = createCache(new MemoryStore());
  const registry = new Registry();
  registry.registerBackend(rectBackend());
  const env: RenderEnvironment = {
    registry,
    assets: { get: () => undefined, bytes: () => Promise.reject(new Error('none')), videoFrame: () => Promise.reject(new Error('none')), all: () => [] },
    fonts: { all: () => [], has: (f) => f === 'Inter', fallbacks: () => [] },
    cache,
    telemetry,
    composite: (req) => {
      const img = req.layers.find((l): l is { kind: 'image'; image: RgbaImage } => l.kind === 'image');
      return img?.image ?? { width: req.width, height: req.height, data: new Uint8Array(req.width * req.height * 4) };
    },
    accumulate: (images) => images[0] ?? { width: 1, height: 1, data: new Uint8Array(4) },
    overlays: {
      debugOverlay: (_s, _b, _o, size) => ({ width: size.width, height: size.height, data: new Uint8Array(size.width * size.height * 4) }),
      contactSheet: (frames) => frames[0]?.image ?? { width: 1, height: 1, data: new Uint8Array(4) },
    },
    media: {
      createEncoder: (o) => {
        let frames = 0;
        return Promise.resolve({
          write: () => {
            frames++;
            return Promise.resolve();
          },
          finish: async () => {
            await writeFile(o.outPath, new Uint8Array([0]));
            return { outputs: [o.outPath], frames, encoder: 'test', args: [] };
          },
          abort: () => Promise.resolve(),
        });
      },
      info: () => Promise.resolve({ version: 'test', license: 'LGPL-2.1-or-later', configuration: '', codecLicenses: {} }),
    },
    versions: { 'backend:skia': '1' },
    trusted: false,
    platform: { os: 'linux' },
  };
  return {
    workspace: new Workspace(root),
    jobs: new JobManager(join(root, 'jobs'), telemetry, 2),
    telemetry,
    isolation: 'container',
    environment: () => Promise.resolve(env),
    encodePng: (image) => encodePng(image),
  };
}

let server: AgentServer;
let services: AgentServices;
const TOKEN = 'secret-token';

async function call(op: string, body: unknown, token: string | null = TOKEN): Promise<{ status: number; json: Record<string, unknown> }> {
  const res = await fetch(`${server.url}/v1/${op}`, { method: 'POST', headers: { 'content-type': 'application/json', ...(token !== null ? { authorization: `Bearer ${token}` } : {}) }, body: JSON.stringify(body) });
  return { status: res.status, json: (await res.json()) as Record<string, unknown> };
}

beforeAll(async () => {
  services = testServices(mkdtempSync(join(tmpdir(), 'ov-agent-')));
  server = await startAgentServer({ services, port: 0, token: TOKEN });
});

afterAll(async () => {
  await server.close();
});

describe('Agent API (FR-21, FR-23)', () => {
  it('listet alle 23 Operationen mit Schemas', async () => {
    const res = await fetch(`${server.url}/v1/operations`, { headers: { authorization: `Bearer ${TOKEN}` } });
    const json = (await res.json()) as { operations: { name: string; input: unknown; output: unknown; example: unknown }[] };
    const names = json.operations.map((o) => o.name);
    expect(names).toHaveLength(24);
    for (const expected of ['project.create', 'project.inspect', 'composition.create', 'composition.get', 'composition.validate', 'composition.patch', 'asset.import', 'asset.inspect', 'frame.render', 'frame.inspect', 'preview.render', 'preview.contactSheet', 'video.render', 'render.status', 'render.cancel', 'diagnostics.get', 'fonts.list', 'templates.list', 'templates.inspect', 'scene.describe', 'scene.tree', 'timeline.inspect', 'benchmark.run']) {
      expect(names).toContain(expected);
    }
    expect(json.operations.every((o) => o.input !== undefined && o.output !== undefined && o.example !== undefined)).toBe(true);
    expect([...OPERATIONS.keys()]).toEqual(names);
  });

  it('verlangt das Token und prüft Eingaben', async () => {
    expect((await call('project.inspect', {}, null)).status).toBe(401);
    expect((await call('project.inspect', {}, 'wrong')).status).toBe(401);
    const bad = await call('frame.render', { projectId: 'x' });
    expect(bad.status).toBe(400);
    expect((bad.json['error'] as { code: string }).code).toBe('OV_API_INPUT');
    expect((await call('nope.op', {})).status).toBe(404);
  });

  it('führt den Agenten-Kreislauf aus: anlegen, prüfen, rendern, patchen, erneut rendern, Video', async () => {
    const created = await call('project.create', {
      name: 'Demo',
      project: {
        schemaVersion: '1.0.0',
        compositions: [{ id: 'main', width: 64, height: 36, fps: 10, duration: 20, nodes: [{ id: 'box', type: 'rect', width: 10, height: 10, fill: '#FF0000' }, { id: 'headline', type: 'text', text: 'Hi', fontSize: 92, y: 760 }] }],
      },
    });
    expect(created.status).toBe(200);
    const projectId = String(created.json['projectId']);
    const valid = await call('composition.validate', { projectId });
    expect(valid.json['ok']).toBe(true);
    const frame = await call('frame.render', { projectId, frame: '1s', scale: 1 });
    expect(frame.status).toBe(200);
    const image = frame.json['image'] as { url: string; base64: string; width: number };
    expect(image.width).toBe(64);
    expect(Buffer.from(image.base64, 'base64').subarray(1, 4).toString()).toBe('PNG');
    const file = await fetch(`${server.url}${image.url}`, { headers: { authorization: `Bearer ${TOKEN}` } });
    expect(file.headers.get('content-type')).toBe('image/png');
    const inspect = await call('frame.inspect', { projectId, frame: 0 });
    expect((inspect.json['diagnostics'] as { code: string }[]).some((d) => d.code === 'OV_OUT_OF_FRAME' || d.code === 'OV_OVERFLOW')).toBe(true);
    const patched = await call('composition.patch', { projectId, patches: [{ op: 'setProperty', nodeId: 'headline', property: 'fontSize', value: 82 }, { op: 'setProperty', nodeId: 'headline', property: 'y', value: 720 }] });
    expect(patched.json['ok']).toBe(true);
    const get = await call('composition.get', { projectId });
    expect(JSON.stringify(get.json)).toContain('"fontSize":82');
    const invalid = await call('composition.patch', { projectId, patches: [{ op: 'setProperty', nodeId: 'headline', property: 'fontSize', value: 'big' }] });
    expect(invalid.json['ok']).toBe(false);
    const timeline = await call('timeline.inspect', { projectId });
    expect(timeline.json['durationFrames']).toBe(20);
    const described = await call('scene.describe', { projectId, frame: 0 });
    expect(String(described.json['description'])).toContain('rect "box"');
    const job = await call('video.render', { projectId, profile: { format: 'mp4' } });
    const jobId = String(job.json['jobId']);
    const done = await services.jobs.wait(jobId);
    expect(done.state).toBe('succeeded');
    const status = await fetch(`${server.url}/v1/jobs/${jobId}`, { headers: { authorization: `Bearer ${TOKEN}` } });
    expect(((await status.json()) as { state: string }).state).toBe('succeeded');
  });

  it('verweigert HTML-Skripte außerhalb eines Containers (ADR 0008)', async () => {
    const created = await call('project.create', {
      name: 'Scripted',
      project: { schemaVersion: '1.0.0', compositions: [{ id: 'main', width: 64, height: 36, fps: 10, duration: 5, nodes: [{ id: 'h', type: 'html', width: 10, height: 10, html: '<script>alert(1)</script>' }] }] },
    });
    const r = await call('frame.render', { projectId: String(created.json['projectId']), frame: 0 });
    expect(r.status).toBe(403);
    expect((r.json['error'] as { code: string }).code).toBe('OV_SANDBOX_REQUIRED');
  });

  it('bricht Jobs ab', async () => {
    const created = await call('project.create', { name: 'Long', project: { schemaVersion: '1.0.0', compositions: [{ id: 'main', width: 32, height: 18, fps: 10, duration: 400, nodes: [{ id: 'b', type: 'rect', width: 4, height: 4, x: { $expr: 'frame % 20' } }] }] } });
    const job = await call('video.render', { projectId: String(created.json['projectId']), profile: { format: 'mp4' } });
    const jobId = String(job.json['jobId']);
    await call('render.cancel', { jobId });
    const end = await services.jobs.wait(jobId);
    expect(end.state).toBe('cancelled');
  });
});
