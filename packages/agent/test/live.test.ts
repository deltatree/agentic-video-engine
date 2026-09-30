/**
 * Story 20.1/20.5/20.8: Live-Ereignisse mit Projektrevision, transiente Vorschau-Patches in
 * `frame.render` und die Job-Liste von `render.status`.
 */
import { cpSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { isRecord } from '@agentic-video/core';
import { OPERATIONS, RevisionWatcher, invokeOperation, revisionOf, sseMessage, startAgentServer, type AgentServer, type AgentServices, type InvocationResult } from '@agentic-video/agent';
import { smallProject, testServices } from './helpers.js';

const RECT = { id: 'box', type: 'rect', x: 0, y: 0, width: 10, height: 10, fill: '#FF0000' };

function newServices(): AgentServices {
  return testServices(mkdtempSync(join(tmpdir(), 'ov-live-')));
}

async function run(services: AgentServices, op: string, input: unknown): Promise<InvocationResult> {
  return invokeOperation(OPERATIONS, op, input, { services, via: 'test' });
}

async function ok(services: AgentServices, op: string, input: unknown): Promise<Record<string, unknown>> {
  const r = await run(services, op, input);
  if (!r.ok) throw new Error(`${op} failed: ${r.error.code} ${r.error.problem}`);
  if (!isRecord(r.result)) throw new Error(`${op} returned no object`);
  return r.result;
}

/** Objekte einer Liste (andere Einträge fallen weg). */
function objects(value: unknown): Record<string, unknown>[] {
  return Array.isArray(value) ? value.filter(isRecord) : [];
}

/** Feld eines Objekts als Text. */
function field(value: unknown, key: string): string {
  return isRecord(value) ? String(value[key]) : '';
}

describe('Story 20.5: frame.render mit transienten Patches', () => {
  it('rendert den geänderten Stand, speichert ihn aber nie', async () => {
    const services = newServices();
    const id = String((await ok(services, 'project.create', { name: 'Preview', project: smallProject([RECT]) }))['projectId']);
    const file = join(services.workspace.projectDir(id), 'project.json');
    const before = readFileSync(file, 'utf8');
    const plain = await ok(services, 'frame.render', { projectId: id, frame: 0, inline: false });
    const moved = await ok(services, 'frame.render', { projectId: id, frame: 0, inline: false, patches: [{ op: 'setProperty', nodeId: 'box', property: 'x', value: 30 }] });
    expect(moved['key']).not.toBe(plain['key']);
    expect(field(moved['image'], 'file')).toMatch(/main-0-preview\.png$/u);
    expect(readFileSync(file, 'utf8')).toBe(before);
    // Ohne Patches kommt wieder der gespeicherte Stand.
    expect((await ok(services, 'frame.render', { projectId: id, frame: 0, inline: false }))['key']).toBe(plain['key']);
  });

  it('meldet abgelehnte Vorschau-Patches mit OV_PREVIEW_PATCH', async () => {
    const services = newServices();
    const id = String((await ok(services, 'project.create', { name: 'Preview', project: smallProject([RECT]) }))['projectId']);
    const r = await run(services, 'frame.render', { projectId: id, frame: 0, patches: [{ op: 'setProperty', nodeId: 'nope', property: 'x', value: 1 }] });
    expect(r.ok ? undefined : r.error.code).toBe('OV_PREVIEW_PATCH');
    const bad = await run(services, 'frame.render', { projectId: id, frame: 0, patches: [{ op: 'explode' }] });
    expect(bad.ok).toBe(false);
  });
});

describe('Story 20.8: render.status ohne jobId', () => {
  it('listet die Jobs eines Projekts, neueste zuerst', async () => {
    const services = newServices();
    const a = String((await ok(services, 'project.create', { name: 'A', project: smallProject([RECT]) }))['projectId']);
    const b = String((await ok(services, 'project.create', { name: 'B', project: smallProject([RECT]) }))['projectId']);
    const first = String((await ok(services, 'preview.render', { projectId: a, scale: 0.5 }))['jobId']);
    await ok(services, 'preview.render', { projectId: b, scale: 0.5 });
    const listed = await ok(services, 'render.status', { projectId: a });
    const jobs = objects(listed['jobs']);
    expect(jobs.map((j) => j['id'])).toEqual([first]);
    expect(jobs[0]?.['projectId']).toBe(a);
    expect(objects((await ok(services, 'render.status', {}))['jobs']).length).toBe(2);
  });
});

describe('Story 20.1: Revisionen und Server-Sent Events', () => {
  const TOKEN = 'live-token-for-tests';
  let services: AgentServices;
  let server: AgentServer;
  let projectId: string;

  beforeAll(async () => {
    services = newServices();
    projectId = String((await ok(services, 'project.create', { name: 'Live', project: smallProject([RECT]) }))['projectId']);
    server = await startAgentServer({ services, port: 0, token: TOKEN });
  });

  afterAll(async () => {
    await server.close();
  });

  it('sseMessage formatiert Ereignisse', () => {
    expect(sseMessage('revision', { revision: 'abc' })).toBe('event: revision\ndata: {"revision":"abc"}\n\n');
  });

  it('verlangt das Token und kennt nur vorhandene Projekte', async () => {
    expect((await fetch(`${server.url}/v1/events?projectId=${projectId}`)).status).toBe(401);
    const unknown = await fetch(`${server.url}/v1/events?projectId=missing`, { headers: { authorization: `Bearer ${TOKEN}` } });
    expect(unknown.status).toBe(404);
  });

  it('sendet die Revision beim Verbinden und nach jeder Fremdänderung; ETag ist dieselbe Revision', async () => {
    const file = join(services.workspace.projectDir(projectId), 'project.json');
    const controller = new AbortController();
    const response = await fetch(`${server.url}/v1/events?projectId=${projectId}`, { headers: { authorization: `Bearer ${TOKEN}` }, signal: controller.signal });
    expect(response.headers.get('content-type')).toContain('text/event-stream');
    const body = response.body;
    if (body === null) throw new Error('no body');
    const reader = body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    const nextRevision = async (): Promise<string> => {
      for (;;) {
        const match = /event: revision\ndata: (.*)\n\n/u.exec(buffer);
        if (match !== null) {
          buffer = buffer.slice(match.index + match[0].length);
          const data: unknown = JSON.parse(match[1] ?? '{}');
          return field(data, 'revision');
        }
        const chunk = await reader.read();
        if (chunk.done) throw new Error('stream ended');
        buffer += decoder.decode(chunk.value, { stream: true });
      }
    };
    try {
      const initial = await nextRevision();
      expect(initial).toBe(revisionOf(readFileSync(file)));
      const etag = (await fetch(`${server.url}/v1/files/${projectId}/project.json`, { headers: { authorization: `Bearer ${TOKEN}` } })).headers.get('etag');
      expect(etag).toBe(`"${initial}"`);
      // Fremdänderung (z. B. ein Editor) direkt auf der Platte.
      const changed = smallProject([{ ...RECT, x: 5 }]);
      writeFileSync(file, `${JSON.stringify(changed, null, 2)}\n`);
      const next = await nextRevision();
      expect(next).not.toBe(initial);
      expect(next).toBe(revisionOf(readFileSync(file)));
      // Änderung über die API erzeugt ebenfalls ein Ereignis.
      await ok(services, 'composition.patch', { projectId, patches: [{ op: 'setProperty', nodeId: 'box', property: 'x', value: 7 }] });
      expect(await nextRevision()).toBe(revisionOf(readFileSync(file)));
    } finally {
      controller.abort();
    }
  });

  it('meldet gleiches Neuschreiben nicht als neue Revision', async () => {
    const watcher = new RevisionWatcher(10);
    const dir = services.workspace.projectDir(projectId);
    const seen: string[] = [];
    const stop = await watcher.subscribe(dir, (r) => seen.push(r));
    try {
      const file = join(dir, 'project.json');
      writeFileSync(file, readFileSync(file));
      await new Promise((r) => setTimeout(r, 150));
      expect(seen).toEqual([]);
      writeFileSync(file, `${JSON.stringify(smallProject([{ ...RECT, x: 9 }]))}\n`);
      await expect.poll(() => seen.length, { timeout: 5000 }).toBe(1);
    } finally {
      stop();
      watcher.closeAll();
    }
  });

  it('schließt beim Abmelden nie den Watcher eines neueren Abonnements (Review m1)', async () => {
    const watcher = new RevisionWatcher(10);
    const dir = services.workspace.projectDir(projectId);
    const stopOld = await watcher.subscribe(dir, () => undefined);
    // Fehler/Neustart: der alte Eintrag verschwindet, ein neuer entsteht.
    watcher.closeAll();
    const seen: string[] = [];
    const stopNew = await watcher.subscribe(dir, (r) => seen.push(r));
    try {
      stopOld();
      writeFileSync(join(dir, 'project.json'), `${JSON.stringify(smallProject([{ ...RECT, x: 11 }]))}\n`);
      await expect.poll(() => seen.length, { timeout: 5000 }).toBe(1);
    } finally {
      stopNew();
      watcher.closeAll();
    }
  });

  it('begrenzt gleichzeitige Streams und gibt Plätze beim Trennen frei (Review m2, m3)', async () => {
    const local = await startAgentServer({ services, port: 0, token: TOKEN, maxEventStreams: 1 });
    const headers = { authorization: `Bearer ${TOKEN}` };
    try {
      const first = new AbortController();
      const open = await fetch(`${local.url}/v1/events?projectId=${projectId}`, { headers, signal: first.signal });
      expect(open.status).toBe(200);
      const second = await fetch(`${local.url}/v1/events?projectId=${projectId}`, { headers });
      expect(second.status).toBe(503);
      const body: unknown = await second.json();
      expect(isRecord(body) ? field(body['error'], 'code') : '').toBe('OV_API_BUSY');
      first.abort();
      // Nach dem Trennen ist der Platz wieder frei (close-Listener räumt auf).
      await expect
        .poll(
          async () => {
            const c = new AbortController();
            const r = await fetch(`${local.url}/v1/events?projectId=${projectId}`, { headers, signal: c.signal });
            c.abort();
            return r.status;
          },
          { timeout: 5000 },
        )
        .toBe(200);
    } finally {
      await local.close();
    }
  });

  it('meldet das Ende der Beobachtung, wenn der Ordner ersetzt oder gelöscht wird (Review Q8)', async () => {
    const watcher = new RevisionWatcher(10);
    const dir = mkdtempSync(join(tmpdir(), 'ov-live-replace-'));
    writeFileSync(join(dir, 'project.json'), '{}\n');
    const seen: string[] = [];
    let ended = 0;
    await watcher.subscribe(dir, (r) => seen.push(r), () => ended++);
    try {
      // Editor/Git ersetzen den Ordner: neuer Inode am selben Pfad; der alte Watcher hört nie wieder etwas.
      const fresh = `${dir}-new`;
      mkdirSync(fresh);
      writeFileSync(join(fresh, 'project.json'), '{"x":1}\n');
      rmSync(dir, { recursive: true });
      renameSync(fresh, dir);
      await expect.poll(() => ended, { timeout: 5000 }).toBe(1);
      expect(watcher.current(dir)).toBeUndefined();
      // Neues Abonnement beobachtet den neuen Ordner.
      const again: string[] = [];
      let endedAgain = 0;
      const stop = await watcher.subscribe(dir, (r) => again.push(r), () => endedAgain++);
      writeFileSync(join(dir, 'project.json'), '{"x":2}\n');
      await expect.poll(() => again.length, { timeout: 5000 }).toBe(1);
      // Gelöscht: ebenfalls Ende.
      rmSync(dir, { recursive: true });
      await expect.poll(() => endedAgain, { timeout: 5000 }).toBe(1);
      stop();
      expect(ended).toBe(1);
    } finally {
      watcher.closeAll();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('beendet den SSE-Strom, wenn der Projektordner ersetzt wird, damit der Client neu verbindet', async () => {
    const replaced = String((await ok(services, 'project.create', { name: 'Replaced', project: smallProject([RECT]) }))['projectId']);
    const dir = services.workspace.projectDir(replaced);
    const response = await fetch(`${server.url}/v1/events?projectId=${replaced}`, { headers: { authorization: `Bearer ${TOKEN}` } });
    expect(response.status).toBe(200);
    const reader = response.body?.getReader();
    if (reader === undefined) throw new Error('no body');
    // Erste Nachricht (Anfangsstand) lesen, damit der Strom sicher läuft.
    await reader.read();
    const fresh = `${dir}-new`;
    cpSync(dir, fresh, { recursive: true });
    writeFileSync(join(fresh, 'project.json'), `${JSON.stringify(smallProject([{ ...RECT, x: 3 }]))}\n`);
    rmSync(dir, { recursive: true });
    renameSync(fresh, dir);
    const deadline = Date.now() + 5000;
    for (;;) {
      const chunk = await Promise.race([reader.read(), new Promise<undefined>((r) => setTimeout(r, Math.max(0, deadline - Date.now())))]);
      if (chunk === undefined) throw new Error('stream still open after the project folder was replaced');
      if (chunk.done) break;
    }
    // Neu verbinden: der Anfangsstand ist die Revision des neuen Ordners.
    const again = await fetch(`${server.url}/v1/events?projectId=${replaced}`, { headers: { authorization: `Bearer ${TOKEN}` } });
    const againReader = again.body?.getReader();
    if (againReader === undefined) throw new Error('no body');
    const text = new TextDecoder().decode((await againReader.read()).value);
    expect(text).toContain(revisionOf(readFileSync(join(dir, 'project.json'))));
    await againReader.cancel();
  });

  it('close() beendet offene Streams', async () => {
    const local = await startAgentServer({ services, port: 0, token: TOKEN });
    const response = await fetch(`${local.url}/v1/events?projectId=${projectId}`, { headers: { authorization: `Bearer ${TOKEN}` } });
    expect(response.status).toBe(200);
    await local.close();
    const reader = response.body?.getReader();
    // Nach dem Schließen endet der Stream (ggf. nach der ersten Nachricht).
    for (let i = 0; i < 5; i++) if ((await reader?.read())?.done === true) return;
    throw new Error('stream still open');
  });
});
