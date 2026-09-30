import { describe, expect, it } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { Registry, type Diagnostic } from '@agentic-video/core';
import { OPERATIONS, invokeOperation, startAgentServer, defineOperation, type AgentServices, type AssetService, type InvocationResult, type SourceService } from '@agentic-video/agent';
import Type from 'typebox';
import { smallProject, testServices } from './helpers.js';

function newServices(options: Parameters<typeof testServices>[1] = {}): AgentServices {
  return testServices(mkdtempSync(join(tmpdir(), 'ov-ops-')), options);
}

async function run(services: AgentServices, op: string, input: unknown): Promise<InvocationResult> {
  return invokeOperation(OPERATIONS, op, input, { services, via: 'test' });
}

async function ok(services: AgentServices, op: string, input: unknown): Promise<Record<string, unknown>> {
  const r = await run(services, op, input);
  if (!r.ok) throw new Error(`${op} failed: ${r.error.code} ${r.error.problem}`);
  return r.result as Record<string, unknown>;
}

function errorCode(r: InvocationResult): string | undefined {
  return r.ok ? undefined : r.error.code;
}

async function create(services: AgentServices, project: Record<string, unknown>, name = 'Demo'): Promise<string> {
  return String((await ok(services, 'project.create', { name, project }))['projectId']);
}

const RECT = { id: 'box', type: 'rect', width: 10, height: 10, fill: '#FF0000' };

describe('B4: Ausgabepfade', () => {
  it('project.create lehnt Projekte mit Validierungsfehlern ab', async () => {
    const services = newServices();
    const r = await run(services, 'project.create', { name: 'Bad', project: { schemaVersion: '1.0.0', compositions: [{ id: '../../../evil', width: 8, height: 8, fps: 10, duration: 5, nodes: [] }] } });
    expect(errorCode(r)).toBe('OV_PROJECT_INVALID');
    expect(await services.workspace.list()).toEqual([]);
  });

  it('frame.render schreibt nie außerhalb von out/, auch bei böser Composition-ID', async () => {
    const services = newServices();
    const id = await create(services, smallProject([RECT]));
    const bad = smallProject([RECT]);
    const comps = bad['compositions'];
    if (Array.isArray(comps) && typeof comps[0] === 'object' && comps[0] !== null) Object.assign(comps[0], { id: '../../../../evil' });
    await services.workspace.save(id, bad);
    const r = await ok(services, 'frame.render', { projectId: id, frame: 0, inline: false });
    const file = (r['image'] as { file: string }).file;
    const rel = relative(join(services.workspace.projectDir(id), 'out', 'frames'), file);
    expect(rel.startsWith('..')).toBe(false);
    expect(rel.includes('/')).toBe(false);
  });

  it('frame.render funktioniert mit IDs, die "/" enthalten', async () => {
    const services = newServices();
    const project = smallProject([RECT]);
    const comps = project['compositions'];
    if (Array.isArray(comps) && typeof comps[0] === 'object' && comps[0] !== null) Object.assign(comps[0], { id: 'intro/part' });
    const id = await create(services, project);
    const r = await ok(services, 'frame.render', { projectId: id, frame: 0, inline: false });
    expect(existsSync((r['image'] as { file: string }).file)).toBe(true);
  });

  it('video.render lehnt "." und ".." als outName und fremde Formate ab', async () => {
    const services = newServices();
    const id = await create(services, smallProject([RECT]));
    expect(errorCode(await run(services, 'video.render', { projectId: id, outName: '..' }))).toBe('OV_API_INPUT');
    expect(errorCode(await run(services, 'video.render', { projectId: id, outName: '.' }))).toBe('OV_API_INPUT');
    expect(errorCode(await run(services, 'video.render', { projectId: id, profile: { format: '../../../x' } }))).toBe('OV_RENDER_PROFILE');
  });
});

