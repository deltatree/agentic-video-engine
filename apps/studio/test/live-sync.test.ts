/**
 * Live-Sync des Studio-Stores mit echtem SSE-Strom (ADR 0025): `Studio` spricht über `fetch` mit einem
 * echten Agent-Server und liest `/v1/events` wirklich mit. Geprüft wird, dass verspätete Ereignisse der
 * eigenen Speicherungen (auch der Anfangsstand beim Verbinden) weder Undo verwerfen noch eine
 * Neulade-Schleife auslösen, dass echte Fremdänderungen dagegen neu laden, und dass `dispose` den Strom
 * und alle Wiederverbindungen beendet.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startAgentServer, type AgentServer } from '@agentic-video/agent';
import { createLocalServices, type LocalServices } from '@agentic-video/cli';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { Studio } from '../src/store.js';

const PROJECT = {
  schemaVersion: '1.0.0',
  metadata: { title: 'Live sync test' },
  compositions: [{ id: 'main', width: 160, height: 90, fps: 10, duration: 10, background: '#101418', nodes: [{ id: 'box', type: 'rect', x: 20, y: 20, width: 50, height: 40, fill: '#E5484D' }] }],
};

let workspace: string;
let services: LocalServices;
let server: AgentServer;
let studio: Studio | undefined;
let count = 0;
let projectId: string;
/** Zähler der `composition.get`-Aufrufe (jedes Neuladen ruft es einmal). */
let reloads = 0;
/** Offene Ereignis-Ströme (Anfragen an `/v1/events`). */
let eventRequests = 0;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

