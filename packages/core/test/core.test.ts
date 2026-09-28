import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import {
  Registry,
  SCHEMA_VERSION,
  analyzeScene,
  applyPatches,
  canonicalJson,
  computeBounds,
  contentHash,
  evaluateScene,
  frameKey,
  getTransform,
  pathLength,
  planFrame,
  pointAtProgress,
  type EvaluatedNode,
  type Plugin,
  type RenderBackend,
} from '@agentic-video/core';

function fakeBackend(id: string, fusable = true): RenderBackend {
  return {
    id,
    nodeTypes: [],
    capabilities: [],
    fusable,
    versions: () => ({ [id]: '1' }),
    check: () => ({ supported: true, diagnostics: [] }),
    renderLayer: () => Promise.reject(new Error('not used')),
    dispose: () => Promise.resolve(),
  };
}

const base = (nodes: unknown[], extra: Record<string, unknown> = {}): Record<string, unknown> => ({
  schemaVersion: SCHEMA_VERSION,
  compositions: [{ id: 'main', width: 1920, height: 1080, fps: 30, duration: '10s', nodes, ...extra }],
});

describe('evaluateScene (FR-6)', () => {
  const project = base([
    { id: 'bg', type: 'rect', width: 1920, height: 1080, fill: '#000000' },
    { id: 'title', type: 'text', text: 'Hi', x: { $keyframes: [{ t: 0, v: 0 }, { t: 30, v: 300 }] }, opacity: { $expr: 'random(frame)' }, timing: { from: 10, duration: 60 } },
  ]);

  it('ist eine reine Funktion des Frames', () => {
    const a = evaluateScene(project, 'main', 471);
    evaluateScene(project, 'main', 470);
    const b = evaluateScene(project, 'main', 471);
    expect(b).toEqual(a);
    fc.assert(
      fc.property(fc.array(fc.integer({ min: 0, max: 299 }), { minLength: 1, maxLength: 10 }), (frames) => {
        const first = frames.map((f) => canonicalJson(evaluateScene(project, 'main', f)));
        const again = [...frames].reverse().map((f) => canonicalJson(evaluateScene(project, 'main', f))).reverse();
        expect(again).toEqual(first);
      }),
      { numRuns: 30 },
    );
  });

  it('wertet Timing relativ zur Node aus', () => {
    expect(evaluateScene(project, 'main', 5).nodes.map((n) => n.id)).toEqual(['bg']);
    const scene = evaluateScene(project, 'main', 25);
    const title = scene.nodes[1];
    expect(title?.props['x']).toBe(150);
    expect(title?.time.localFrame).toBe(15);
    expect(evaluateScene(project, 'main', 70).nodes).toHaveLength(1);
  });

  it('wendet Übergänge an', () => {
    const p = base([{ id: 'a', type: 'rect', width: 10, height: 10, timing: { from: 0, duration: 30 }, transition: { in: { type: 'fade', duration: 10 }, out: { type: 'wipe-left', duration: 10 } } }]);
    expect(evaluateScene(p, 'main', 5).nodes[0]?.props['opacity']).toBe(0.5);
    expect(evaluateScene(p, 'main', 25).nodes[0]?.reveal).toEqual({ shape: 'rect', direction: 'left', progress: 0.5 });
  });

  it('expandiert Komponenten mit lokalen IDs und meldet unbekannte', () => {
    const registry = new Registry();
    registry.registerComponent({
      name: 'Badge',
      description: 'test',
      example: {},
      expand: (props) => [{ id: 'label', type: 'text', text: String(props['label']) }],
    });
    const p = base([{ id: 'b1', type: 'component', component: 'Badge', props: { label: 'New' }, x: 10 }]);
    const scene = evaluateScene(p, 'main', 0, { registry });
    expect(scene.nodes[0]?.type).toBe('group');
    expect(scene.nodes[0]?.children[0]?.id).toBe('b1/label');
    expect(scene.nodes[0]?.children[0]?.props['text']).toBe('New');
    expect(evaluateScene(p, 'main', 0).diagnostics[0]?.code).toBe('OV_COMPONENT_UNKNOWN');
  });

  it('wertet verschachtelte Compositions mit Remap aus', () => {
    const p = {
      schemaVersion: SCHEMA_VERSION,
      compositions: [
        { id: 'main', width: 100, height: 100, fps: 30, duration: 100, nodes: [{ id: 'ref', type: 'composition-ref', composition: 'inner', timing: { remap: { $keyframes: [{ t: 0, v: 2 }, { t: 30, v: 0 }] } } }] },
        { id: 'inner', width: 50, height: 50, fps: 30, duration: 100, background: '#FF0000', nodes: [{ id: 'dot', type: 'rect', width: 1, height: 1, x: { $expr: 'frame' } }] },
      ],
    };
    const scene = evaluateScene(p, 'main', 15);
    const dot = scene.nodes[0]?.children.find((c) => c.id === 'ref/dot');
    // Remap: Frame 15 → 1 s → innerer Frame 30
    expect(dot?.props['x']).toBe(30);
    expect(scene.nodes[0]?.props['width']).toBe(50);
  });

  it('löst Theme-Tokens auf und meldet Fehler als Diagnose', () => {
    const p = { ...base([{ id: 'r', type: 'rect', width: 1, height: 1, fill: { $ref: 'theme.colors.brand' } }]), settings: { theme: { colors: { brand: '#123456' } } } };
    expect(evaluateScene(p, 'main', 0).nodes[0]?.props['fill']).toBe('#123456');
    const bad = base([{ id: 'r', type: 'rect', width: 1, height: 1, fill: { $ref: 'theme.colors.brand' } }]);
    expect(evaluateScene(bad, 'main', 0).diagnostics[0]?.code).toBe('OV_THEME_REF');
  });
});