describe('B5: Skript-Hinweis prüft alle Strings und die ausgewertete Szene', () => {
  const html = (extra: Record<string, unknown>): Record<string, unknown> => ({ id: 'h', type: 'html', width: 10, height: 10, html: '<p>ok</p>', ...extra });
  const variants: [string, Record<string, unknown>][] = [
    ['img/onerror', html({ html: '<img/onerror=alert(1) src=x>' })],
    ['srcdoc', html({ html: '<iframe srcdoc="&lt;script&gt;alert(1)&lt;/script&gt;"></iframe>' })],
    ['css', html({ css: '</style><script>alert(1)</script>' })],
    ['$keyframes', html({ html: { $keyframes: [{ t: 0, v: '<p>a</p>' }, { t: 5, v: '<script>alert(1)</script>' }] } })],
  ];
  for (const [name, node] of variants) {
    it(`erkennt ${name}`, async () => {
      const services = newServices();
      const id = await create(services, smallProject([RECT]));
      // Direkt speichern: So sieht ungeprüfte IR aus (z. B. aus einer TSX-Quelle).
      await services.workspace.save(id, smallProject([node]));
      expect(errorCode(await run(services, 'frame.render', { projectId: id, frame: 0 }))).toBe('OV_SANDBOX_REQUIRED');
    });
  }

  it('erkennt Skripte in HTML-Nodes aus Komponenten (ausgewertete Szene)', async () => {
    const registry = new Registry();
    registry.registerComponent({
      name: 'Embed',
      description: 'test',
      example: {},
      expand: (props) => [{ id: 'inner', type: 'html', width: 10, height: 10, html: `${String(props['a'])}${String(props['b'])}` }],
    });
    const services = newServices({ registry });
    const id = await create(services, smallProject([{ id: 'c', type: 'component', component: 'Embed', props: { a: '<scr', b: 'ipt>alert(1)</script>' } }]));
    expect(errorCode(await run(services, 'frame.render', { projectId: id, frame: 0 }))).toBe('OV_SANDBOX_REQUIRED');
  });

  it('lässt HTML ohne Skripte durch', async () => {
    const services = newServices();
    const id = await create(services, smallProject([html({ css: 'p { animation: fade 1s; }' })]));
    expect(errorCode(await run(services, 'frame.render', { projectId: id, frame: 0 }))).not.toBe('OV_SANDBOX_REQUIRED');
  });
});

describe('B8: composition.create', () => {
  it('hängt eine Composition an, validiert und speichert', async () => {
    const services = newServices();
    const id = await create(services, smallProject([RECT]));
    const r = await ok(services, 'composition.create', { projectId: id, composition: { id: 'outro', width: 32, height: 18, fps: 10, duration: 5, nodes: [] } });
    expect(r['ok']).toBe(true);
    expect((await ok(services, 'composition.get', { projectId: id, compositionId: 'outro' }))['id']).toBe('outro');
  });

  it('lehnt doppelte IDs und ungültige Compositions ab, ohne zu speichern', async () => {
    const services = newServices();
    const id = await create(services, smallProject([RECT]));
    const dup = await ok(services, 'composition.create', { projectId: id, composition: { id: 'main', width: 32, height: 18, fps: 10, duration: 5, nodes: [] } });
    expect(dup['ok']).toBe(false);
    const bad = await ok(services, 'composition.create', { projectId: id, composition: { id: 'x', width: -1, fps: 10, duration: 5, nodes: [] } });
    expect(bad['ok']).toBe(false);
    const project = await services.workspace.load(id);
    expect((project['compositions'] as unknown[]).length).toBe(1);
  });
});

