/**
 * Epic 19 (Agent-Erfahrung): typisiertes Patch-Schema, Selbstbeschreibung, project.open,
 * frame.renderMany, project.import, subtitles.transcribe und Diagnose-Härtung.
 */
import { describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { OpenVideoError, PATCH_OPS, Registry, applyPatches, isRecord, type AsrProvider, type Patch } from '@agentic-video/core';
import { JobManager, OPERATIONS, PATCH_EXAMPLES, PATCH_SCHEMAS, PatchSchema, checkPatchList, invokeOperation, type AgentServices, type InvocationResult } from '@agentic-video/agent';
import { smallProject, testEnvironment, testServices } from './helpers.js';

function newServices(options: Parameters<typeof testServices>[1] = {}): AgentServices {
  return testServices(mkdtempSync(join(tmpdir(), 'ov-dx-')), options);
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

/** Länge einer Liste aus einem Ergebnis (−1, wenn es keine Liste ist). */
function lengthOf(value: unknown): number {
  return Array.isArray(value) ? value.length : -1;
}

/** Objekte einer Liste (andere Einträge fallen weg); keine Liste → leer. */
function records(value: unknown): Record<string, unknown>[] {
  return Array.isArray(value) ? value.filter(isRecord) : [];
}

/** Ein Objekt oder ein leeres Objekt. */
function rec(value: unknown): Record<string, unknown> {
  return isRecord(value) ? value : {};
}

/** Liste von Texten (andere Einträge fallen weg). */
function strings(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string') : [];
}

/** Codes der Diagnosen eines Ergebnisses. */
function codes(value: unknown): string[] {
  return records(value).map((d) => String(d['code']));
}

/**
 * Patch-förmig: ein Objekt mit bekannter `op`. Die Felder prüft erst der Kern – genau das testen die
 * Aufrufer, die ihm absichtlich falsche Felder geben.
 */
function isPatchShaped(value: unknown): value is Patch {
  return isRecord(value) && PATCH_OPS.some((op) => op === value['op']);
}

function failure(r: InvocationResult) {
  if (r.ok) throw new Error('expected an error');
  return r.error;
}

const RECT = { id: 'box', type: 'rect', x: 0, y: 0, width: 10, height: 10, fill: '#FF0000' };

async function create(services: AgentServices, nodes: Record<string, unknown>[] = [RECT]): Promise<string> {
  return String((await ok(services, 'project.create', { name: 'Dx', project: smallProject(nodes) }))['projectId']);
}

/** Projekt wie im Doc-Test: Composition `main` mit `headline` und `f1`. */
function docProject(): Record<string, unknown> {
  return {
    schemaVersion: '1.0.0',
    compositions: [{ id: 'main', width: 1920, height: 1080, fps: 30, duration: '12s', nodes: [{ id: 'headline', type: 'text', text: 'Hi', fontSize: 92, y: 760 }, { id: 'f1', type: 'text', text: 'Point', fontSize: 48 }] }],
  };
}

describe('Story 19.1: typisiertes Patch-Schema', () => {
  it('hat einen Zweig mit Diskriminator op und Beispiel je Patch-Art', () => {
    expect(PatchSchema.anyOf).toHaveLength(PATCH_OPS.length);
    for (const op of PATCH_OPS) {
      const branch = PATCH_SCHEMAS[op];
      expect(branch.properties.op.const).toBe(op);
      expect(rec(branch)['additionalProperties']).toBe(false);
      expect(PATCH_EXAMPLES[op].at(-1)?.op).toBe(op);
    }
  });

  it('jedes Beispiel besteht die Prüfung und lässt sich anwenden', () => {
    for (const op of PATCH_OPS) {
      expect(checkPatchList(PATCH_EXAMPLES[op], 'patches'), op).toBeUndefined();
      const r = applyPatches(docProject(), PATCH_EXAMPLES[op]);
      expect(r.diagnostics.filter((d) => d.severity === 'error'), op).toEqual([]);
      expect(r.ok, op).toBe(true);
    }
  });

  it('veröffentlicht die Felder je Patch-Art im Eingabeschema von composition.patch', () => {
    const op = OPERATIONS.get('composition.patch');
    const items = JSON.parse(JSON.stringify(op?.input)).properties.patches.items;
    expect(items.anyOf.map((b: { title: string }) => b.title)).toEqual([...PATCH_OPS]);
    expect(items.anyOf[0].required).toEqual(expect.arrayContaining(['op', 'nodeId', 'property', 'value']));
  });
});

describe('Story 19.6: Diagnose-Härtung', () => {
  it('nennt den Patch-Index, expected/received und schlägt die op vor', async () => {
    const services = newServices();
    const id = await create(services);
    const e = failure(await run(services, 'composition.patch', { projectId: id, patches: [{ op: 'setProperty', nodeId: 'box', property: 'x', value: 1 }, { op: 'setPropety', nodeId: 'box', property: 'x', value: 2 }] }));
    expect(e.code).toBe('OV_PATCH_INVALID');
    expect(e.path).toBe('patches[1].op');
    expect(e.received).toBe('"setPropety"');
    expect(e.suggestions[0]).toContain('Did you mean "setProperty"');
  });

  it('meldet fehlende Felder mit Pfad und Beispiel', async () => {
    const services = newServices();
    const id = await create(services);
    const e = failure(await run(services, 'composition.patch', { projectId: id, patches: [{ op: 'addKeyframe', nodeId: 'box', property: 'x', keyframe: { v: 3 } }] }));
    expect(e.path).toBe('patches[0].keyframe.t');
    expect(e.received).toBe('undefined (missing)');
    expect(e.suggestions.join(' ')).toContain('Example addKeyframe patch');
  });

  it('lehnt eine parentId ab, die weder String noch null ist (kein stiller Rückfall auf die oberste Ebene)', async () => {
    const services = newServices();
    const id = await create(services);
    const e = failure(await run(services, 'composition.patch', { projectId: id, patches: [{ op: 'addNode', parentId: 5, node: { id: 'n', type: 'rect', width: 1, height: 1 } }] }));
    expect(e.code).toBe('OV_PATCH_INVALID');
    expect(e.path).toBe('patches[0].parentId');
    // Auch der Kern prüft streng, wenn JavaScript-Aufrufer ihn direkt nutzen.
    const wrong: unknown = { op: 'moveNode', nodeId: 'box', parentId: 7 };
    if (!isPatchShaped(wrong)) throw new Error('not patch-shaped');
    const core = applyPatches(smallProject([RECT]), [wrong]);
    expect(core.ok).toBe(false);
    expect(core.diagnostics[0]?.path).toBe('patches[0].parentId');
  });

  it('schlägt bei unbekannter Node-ID die ähnlichste vor', async () => {
    const services = newServices();
    const id = await create(services, [RECT, { id: 'headline', type: 'text', text: 'Hi', fontSize: 4 }]);
    const r = await ok(services, 'composition.patch', { projectId: id, patches: [{ op: 'setProperty', nodeId: 'box', property: 'x', value: 1 }, { op: 'setProperty', nodeId: 'headlin', property: 'x', value: 1 }] });
    expect(r['ok']).toBe(false);
    const d = records(r['diagnostics'])[0];
    expect(d?.['path']).toBe('patches[1]');
    expect(d?.['received']).toBe('"headlin"');
    expect(strings(d?.['suggestions'])[0]).toBe('Did you mean "headline"?');
  });

  it('kein Fehler einer Agent-Operation hat leere suggestions', async () => {
    const services = newServices();
    const id = await create(services);
    const calls: [string, unknown][] = [
      ['composition.patch', { projectId: id, patches: [{ op: 'removeAsset', assetId: 'nope' }] }],
      ['composition.patch', { projectId: id, patches: [{ op: 'setCompositionProperty', compositionId: 'mian', property: 'fps', value: 5 }] }],
      ['composition.patch', { projectId: id, patches: [{ op: 'setProjectProperty', property: 'assets', value: [] }] }],
      ['composition.patch', { projectId: id, patches: [{ op: 'setCompositionProperty', compositionId: 'main', property: 'nodes', value: [] }] }],
      ['composition.patch', { projectId: id, patches: [{ op: 'addNode', parentId: null, node: { id: 'x', type: 'rect' }, compositionId: 'zzz' }] }],
      ['composition.get', { projectId: 'missing' }],
      ['render.status', { jobId: 'job-missing' }],
      ['templates.inspect', { name: 'x' }],
      ['asset.inspect', { projectId: id, assetId: 'x' }],
      ['frame.render', { projectId: id, frame: 0, sclae: 1 }],
      ['frame.rendr', {}],
      ['capabilities.get', { nodeType: 'txt' }],
      ['schema.get', { operation: 'frame.rendr' }],
      ['project.open', { path: 'x' }],
      ['project.import', { projectId: id, content: '<svg/>' }],
      ['subtitles.transcribe', { projectId: id, trackId: 'subs' }],
      ['frame.renderMany', { projectId: id, frames: [500] }],
    ];
    for (const [op, input] of calls) {
      const r = await run(services, op, input);
      const diagnostics = r.ok ? records(rec(r.result)['diagnostics']).filter((d) => d['severity'] === 'error') : [{ ...r.error }];
      expect(diagnostics.length, `${op} should fail`).toBeGreaterThan(0);
      for (const d of diagnostics) expect(strings(d['suggestions']).length, `${op}: ${JSON.stringify(d)}`).toBeGreaterThan(0);
    }
  });

  it('Fehler von Render-Jobs tragen einen Vorschlag, auch wenn der Renderer keinen mitgibt', async () => {
    const services = newServices();
    const jobs = new JobManager(mkdtempSync(join(tmpdir(), 'ov-dx-jobs-')), services.telemetry, 1);
    const id = jobs.start('video.render', 'p', () => Promise.reject(new OpenVideoError({ code: 'OV_RENDER_CANCELLED', errorClass: 'RenderError', problem: 'The render was cancelled.', suggestions: [] })));
    const info = await jobs.wait(id);
    expect(info.state).toBe('cancelled');
    expect(info.error?.suggestions.length).toBeGreaterThan(0);
  });

  it('Quellcode der Agent-Pfade enthält kein "suggestions: []"', () => {
    const root = new URL('../../', import.meta.url);
    const files = ['agent/src', 'mcp/src', 'cli/src'].flatMap((dir) => readdirSync(new URL(dir, root)).filter((f) => f.endsWith('.ts')).map((f) => new URL(`${dir}/${f}`, root)));
    files.push(new URL('core/src/patches.ts', root));
    for (const file of files) {
      const text = readFileSync(file, 'utf8');
      expect(/suggestions:\s*\[\s*\]/u.test(text), file.pathname).toBe(false);
      expect(/patchError\([^;]*,\s*\[\s*\]\s*[,)]/u.test(text), file.pathname).toBe(false);
    }
  });
});

describe('Story 19.3: Selbstbeschreibung', () => {
  it('capabilities.get liefert Operationen, Node-Typen und Filter', async () => {
    const services = newServices();
    const all = await ok(services, 'capabilities.get', {});
    expect(lengthOf(all['operations'])).toBe(OPERATIONS.size);
    expect(all['patchOps']).toEqual([...PATCH_OPS]);
    const text = await ok(services, 'capabilities.get', { nodeType: 'text' });
    expect(text['properties']).toContain('fontSize');
    expect(text['backends']).toEqual(['skia']);
    const e = failure(await run(services, 'capabilities.get', { nodeType: 'txt' }));
    expect(e.suggestions[0]).toBe('Did you mean "text"?');
  });

  it('schema.get liefert IR, Node-Typ, Patch-Format und Operationsschema', async () => {
    const services = newServices();
    const full = await ok(services, 'schema.get', {});
    expect(rec(rec(full['schema'])['$defs'])).toHaveProperty('Node_rect');
    const rect = await ok(services, 'schema.get', { nodeType: 'rect' });
    expect(JSON.stringify(rect['schema'])).not.toContain('"$ref":"#/$defs/width');
    expect(rec(rec(rect['schema'])['properties'])).toHaveProperty('cornerRadius');
    const patch = await ok(services, 'schema.get', { name: 'patch' });
    expect(Object.keys(rec(patch['kinds']))).toEqual([...PATCH_OPS]);
    const op = await ok(services, 'schema.get', { operation: 'frame.renderMany' });
    expect(op['operation']).toBe('frame.renderMany');
  });
});

describe('Story 19.4: project.open', () => {
  function withRoots(roots: string[]): AgentServices {
    return { ...newServices(), projectRoots: roots };
  }

  it('ist ohne erlaubte Wurzeln aus', async () => {
    expect(failure(await run(newServices(), 'project.open', { path: '/tmp' })).code).toBe('OV_PROJECT_OPEN_DISABLED');
  });

  it('öffnet einen Projektordner in einer erlaubten Wurzel, auch wiederholt mit derselben ID', async () => {
    const root = mkdtempSync(join(tmpdir(), 'ov-roots-'));
    mkdirSync(join(root, 'Launch Video'));
    writeFileSync(join(root, 'Launch Video', 'project.json'), JSON.stringify(smallProject([RECT])));
    const services = withRoots([root]);
    const a = await ok(services, 'project.open', { path: 'Launch Video' });
    expect(a).toMatchObject({ projectId: 'launch-video', kind: 'json', compositions: ['main'] });
    expect((await ok(services, 'project.open', { path: join(root, 'Launch Video') }))['projectId']).toBe('launch-video');
    const v = await ok(services, 'composition.validate', { projectId: 'launch-video' });
    expect(v['ok']).toBe(true);
    const listed = await ok(services, 'project.inspect', {});
    expect(records(listed['projects']).map((p) => p['id'])).toContain('launch-video');
  });

  it('lehnt Ordner außerhalb der Wurzeln ab, auch über Symlinks', async () => {
    const root = mkdtempSync(join(tmpdir(), 'ov-roots-'));
    const outside = mkdtempSync(join(tmpdir(), 'ov-outside-'));
    writeFileSync(join(outside, 'project.json'), JSON.stringify(smallProject()));
    symlinkSync(outside, join(root, 'escape'));
    const services = withRoots([root]);
    expect(failure(await run(services, 'project.open', { path: outside })).code).toBe('OV_PATH_OUTSIDE');
    expect(failure(await run(services, 'project.open', { path: 'escape' })).code).toBe('OV_PATH_OUTSIDE');
    expect(failure(await run(services, 'project.open', { path: 'missing' })).code).toBe('OV_PROJECT_UNKNOWN');
  });
});

describe('Story 19.5: frame.renderMany', () => {
  it('rendert jeden Frame einmal und prüft den Bereich', async () => {
    const services = newServices();
    const id = await create(services);
    const r = await ok(services, 'frame.renderMany', { projectId: id, frames: [0, 5, '0.5s', 0], inline: false });
    expect(r['frames']).toEqual([0, 5]);
    expect(lengthOf(r['images'])).toBe(2);
    expect(failure(await run(services, 'frame.renderMany', { projectId: id, frames: [20] })).code).toBe('OV_RANGE_INVALID');
  });
});

describe('Story 19.5: project.import', () => {
  it('importiert SVG mit Verlust-Warnung und speichert die Nodes', async () => {
    const services = newServices();
    const id = await create(services);
    const svg = '<svg xmlns="http://www.w3.org/2000/svg" width="20" height="10"><defs><filter id="f"><feGaussianBlur stdDeviation="2"/></filter></defs><rect width="20" height="10" fill="#00FF00" filter="url(#f)"/></svg>';
    const r = await ok(services, 'project.import', { projectId: id, format: 'svg', content: svg, idPrefix: 'logo' });
    expect(r['ok']).toBe(true);
    expect(r['nodes']).toEqual(['logo']);
    expect(codes(r['diagnostics'])).toContain('OV_IMPORT_LOSSY');
    const comp = await ok(services, 'composition.get', { projectId: id });
    expect(records(comp['nodes']).map((n) => n['id'])).toEqual(['box', 'logo']);
  });

  it('dryRun speichert nichts', async () => {
    const services = newServices();
    const id = await create(services);
    const r = await ok(services, 'project.import', { projectId: id, format: 'svg', content: '<svg xmlns="http://www.w3.org/2000/svg"><rect width="2" height="2"/></svg>', dryRun: true });
    expect(r['ok']).toBe(true);
    const comp = await ok(services, 'composition.get', { projectId: id });
    expect(lengthOf(comp['nodes'])).toBe(1);
  });

  it('übersetzt eine Anime.js-Timeline in Keyframes', async () => {
    const services = newServices();
    const id = await create(services);
    const r = await ok(services, 'project.import', { projectId: id, format: 'anime', content: { entries: [{ targets: 'box', params: { opacity: [0, 1], duration: 500, onComplete: 'x' } }] } });
    expect(r['ok']).toBe(true);
    expect(codes(r['diagnostics'])).toContain('OV_IMPORT_LOSSY');
    const comp = await ok(services, 'composition.get', { projectId: id });
    expect(JSON.stringify(records(comp['nodes'])[0]?.['opacity'])).toContain('$keyframes');
  });

  it('führt Motion-Canvas-Szenen aus JSON aus', async () => {
    const services = newServices();
    const id = await create(services);
    const content = {
      scenes: [
        {
          name: 'intro',
          nodes: [{ type: 'Rect', key: 'card', props: { width: 20, height: 10, fill: '#e13238' } }],
          timeline: [{ all: [{ tween: { node: 'card', property: 'x', to: 10, duration: 1, ease: 'easeOutCubic' } }, { tween: { node: 'card', property: 'opacity', to: 0.5, duration: 1 } }] }, { tween: { node: 'card', property: 'wobble', to: 1, duration: 1 } }],
        },
      ],
    };
    const r = await ok(services, 'project.import', { projectId: id, format: 'motion-canvas', content });
    expect(r['ok']).toBe(true);
    expect(r['nodes']).toEqual(['intro']);
    expect(records(r['diagnostics']).some((d) => d['code'] === 'OV_IMPORT_LOSSY' && String(d['path']).includes('timeline[1]'))).toBe(true);
    const comp = await ok(services, 'composition.get', { projectId: id });
    expect(JSON.stringify(comp['nodes'])).toContain('$keyframes');
  });

  it('bettet Lottie verlustfrei ein und schreibt das Asset', async () => {
    const services = newServices();
    const id = await create(services);
    const lottie = { v: '5.7.0', w: 10, h: 10, fr: 10, ip: 0, op: 10, layers: [] };
    const r = await ok(services, 'project.import', { projectId: id, format: 'lottie', content: lottie, lottieMode: 'embed', idPrefix: 'anim' });
    expect(r['assets']).toEqual(['anim-asset']);
    expect(readFileSync(join(services.workspace.projectDir(id), 'assets', 'anim-asset.json'), 'utf8')).toContain('"layers"');
  });

  it('meldet ein unbekanntes Format mit Vorschlag', async () => {
    const services = newServices();
    const id = await create(services);
    const e = failure(await run(services, 'project.import', { projectId: id, content: 'x' }));
    expect(e.code).toBe('OV_IMPORT_FORMAT');
  });
});

describe('Story 19.5: subtitles.transcribe', () => {
  function servicesWith(registry: Registry, audioPath: string): AgentServices {
    const base = newServices({ registry });
    const env = testEnvironment(registry);
    const record = { id: 'voice', type: 'audio', src: 'assets/voice.wav', path: audioPath, hash: 'sha256:x', metadata: {} };
    return { ...base, withEnvironment: (_dir, _project, fn) => fn({ ...env, assets: { ...env.assets, get: (id) => (id === 'voice' ? record : undefined), all: () => [record] } }) };
  }

  it('meldet ohne ASR-Engine eine klare Diagnose mit Installationshinweis', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ov-asr-'));
    writeFileSync(join(dir, 'voice.wav'), new Uint8Array([1, 2, 3]));
    const services = servicesWith(new Registry(), join(dir, 'voice.wav'));
    const id = await create(services);
    const e = failure(await run(services, 'subtitles.transcribe', { projectId: id, trackId: 'subs', source: 'voice' }));
    expect(e.code).toBe('OV_ASR_UNAVAILABLE');
    expect(e.suggestions.join(' ')).toContain('whisper');
  });

  it('schreibt die Cues des Providers in den Track (fromAudio als Vorgabe)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ov-asr-'));
    writeFileSync(join(dir, 'voice.wav'), new Uint8Array([1, 2, 3]));
    const registry = new Registry();
    const provider: AsrProvider = {
      id: 'fake-asr',
      version: () => Promise.resolve('1'),
      available: () => Promise.resolve(true),
      transcribe: () => Promise.resolve({ cues: [{ start: 0, end: 1, text: 'Hello world' }] }),
    };
    registry.registerAsrProvider(provider);
    const services = servicesWith(registry, join(dir, 'voice.wav'));
    const id = String(
      (await ok(services, 'project.create', { name: 'Asr', project: smallProject([RECT], { tracks: [{ id: 'subs', kind: 'subtitle', fromAudio: { source: 'voice', provider: 'fake-asr' } }] }) }))['projectId'],
    );
    const r = await ok(services, 'subtitles.transcribe', { projectId: id, trackId: 'subs' });
    expect(r).toMatchObject({ ok: true, provider: 'fake-asr', saved: true });
    const comp = await ok(services, 'composition.get', { projectId: id });
    const cue = records(records(comp['tracks'])[0]?.['cues'])[0];
    expect(cue?.['text']).toBe('Hello world');
    expect(records(cue?.['words'])).toHaveLength(2);
  });
});