describe('planFrame (AD-5)', () => {
  const registry = new Registry();
  for (const id of ['skia', 'browser']) registry.registerBackend(fakeBackend(id));
  registry.registerBackend(fakeBackend('three', false));

  it('fasst benachbarte Nodes zusammen und trennt Backends', () => {
    const p = base([
      { id: 'a', type: 'rect', width: 1, height: 1 },
      { id: 'b', type: 'text', text: 'x' },
      { id: 'h', type: 'html', html: '<b>x</b>', width: 10, height: 10 },
      { id: 's1', type: 'scene3d', width: 10, height: 10 },
      { id: 's2', type: 'scene3d', width: 10, height: 10 },
      { id: 'c', type: 'ellipse', width: 1, height: 1 },
    ]);
    const plan = planFrame(evaluateScene(p, 'main', 0), registry);
    expect(plan.map((l) => (l.kind === 'render' ? `${l.backend}:${l.nodes.map((n) => n.id).join('+')}` : 'composite'))).toEqual(['skia:a+b', 'browser:h', 'three:s1', 'three:s2', 'skia:c']);
  });

  it('stuft gemischte Gruppen und Layer-Nodes zu Compositor-Layern hoch', () => {
    const p = base([
      { id: 'g', type: 'group', children: [{ id: 'r', type: 'rect', width: 1, height: 1 }, { id: 'h', type: 'html', html: 'x', width: 1, height: 1 }] },
      { id: 'l', type: 'layer', blendMode: 'screen', children: [{ id: 'r2', type: 'rect', width: 1, height: 1 }] },
      { id: 'g2', type: 'group', children: [{ id: 'r3', type: 'rect', width: 1, height: 1 }] },
    ]);
    const plan = planFrame(evaluateScene(p, 'main', 0), registry);
    expect(plan[0]?.kind).toBe('composite');
    expect(plan[1]?.kind).toBe('composite');
    expect(plan[2]).toMatchObject({ kind: 'render', backend: 'skia' });
  });

  it('nutzt PixiJS als 2D-Backend, wenn gewählt', () => {
    const p = base([{ id: 'a', type: 'rect', width: 1, height: 1 }]);
    const plan = planFrame(evaluateScene(p, 'main', 0), registry, { renderer2d: 'pixi' });
    expect(plan[0]).toMatchObject({ backend: 'pixi' });
  });
});