describe('B9: Grenzen gegen Überlast', () => {
  it('begrenzt die Pixelzahl eines Frames', async () => {
    const services = newServices();
    const id = await create(services, { schemaVersion: '1.0.0', compositions: [{ id: 'main', width: 16000, height: 16000, fps: 10, duration: 5, nodes: [] }] });
    expect(errorCode(await run(services, 'frame.render', { projectId: id, frame: 0 }))).toBe('OV_LIMIT_EXCEEDED');
    expect(errorCode(await run(services, 'frame.render', { projectId: id, frame: 0, scale: 0.1 }))).toBeUndefined();
  });

  it('begrenzt Profilmaße, fps und Gesamtframes', async () => {
    const services = newServices();
    const id = await create(services, smallProject([RECT]));
    expect(errorCode(await run(services, 'video.render', { projectId: id, profile: { format: 'mp4', width: 100000 } }))).toBe('OV_LIMIT_EXCEEDED');
    expect(errorCode(await run(services, 'video.render', { projectId: id, profile: { format: 'mp4', fps: 10000 } }))).toBe('OV_LIMIT_EXCEEDED');
    const long = await create(services, { schemaVersion: '1.0.0', compositions: [{ id: 'main', width: 8, height: 8, fps: 240, duration: 100_000_000, nodes: [] }] }, 'Long');
    expect(errorCode(await run(services, 'video.render', { projectId: long }))).toBe('OV_LIMIT_EXCEEDED');
    expect(errorCode(await run(services, 'preview.render', { projectId: long }))).toBe('OV_LIMIT_EXCEEDED');
  });

  it('antwortet mit 413 auf zu große Körper und 503 bei voller Warteschlange', async () => {
    const services = newServices();
    let release: () => void = () => undefined;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    // Zweite Sperre statt fester Wartezeit (Story 22.4): meldet, dass der langsame Handler läuft.
    let entered: () => void = () => undefined;
    const running = new Promise<void>((r) => {
      entered = r;
    });
    const slow = defineOperation({ name: 'test.slow', summary: 'waits', input: Type.Object({}), output: Type.Object({}), example: { input: {} }, handler: async () => { entered(); await gate; return {}; } });
    const server = await startAgentServer({ services, port: 0, maxBodyBytes: 100, maxConcurrentRequests: 1, maxQueuedRequests: 0, extraOperations: new Map([[slow.name, slow]]) });
    try {
      const big = await fetch(`${server.url}/v1/project.inspect`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ pad: 'x'.repeat(500) }) });
      expect(big.status).toBe(413);
      const first = fetch(`${server.url}/v1/test.slow`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
      await running;
      const second = await fetch(`${server.url}/v1/project.inspect`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
      expect(second.status).toBe(503);
      release();
      expect((await first).status).toBe(200);
    } finally {
      release();
      await server.close();
    }
  });
});

/** Quell-Dienst für Tests: die „Quelle“ ist JSON; `BROKEN` im Text bricht das Kompilieren. */
function fakeSources(calls: string[]): SourceService {
  return {
    compile(dir, entry) {
      calls.push(entry);
      const text = readFileSync(join(dir, entry), 'utf8');
      if (text.includes('BROKEN')) {
        const d: Diagnostic = { code: 'OV_TSX_SYNTAX', severity: 'error', errorClass: 'CompileError', problem: 'Broken source.', suggestions: [] };
        return Promise.resolve({ project: {}, diagnostics: [d] });
      }
      return Promise.resolve({ project: JSON.parse(text) as Record<string, unknown>, diagnostics: [] });
    },
    writeBack(dir, entry) {
      writeFileSync(join(dir, entry), 'BROKEN');
      return Promise.resolve({ applied: 1, diagnostics: [] });
    },
  };
}

describe('B10 und B16: TSX-Projekte', () => {
  it('composition.patch stellt die Quelle wieder her, wenn die Neukompilierung scheitert', async () => {
    const services = newServices({ sources: fakeSources([]) });
    const source = JSON.stringify(smallProject([RECT]));
    const id = String((await ok(services, 'project.create', { name: 'Tsx', source }))['projectId']);
    const r = await ok(services, 'composition.patch', { projectId: id, patches: [{ op: 'setProperty', nodeId: 'box', property: 'width', value: 12 }] });
    expect(r['ok']).toBe(false);
    expect(readFileSync(join(services.workspace.projectDir(id), 'src', 'video.tsx'), 'utf8')).toBe(source);
  });

  it('behandelt .ts-Einstiege wie .tsx', async () => {
    const calls: string[] = [];
    const services = newServices({ sources: fakeSources(calls) });
    const id = await create(services, smallProject([RECT]));
    const dir = services.workspace.projectDir(id);
    mkdirSync(join(dir, 'src'), { recursive: true });
    writeFileSync(join(dir, 'src', 'video.ts'), JSON.stringify(smallProject([{ ...RECT, id: 'fromTs' }])));
    writeFileSync(join(dir, 'openvideo.json'), JSON.stringify({ name: 'x', entry: 'src/video.ts', outDir: 'out' }));
    const r = await ok(services, 'project.inspect', { projectId: id });
    expect(r['kind']).toBe('tsx');
    expect(calls).toContain('src/video.ts');
  });

  it('Vorschau- und Frame-Dateinamen kollidieren nicht', async () => {
    const services = newServices();
    const id = await create(services, smallProject([RECT]));
    const a = await ok(services, 'preview.render', { projectId: id, scale: 0.5 });
    const b = await ok(services, 'preview.render', { projectId: id, scale: 0.25, end: 5 });
    const ra = await services.jobs.wait(String(a['jobId']));
    const rb = await services.jobs.wait(String(b['jobId']));
    const out = (info: typeof ra): string => JSON.stringify((info.result as { outputs: unknown }).outputs);
    expect(out(ra)).not.toBe(out(rb));
    const f1 = await ok(services, 'frame.render', { projectId: id, frame: 0, inline: false });
    const f2 = await ok(services, 'frame.render', { projectId: id, frame: 0, inline: false, debug: { showBounds: true } });
    expect((f1['image'] as { file: string }).file).not.toBe((f2['image'] as { file: string }).file);
  });
});

