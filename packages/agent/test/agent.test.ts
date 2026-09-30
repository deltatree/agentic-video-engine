import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { OPERATIONS, startAgentServer, type AgentServer, type AgentServices } from '@agentic-video/agent';
import { testServices } from './helpers.js';

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
  it('listet alle 30 Operationen mit Schemas', async () => {
    const res = await fetch(`${server.url}/v1/operations`, { headers: { authorization: `Bearer ${TOKEN}` } });
    const json = (await res.json()) as { operations: { name: string; input: unknown; output: unknown; example: unknown }[] };
    const names = json.operations.map((o) => o.name);
    expect(names).toHaveLength(30);
    for (const expected of ['capabilities.get', 'schema.get', 'project.open', 'project.import', 'frame.renderMany', 'subtitles.transcribe', 'project.create', 'project.inspect', 'composition.create', 'composition.get', 'composition.validate', 'composition.patch', 'asset.import', 'asset.inspect', 'frame.render', 'frame.inspect', 'preview.render', 'preview.contactSheet', 'video.render', 'render.status', 'render.cancel', 'diagnostics.get', 'fonts.list', 'templates.list', 'templates.inspect', 'scene.describe', 'scene.tree', 'timeline.inspect', 'benchmark.run']) {
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