describe('Registry und Plugins (FR-84)', () => {
  it('hat keinen globalen Zustand', () => {
    const a = new Registry();
    const b = new Registry();
    a.registerBackend(fakeBackend('skia'));
    expect(b.backends.size).toBe(0);
  });

  it('gibt Plugins nur deklarierte Rechte', async () => {
    const seen: string[] = [];
    const plugin: Plugin = {
      name: 'p',
      version: '1.0.0',
      permissions: ['process:spawn'],
      setup(ctx) {
        seen.push(ctx.readFile === undefined ? 'no-fs' : 'fs', ctx.spawn === undefined ? 'no-spawn' : 'spawn');
      },
    };
    const host = { readFile: () => Promise.resolve(new Uint8Array()), spawn: () => Promise.resolve({ code: 0, stdout: new Uint8Array(), stderr: '' }) };
    await new Registry().use(plugin, host);
    expect(seen).toEqual(['no-fs', 'spawn']);
    await expect(new Registry().use({ ...plugin, permissions: ['net'] }, host)).rejects.toThrow(/requests "net"/u);
  });

  it('lehnt doppelte Registrierungen ab', () => {
    const r = new Registry();
    r.registerBackend(fakeBackend('x'));
    expect(() => {
      r.registerBackend(fakeBackend('x'));
    }).toThrow(/already registered/u);
  });
});

describe('applyPatches (FR-19, FR-20)', () => {
  const project = base([
    { id: 'headline', type: 'text', text: 'Hello', fontSize: 92, y: 760 },
    { id: 'group', type: 'group', children: [{ id: 'dot', type: 'ellipse', width: 10, height: 10 }] },
  ]);

  it('ändert nur die genannte Stelle', () => {
    const r = applyPatches(project, [
      { op: 'setProperty', nodeId: 'headline', property: 'fontSize', value: 82 },
      { op: 'setProperty', nodeId: 'headline', property: 'y', value: 720 },
    ]);
    expect(r.ok).toBe(true);
    const expected = JSON.stringify(project).replace('"fontSize":92', '"fontSize":82').replace('"y":760', '"y":720');
    expect(JSON.stringify(r.project)).toBe(expected);
  });

  it('macht alle sieben Operationen per Umkehrung rückgängig', () => {
    const withAsset = { ...project, assets: [{ id: 'logo', type: 'image', src: './a.png' }] };
    const patches = [
      { op: 'setProperty', nodeId: 'dot', property: 'scale.x', value: 2 },
      { op: 'addNode', parentId: 'group', node: { id: 'new', type: 'rect', width: 1, height: 1 } },
      { op: 'moveNode', nodeId: 'dot', parentId: null, index: 0 },
      { op: 'addKeyframe', nodeId: 'headline', property: 'y', keyframe: { t: '1s', v: 700, ease: 'easeOutCubic' } },
      { op: 'addKeyframe', nodeId: 'headline', property: 'y', keyframe: { t: '2s', v: 650 } },
      { op: 'removeKeyframe', nodeId: 'headline', property: 'y', t: 60 },
      { op: 'replaceAsset', assetId: 'logo', src: './b.png' },
      { op: 'removeNode', nodeId: 'new' },
    ] as const;
    const r = applyPatches(withAsset, patches);
    expect(r.diagnostics.filter((d) => d.severity === 'error')).toEqual([]);
    expect(r.ok).toBe(true);
    const y = (r.project['compositions'] as { nodes: { id: string; y?: unknown }[] }[])[0]?.nodes.find((n) => n.id === 'headline')?.y;
    expect(y).toEqual({ $keyframes: [{ t: 0, v: 760 }, { t: '1s', v: 700, ease: 'easeOutCubic' }] });
    const back = applyPatches(r.project, r.inverse);
    expect(back.ok).toBe(true);
    expect(JSON.stringify(back.project)).toBe(JSON.stringify(withAsset));
  });

  it('ist atomar und liefert Diagnosen', () => {
    const r = applyPatches(project, [
      { op: 'setProperty', nodeId: 'headline', property: 'fontSize', value: 50 },
      { op: 'setProperty', nodeId: 'missing', property: 'x', value: 1 },
    ]);
    expect(r.ok).toBe(false);
    expect(r.project).toEqual(project);
    expect(r.diagnostics[0]?.problem).toContain('Patch 2 (setProperty): Node "missing" does not exist.');
    const invalid = applyPatches(project, [{ op: 'setProperty', nodeId: 'headline', property: 'fontSize', value: 'huge' }]);
    expect(invalid.ok).toBe(false);
    expect(invalid.diagnostics[0]?.path).toBe('composition.main.nodes.headline.fontSize');
  });

  it('blockiert Zyklen und verbotene Pfade', () => {
    expect(applyPatches(project, [{ op: 'moveNode', nodeId: 'group', parentId: 'dot' }]).ok).toBe(false);
    expect(applyPatches(project, [{ op: 'setProperty', nodeId: 'headline', property: '__proto__.x', value: 1 }]).ok).toBe(false);
    expect(applyPatches(project, [{ op: 'setProperty', nodeId: 'headline', property: 'children', value: [] }]).ok).toBe(false);
  });
});