describe('B11: Eingaben von Patches, Vorschau und Kontaktbogen', () => {
  it('prüft den Patch-index', async () => {
    const services = newServices();
    const id = await create(services, smallProject([RECT]));
    for (const index of [-1, 1.5, '2']) {
      const r = await run(services, 'composition.patch', { projectId: id, patches: [{ op: 'addNode', parentId: null, index, node: { id: `n${String(index).replace(/\W/gu, '')}`, type: 'rect', width: 1, height: 1 } }] });
      expect(errorCode(r), String(index)).toBe('OV_PATCH_INVALID');
    }
  });

  it('prüft den Bereich von preview.render', async () => {
    const services = newServices();
    const id = await create(services, smallProject([RECT]));
    expect(errorCode(await run(services, 'preview.render', { projectId: id, start: 10, end: 5 }))).toBe('OV_RANGE_INVALID');
    expect(errorCode(await run(services, 'preview.render', { projectId: id, end: 500 }))).toBe('OV_RANGE_INVALID');
  });

  it('zeigt im Kontaktbogen jeden Frame nur einmal', async () => {
    const services = newServices();
    const id = await create(services, { schemaVersion: '1.0.0', compositions: [{ id: 'main', width: 8, height: 8, fps: 10, duration: 3, nodes: [] }] });
    const r = await ok(services, 'preview.contactSheet', { projectId: id, count: 8, inline: false });
    expect(r['frames']).toEqual([0, 1, 2]);
  });
});

describe('B12: Workspace', () => {
  it('vergibt bei gleichzeitigem Anlegen verschiedene IDs', async () => {
    const services = newServices();
    const ids = await Promise.all(Array.from({ length: 6 }, () => services.workspace.create('Same', smallProject())));
    expect(new Set(ids).size).toBe(6);
  });

  it('meldet kaputtes JSON als Projektfehler, nicht als OV_INTERNAL', async () => {
    const services = newServices();
    const id = await create(services, smallProject([RECT]));
    writeFileSync(join(services.workspace.projectDir(id), 'project.json'), '{ nope');
    expect(errorCode(await run(services, 'composition.get', { projectId: id }))).toBe('OV_PROJECT_INVALID');
    writeFileSync(join(services.workspace.projectDir(id), 'openvideo.json'), '{ nope');
    expect(errorCode(await run(services, 'composition.get', { projectId: id }))).toBe('OV_PROJECT_CONFIG');
  });

  it('lehnt einen Einstieg außerhalb des Projekts ab', async () => {
    const services = newServices({ sources: fakeSources([]) });
    const id = await create(services, smallProject([RECT]));
    writeFileSync(join(services.workspace.projectDir(id), 'openvideo.json'), JSON.stringify({ name: 'x', entry: '../../../etc/passwd.tsx' }));
    expect(errorCode(await run(services, 'composition.get', { projectId: id }))).toBe('OV_PROJECT_CONFIG');
  });

  it('ein kaputtes Projekt bricht die Liste nicht', async () => {
    const services = newServices();
    const good = await create(services, smallProject([RECT]), 'Good');
    const bad = await create(services, smallProject([RECT]), 'Bad');
    writeFileSync(join(services.workspace.projectDir(bad), 'openvideo.json'), '{ nope');
    const list = (await ok(services, 'project.inspect', {}))['projects'] as { id: string; error?: string }[];
    expect(list.map((p) => p.id)).toEqual([bad, good].sort());
    expect(list.find((p) => p.id === bad)?.error).toBe('OV_PROJECT_CONFIG');
  });
});

