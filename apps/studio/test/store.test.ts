/**
 * Unit-Tests des Studio-Stores (Story 22.5, Audit P1-6) ohne Browser: `Studio` spricht über
 * `fetch` mit einem echten Agent-Server; die Browser-Globals (`window`, `sessionStorage`) sind
 * minimal ersetzt. Geprüft werden Laden, Auswahl, Patches mit Undo/Redo, Nudge, Zeitleiste und
 * Fehlerpfade – also die Logik, die die Playwright-Tests nur über die Oberfläche berühren.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startAgentServer, type AgentServer } from '@agentic-video/agent';
import { createLocalServices, type LocalServices } from '@agentic-video/cli';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { Studio, flattenTree } from '../src/store.js';

const PROJECT = {
  schemaVersion: '1.0.0',
  metadata: { title: 'Store test' },
  compositions: [
    {
      id: 'main',
      width: 320,
      height: 180,
      fps: 10,
      duration: 20,
      background: '#101418',
      nodes: [
        { id: 'box', type: 'rect', x: 20, y: 20, width: 50, height: 40, fill: '#E5484D' },
        { id: 'disc', type: 'ellipse', x: 150, y: 30, width: 40, height: 40, fill: '#3E63DD', timing: { from: 0, duration: 10 } },
      ],
    },
  ],
};

type Json = Record<string, unknown>;

let workspace: string;
let services: LocalServices;
let server: AgentServer;
let studio: Studio | undefined;
let count = 0;

async function api(operation: string, input: Json): Promise<Json> {
  const r = await fetch(`${server.url}/v1/${operation}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(input) });
  return (await r.json()) as Json;
}

async function serverNode(projectId: string, id: string): Promise<Json | undefined> {
  const comp = await api('composition.get', { projectId });
  const nodes = Array.isArray(comp['nodes']) ? (comp['nodes'] as Json[]) : [];
  return nodes.find((n) => n['id'] === id);
}

beforeAll(async () => {
  workspace = mkdtempSync(join(tmpdir(), 'ov-studio-store-'));
  services = await createLocalServices({ workspaceDir: workspace, isolation: 'trusted' });
  server = await startAgentServer({ services, port: 0 });
  const realFetch = globalThis.fetch;
  const storage = new Map<string, string>();
  // Der Store ruft relative URLs (/v1/…) wie im Browser; hier gehen sie an den Test-Server.
  // Live-Sync (SSE, /v1/events) prüfen die Playwright-Tests (20.1); hier bleibt der Strom still und
  // endet mit dem Abbruch, damit kein offener Client-Strom den Test-Prozess am Beenden hindert.
  vi.stubGlobal('fetch', (input: string | URL | Request, init?: RequestInit) => {
    if (typeof input === 'string' && input.startsWith('/v1/events')) {
      const signal = init?.signal;
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          signal?.addEventListener('abort', () => {
            controller.error(new Error('aborted'));
          });
        },
      });
      return Promise.resolve(new Response(body, { headers: { 'content-type': 'text/event-stream' } }));
    }
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

let projectId: string;

beforeEach(async () => {
  const created = await api('project.create', { name: `store ${String(++count)}`, project: PROJECT });
  projectId = String(created['projectId']);
  studio = new Studio(projectId);
  await studio.load();
});

afterEach(() => {
  studio?.dispose();
});

function s(): Studio {
  if (studio === undefined) throw new Error('studio not loaded');
  return studio;
}

describe('Studio-Store', () => {
  it('lädt Projekt, Composition, Zeitleiste, Szenenbaum und Frame', () => {
    const st = s().getState();
    expect(st.status).toBe('ready');
    expect(st.loadError).toBeUndefined();
    expect(st.kind).toBe('json');
    expect(st.timeline?.durationFrames).toBe(20);
    expect(s().durationFrames).toBe(20);
    expect(flattenTree(st.tree).map((n) => n.id)).toEqual(expect.arrayContaining(['box', 'disc']));
    expect(st.image?.src).toMatch(/^data:image\/png;base64,.{100}/u);
    expect(st.canUndo).toBe(false);
  });

  it('meldet ein unbekanntes Projekt als Ladefehler statt zu werfen', async () => {
    const broken = new Studio('does-not-exist');
    await broken.load();
    expect(broken.getState().status).toBe('error');
    expect(broken.getState().loadError).toMatch(/does-not-exist|not found|unknown/iu);
    broken.dispose();
  });

  it('Auswahl: ersetzen, umschalten, hinzufügen; Listener werden benachrichtigt', () => {
    const calls: number[] = [];
    const stop = s().subscribe(() => calls.push(1));
    s().select(['box']);
    expect(s().getState().selection).toEqual(['box']);
    s().select(['disc'], 'add');
    expect(s().getState().selection).toEqual(['box', 'disc']);
    s().select(['box'], 'toggle');
    expect(s().getState().selection).toEqual(['disc']);
    stop();
    expect(calls.length).toBeGreaterThanOrEqual(3);
  });

  it('Patch mit Undo und Redo ändert das Projekt auf dem Server', async () => {
    expect(await s().patch([{ op: 'setProperty', nodeId: 'box', property: 'x', value: 99 }])).toBe(true);
    expect((await serverNode(projectId, 'box'))?.['x']).toBe(99);
    expect(s().getState().canUndo).toBe(true);
    await s().undo();
    expect((await serverNode(projectId, 'box'))?.['x']).toBe(20);
    expect(s().getState().canRedo).toBe(true);
    await s().redo();
    expect((await serverNode(projectId, 'box'))?.['x']).toBe(99);
  });

  it('ein abgelehnter Patch ändert nichts und meldet einen Fehler', async () => {
    expect(await s().patch([{ op: 'setProperty', nodeId: 'nope', property: 'x', value: 1 }])).toBe(false);
    expect(s().getState().canUndo).toBe(false);
    expect(s().getState().message?.kind).toBe('error');
  });

  it('Nudge verschiebt die Auswahl relativ; aufeinanderfolgende Schritte rechnen auf dem neuesten Stand', async () => {
    s().select(['box', 'disc']);
    await Promise.all([s().nudge(5, 0), s().nudge(5, 2)]);
    expect((await serverNode(projectId, 'box'))?.['x']).toBe(30);
    expect((await serverNode(projectId, 'box'))?.['y']).toBe(22);
    expect((await serverNode(projectId, 'disc'))?.['x']).toBe(160);
  });

  it('Nudge-Zusammenfassung mit fester Uhr: Schritte im 1-s-Fenster ergeben einen Undo-Schritt, danach beginnt ein neuer', async () => {
    let clock = 10_000;
    const timed = new Studio(projectId, { now: () => clock });
    try {
      await timed.load();
      timed.select(['box']);
      // Unabhängig davon, wie lange der Server braucht: gemessen wird die Eingabe.
      const first = timed.nudge(1, 0);
      clock += 400;
      const second = timed.nudge(1, 0);
      clock += 600;
      const third = timed.nudge(1, 0);
      await Promise.all([first, second, third]);
      clock += 1001;
      await timed.nudge(1, 0);
      expect((await serverNode(projectId, 'box'))?.['x']).toBe(24);
      await timed.undo();
      expect((await serverNode(projectId, 'box'))?.['x']).toBe(23);
      await timed.undo();
      expect((await serverNode(projectId, 'box'))?.['x']).toBe(20);
      expect(timed.getState().canUndo).toBe(false);
    } finally {
      timed.dispose();
    }
  });

  it('Duplizieren und Löschen der Auswahl', async () => {
    s().select(['box']);
    await s().duplicate();
    const comp = await api('composition.get', { projectId });
    const ids = (comp['nodes'] as Json[]).map((n) => String(n['id']));
    expect(ids).toContain('box-copy');
    s().select(['box-copy']);
    await s().deleteSelection();
    expect(await serverNode(projectId, 'box-copy')).toBeUndefined();
  });

  it('Zeitleiste: seek begrenzt auf die Dauer, step und In/Out-Punkte', () => {
    s().seek(500);
    expect(s().getState().frame).toBe(19);
    s().seek(-3);
    expect(s().getState().frame).toBe(0);
    s().step(4);
    expect(s().getState().frame).toBe(4);
    s().setRange('in');
    s().seek(8);
    s().setRange('out');
    expect([s().getState().inPoint, s().getState().outPoint]).toEqual([4, 8]);
    s().setRange('clear');
    expect([s().getState().inPoint, s().getState().outPoint]).toEqual([undefined, undefined]);
  });

  it('saveCode lehnt ungültiges JSON ab, ohne zu speichern', async () => {
    expect(await s().saveCode('{ not json')).toBe(false);
    expect(s().getState().message?.text).toMatch(/not valid JSON/u);
    expect(await s().saveCode('[]')).toBe(false);
    expect(s().getState().message?.text).toMatch(/JSON object/u);
    expect((await serverNode(projectId, 'box'))?.['x']).toBe(20);
  });

  it('Zoom und Auflösung bestimmen die Render-Skalierung', () => {
    s().setZoom(0.5);
    s().setResolution(1);
    expect(s().renderScale()).toBe(0.5);
    s().setResolution(0.25);
    expect(s().renderScale()).toBe(0.25);
  });
});