async function api(operation: string, input: Record<string, unknown>): Promise<Record<string, unknown>> {
  const r = await fetch(`${server.url}/v1/${operation}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(input) });
  const body: unknown = await r.json();
  if (!isRecord(body)) throw new Error(`unexpected response for ${operation}`);
  return body;
}

async function boxX(): Promise<unknown> {
  const comp = await api('composition.get', { projectId });
  const nodes = comp['nodes'];
  return Array.isArray(nodes) ? nodes.find((n: unknown) => isRecord(n) && n['id'] === 'box')?.['x'] : undefined;
}

async function waitFor(condition: () => boolean, timeoutMs = 10_000): Promise<void> {
  const until = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() > until) throw new Error('timeout');
    await new Promise((r) => setTimeout(r, 10));
  }
}

/** Wartet, bis der Store ruht und `ms` lang nicht mehr neu geladen hat. */
async function settle(ms = 400): Promise<void> {
  await waitFor(() => !s().getState().busy);
  let before = -1;
  while (before !== reloads) {
    before = reloads;
    await new Promise((r) => setTimeout(r, ms));
    await waitFor(() => !s().getState().busy);
  }
}

function s(): Studio {
  if (studio === undefined) throw new Error('studio not loaded');
  return studio;
}

beforeAll(async () => {
  workspace = mkdtempSync(join(tmpdir(), 'ov-studio-live-'));
  services = await createLocalServices({ workspaceDir: workspace, isolation: 'trusted' });
  server = await startAgentServer({ services, port: 0 });
  const realFetch = globalThis.fetch;
  const storage = new Map<string, string>();
  // Relative URLs (/v1/…) wie im Browser an den Test-Server – auch der SSE-Strom, echt und ungedrosselt.
  vi.stubGlobal('fetch', (input: string | URL | Request, init?: RequestInit) => {
    if (typeof input === 'string' && input.startsWith('/v1/events')) eventRequests++;
    if (typeof input === 'string' && input === '/v1/composition.get') reloads++;
    return realFetch(typeof input === 'string' && input.startsWith('/') ? `${server.url}${input}` : input, init);
  });
  vi.stubGlobal('window', { location: { hash: '', search: '', pathname: '/' }, history: { replaceState: () => undefined }, devicePixelRatio: 1 });
  vi.stubGlobal('sessionStorage', { getItem: (k: string) => storage.get(k) ?? null, setItem: (k: string, v: string) => storage.set(k, v) });
}, 120_000);

afterAll(async () => {
  vi.unstubAllGlobals();
  await server.close();
  await services.dispose();
  rmSync(workspace, { recursive: true, force: true });
});

beforeEach(async () => {
  const created = await api('project.create', { name: `live ${String(++count)}`, project: PROJECT });
  projectId = String(created['projectId']);
  reloads = 0;
  eventRequests = 0;
  studio = new Studio(projectId);
  await studio.load();
});

afterEach(() => {
  studio?.dispose();
  studio = undefined;
});

describe('Studio-Live-Sync mit echtem SSE', () => {
  it('ein Patch direkt nach dem Laden bleibt rückgängig machbar (Anfangsstand des Stroms kommt während der Speicherung)', async () => {
    // Kein Warten auf „live“: Der Anfangsstand des Stroms (alte Revision) trifft während des Patches ein.
    expect(await s().patch([{ op: 'setProperty', nodeId: 'box', property: 'x', value: 99 }])).toBe(true);
    await settle();
    expect(s().getState().live).toBe('live');
    expect(s().getState().canUndo).toBe(true);
    expect(s().getState().message).toBeUndefined();
    await s().undo();
    expect(await boxX()).toBe(20);
    await settle();
    expect(s().getState().canRedo).toBe(true);
    await s().redo();
    expect(await boxX()).toBe(99);
  });

  it('Patch, Undo und Redo in schneller Folge: verspätete eigene Ereignisse lösen kein Neuladen aus', async () => {
    await waitFor(() => s().getState().live === 'live');
    for (let i = 0; i < 3; i++) {
      expect(await s().patch([{ op: 'setProperty', nodeId: 'box', property: 'x', value: 30 + i }])).toBe(true);
      await s().undo();
      await s().redo();
    }
    await settle();
    expect(await boxX()).toBe(32);
    expect(s().getState().canUndo).toBe(true);
    expect(s().getState().message).toBeUndefined();
  });

  it('eine veraltete Revision (z. B. das Echo einer früheren eigenen Speicherung) verwirft nichts und lädt nicht endlos', async () => {
    await waitFor(() => s().getState().live === 'live');
    expect(await s().patch([{ op: 'setProperty', nodeId: 'box', property: 'x', value: 70 }])).toBe(true);
    await settle();
    // Das Ereignis der ersten eigenen Speicherung kommt verspätet, während der nächste Schreibvorgang läuft.
    const undo = s().undo();
    s().onRemoteRevision('0123456789abcdef');
    await undo;
    await settle();
    const after = reloads;
    await new Promise((r) => setTimeout(r, 500));
    expect(reloads).toBe(after);
    expect(s().getState().canRedo).toBe(true);
    expect(s().getState().message).toBeUndefined();
    // Ohne laufenden Schreibvorgang: dasselbe.
    s().onRemoteRevision('fedcba9876543210');
    await settle();
    expect(s().getState().canRedo).toBe(true);
    expect(s().getState().message).toBeUndefined();
  });

  it('eine echte Fremdänderung lädt neu und verwirft Undo', async () => {
    await waitFor(() => s().getState().live === 'live');
    expect(await s().patch([{ op: 'setProperty', nodeId: 'box', property: 'x', value: 50 }])).toBe(true);
    await settle();
    // Ein Agent ändert das Projekt am Studio vorbei.
    await api('composition.patch', { projectId, patches: [{ op: 'setProperty', nodeId: 'box', property: 'y', value: 77 }] });
    await waitFor(() => s().getState().message?.text.includes('changed outside the Studio') === true);
    await settle();
    expect(s().getState().canUndo).toBe(false);
    const box = s().getState().comp?.['nodes'];
    expect(Array.isArray(box) ? box.find((n: unknown) => isRecord(n) && n['id'] === 'box')?.['y'] : undefined).toBe(77);
  });

  it('dispose beendet den Strom; danach verbindet sich nichts mehr neu', async () => {
    await waitFor(() => s().getState().live === 'live');
    const before = eventRequests;
    s().dispose();
    await new Promise((r) => setTimeout(r, 1500));
    expect(eventRequests).toBe(before);
  });
});