describe('Bounds und Szenen-Diagnosen (FR-25, FR-26)', () => {
  it('berechnet transformierte Bounds und meldet Safe-Area-Probleme', () => {
    const p = base([
      { id: 'g', type: 'group', x: 100, y: 100, children: [{ id: 'r', type: 'rect', width: 100, height: 50, rotation: 90 }] },
      { id: 't', type: 'text', text: 'Edge', x: 1900, y: 500, fontSize: 40 },
      { id: 'far', type: 'rect', width: 10, height: 10, x: 5000 },
    ]);
    const scene = evaluateScene(p, 'main', 0);
    const bounds = computeBounds(scene);
    const r = bounds.find((b) => b.id === 'r')?.bounds;
    expect(r?.x).toBeCloseTo(125);
    expect(r?.y).toBeCloseTo(75);
    expect(r?.width).toBeCloseTo(50);
    expect(r?.height).toBeCloseTo(100);
    const codes = analyzeScene(scene, bounds).map((d) => `${d.code}:${d.nodeId ?? ''}`);
    expect(codes).toContain('OV_OVERFLOW:t');
    expect(codes).toContain('OV_OUT_OF_FRAME:far');
  });
});

describe('Bewegungspfad und Hashes', () => {
  it('folgt dem Pfad mit Auto-Rotation', () => {
    expect(pointAtProgress('M0 0 L100 0 L100 100', 0.75)).toMatchObject({ x: 100, y: 50, angle: 90 });
    expect(pathLength('M0 0 A 50 50 0 0 1 100 0')).toBeCloseTo(Math.PI * 50, 0);
    const node: EvaluatedNode = { id: 'n', type: 'rect', props: { x: 5, motionPath: { d: 'M0 0 L0 100', progress: 0.5, autoRotate: true } }, children: [], time: { localFrame: 0, relFrame: 0, durationFrames: 1, progress: 0, compositionFrame: 0 }, pointer: '' };
    expect(getTransform(node)).toMatchObject({ x: 5, y: 50, rotation: 90 });
  });

  it('hasht kanonisch und ändert Frame-Schlüssel nur bei Inhaltsänderung', () => {
    expect(contentHash({ b: 1, a: 2 })).toBe(contentHash({ a: 2, b: 1 }));
    expect(contentHash(new Uint8Array([1]))).toMatch(/^sha256:[0-9a-f]{64}$/u);
    const p = base([{ id: 'a', type: 'rect', width: 10, height: 10, x: { $keyframes: [{ t: 0, v: 0 }, { t: 10, v: 10 }] } }]);
    const k = (f: number) => frameKey(evaluateScene(p, 'main', f), { skia: '1' }, {}, { width: 1920, height: 1080 });
    expect(k(20)).toBe(k(21));
    expect(k(5)).not.toBe(k(6));
  });
});