describe('B17: fehlende Tests zu dryRun und „nur neue Fehler“', () => {
  it('dryRun speichert nichts', async () => {
    const services = newServices();
    const id = await create(services, smallProject([RECT]));
    const r = await ok(services, 'composition.patch', { projectId: id, dryRun: true, patches: [{ op: 'setProperty', nodeId: 'box', property: 'width', value: 30 }] });
    expect(r['ok']).toBe(true);
    expect(r['inverse']).toEqual([{ op: 'setProperty', nodeId: 'box', property: 'width', value: 10, compositionId: 'main' }]);
    expect(JSON.stringify(await services.workspace.load(id))).not.toContain('30');
  });

  it('bestehende Fehler blockieren Patches nicht, neue Fehler schon', async () => {
    const services = newServices();
    const id = await create(services, smallProject([RECT, { id: 't', type: 'text', text: 'Hi', fontSize: 12 }]));
    const broken = smallProject([RECT, { id: 't', type: 'text', text: 'Hi', fontSize: 'huge' }]);
    await services.workspace.save(id, broken);
    const fine = await ok(services, 'composition.patch', { projectId: id, patches: [{ op: 'setProperty', nodeId: 'box', property: 'width', value: 20 }] });
    expect(fine['ok']).toBe(true);
    const worse = await ok(services, 'composition.patch', { projectId: id, patches: [{ op: 'setProperty', nodeId: 'box', property: 'height', value: 'tall' }] });
    expect(worse['ok']).toBe(false);
  });
});

describe('A7: asset.import meldet das Ersetzen eines Assets', () => {
  it('liefert OV_ASSET_REPLACED, wenn die ID schon existiert', async () => {
    const assets: AssetService = {
      import: () => Promise.resolve({ id: 'logo', type: 'image', src: 'assets/logo.png', hash: `sha256:${'a'.repeat(64)}`, metadata: {}, diagnostics: [] }),
      inspect: () => Promise.resolve({}),
    };
    const services = { ...newServices(), assets };
    const id = await create(services, smallProject([RECT]));
    const first = await ok(services, 'asset.import', { projectId: id, path: 'logo.png' });
    expect((first['diagnostics'] as Diagnostic[]).map((d) => d.code)).not.toContain('OV_ASSET_REPLACED');
    const second = await ok(services, 'asset.import', { projectId: id, path: 'logo.png' });
    const replaced = (second['diagnostics'] as Diagnostic[]).find((d) => d.code === 'OV_ASSET_REPLACED');
    expect(replaced?.severity).toBe('warning');
  });
});

describe('keepNull: Umkehrungen mit null überstehen die Agent API', () => {
  it('stellt einen null-Wert über die Umkehrung wieder her', async () => {
    const services = newServices();
    const id = await create(services, smallProject([{ ...RECT, meta: { note: null } }]));
    const r = await ok(services, 'composition.patch', { projectId: id, patches: [{ op: 'setProperty', nodeId: 'box', property: 'meta.note', value: 'hi' }] });
    expect(r['ok']).toBe(true);
    const inverse = r['inverse'] as Record<string, unknown>[];
    expect(inverse[0]).toMatchObject({ op: 'setProperty', nodeId: 'box', property: 'meta.note', value: null, keepNull: true });
    const back = await ok(services, 'composition.patch', { projectId: id, patches: inverse });
    expect(back['ok']).toBe(true);
    const comp = await ok(services, 'composition.get', { projectId: id });
    const meta = (comp['nodes'] as { meta: Record<string, unknown> }[])[0]?.meta ?? {};
    expect('note' in meta).toBe(true);
    expect(meta['note']).toBeNull();
  });

  it('lehnt keepNull ab, das kein Boolean ist', async () => {
    const services = newServices();
    const id = await create(services, smallProject([RECT]));
    expect(errorCode(await run(services, 'composition.patch', { projectId: id, patches: [{ op: 'setProperty', nodeId: 'box', property: 'fill', value: null, keepNull: 'yes' }] }))).toBe('OV_PATCH_INVALID');
  });
});
