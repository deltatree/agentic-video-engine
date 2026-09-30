/**
 * Epic 17 im Kern: Planner-Hochstufung (17.1), Arbeits- und Ausgabefarbraum (17.2),
 * `zIndex` (17.3), benannte Events und `sequence` (17.10).
 */
import { describe, expect, it } from 'vitest';
import { Registry, SCHEMA_VERSION, evaluateScene, frameKey, planFrame, sortByZIndex, validateProject, type EvaluatedNode, type LayerPlan, type RenderBackend } from '@agentic-video/core';

function backend(id: string, nodeTypes: readonly string[], fusable: boolean): RenderBackend {
  return {
    id,
    nodeTypes,
    capabilities: [],
    fusable,
    versions: () => ({ [id]: '1' }),
    check: () => ({ supported: true, diagnostics: [] }),
    renderLayer: () => Promise.reject(new Error('not used')),
    dispose: () => Promise.resolve(),
  };
}

const registry = new Registry();
registry.registerBackend(backend('skia', ['group', 'rect', 'text', 'ellipse'], true));
registry.registerBackend(backend('browser', ['html'], true));
registry.registerBackend(backend('three', ['scene3d'], false));

function project(nodes: unknown[], extra: Record<string, unknown> = {}, settings?: Record<string, unknown>): Record<string, unknown> {
  return { schemaVersion: SCHEMA_VERSION, ...(settings !== undefined ? { settings } : {}), compositions: [{ id: 'main', width: 320, height: 180, fps: 30, duration: '10s', nodes, ...extra }] };
}

function describePlan(plan: readonly LayerPlan[]): unknown[] {
  return plan.map((l) => (l.kind === 'render' ? `${l.backend}:${l.nodes.map((n) => n.id).join('+')}` : { [`${l.mode}:${l.id}`]: describePlan(l.children) }));
}

const s3d = (id: string, extra: Record<string, unknown> = {}) => ({ id, type: 'scene3d', width: 10, height: 10, ...extra });

describe('planFrame: Hochstufung über Backend-Grenzen (17.1)', () => {
  it('stuft group{scene3d} und group{html} zu Compositor-Gruppen hoch', () => {
    const p = project([
      { id: 'g1', type: 'group', x: 10, children: [s3d('s')] },
      { id: 'g2', type: 'group', children: [{ id: 'h', type: 'html', html: 'x', width: 1, height: 1 }] },
    ]);
    expect(describePlan(planFrame(evaluateScene(p, 'main', 0), registry))).toEqual([{ 'group:g1': ['three:s'] }, { 'group:g2': ['browser:h'] }]);
  });

  it('lässt reine 2D-Gruppen in einem Skia-Layer', () => {
    const p = project([{ id: 'g', type: 'group', children: [{ id: 'r', type: 'rect', width: 1, height: 1 }] }]);
    expect(describePlan(planFrame(evaluateScene(p, 'main', 0), registry))).toEqual(['skia:g']);
  });

  it('isoliert eine 2D-Node mit Blend Mode über einem Layer eines anderen Backends', () => {
    const p = project([s3d('s'), { id: 't', type: 'text', text: 'x', blendMode: 'overlay' }, { id: 'r', type: 'rect', width: 1, height: 1 }]);
    const plan = planFrame(evaluateScene(p, 'main', 0), registry);
    expect(describePlan(plan)).toEqual(['three:s', { 'isolate:t': ['skia:t'] }, 'skia:r']);
    const iso = plan[1];
    if (iso?.kind !== 'composite') throw new Error('expected composite');
    expect(iso.node.props['blendMode']).toBe('overlay');
    const inner = iso.children[0];
    expect(inner?.kind === 'render' ? inner.nodes[0]?.props['blendMode'] : 'missing').toBeUndefined();
  });

  it('lässt Blend Modes im selben 2D-Layer beim Backend (ohne Hintergrund)', () => {
    const p = project([{ id: 'a', type: 'rect', width: 1, height: 1 }, { id: 'b', type: 'rect', width: 1, height: 1, blendMode: 'multiply' }]);
    expect(describePlan(planFrame(evaluateScene(p, 'main', 0), registry))).toEqual(['skia:a+b']);
  });

  it('zählt die Hintergrundfarbe der Composition zum Backdrop', () => {
    const p = project([{ id: 'a', type: 'rect', width: 1, height: 1 }, { id: 'b', type: 'rect', width: 1, height: 1, blendMode: 'multiply' }], { background: '#102030' });
    expect(describePlan(planFrame(evaluateScene(p, 'main', 0), registry))).toEqual(['skia:a', { 'isolate:b': ['skia:b'] }]);
  });

  it('isoliert scene3d mit Blend Mode, Maske oder Reveal und entfernt sie aus der Backend-Node', () => {
    const p = project([
      s3d('blend', { blendMode: 'screen' }),
      s3d('masked', { mask: { node: { id: 'm', type: 'rect', width: 5, height: 5 } } }),
      s3d('wiped', { transition: { in: { type: 'wipe-left', duration: 10 } } }),
      s3d('plain'),
    ]);
    const plan = planFrame(evaluateScene(p, 'main', 3), registry);
    expect(describePlan(plan)).toEqual([{ 'isolate:blend': ['three:blend'] }, { 'isolate:masked': ['three:masked'] }, { 'isolate:wiped': ['three:wiped'] }, 'three:plain']);
    for (const layer of plan.slice(0, 3)) {
      if (layer.kind !== 'composite') throw new Error('expected composite');
      const inner = layer.children[0];
      if (inner?.kind !== 'render') throw new Error('expected render');
      const n: EvaluatedNode | undefined = inner.nodes[0];
      expect(n?.props['blendMode']).toBeUndefined();
      expect(n?.mask).toBeUndefined();
      expect(n?.reveal).toBeUndefined();
    }
  });

  it('isoliert eine 2D-Node mit einer Maske aus einem anderen Backend, behält aber den Reveal beim Backend', () => {
    const p = project([{ id: 'r', type: 'rect', width: 5, height: 5, transition: { in: { type: 'iris', duration: 10 } }, mask: { node: s3d('m') } }]);
    const plan = planFrame(evaluateScene(p, 'main', 3), registry);
    expect(describePlan(plan)).toEqual([{ 'isolate:r': ['skia:r'] }]);
    const iso = plan[0];
    if (iso?.kind !== 'composite') throw new Error('expected composite');
    expect(iso.node.mask?.node.id).toBe('m');
    expect(iso.node.reveal).toBeUndefined();
    const inner = iso.children[0];
    expect(inner?.kind === 'render' ? inner.nodes[0]?.reveal?.shape : undefined).toBe('ellipse');
    expect(inner?.kind === 'render' ? inner.nodes[0]?.mask : 'x').toBeUndefined();
  });
});

describe('Farbräume in der Auswertung (17.2)', () => {
  it('nutzt settings.workingColorSpace, wenn die Composition keinen Farbraum setzt', () => {
    expect(evaluateScene(project([], {}, { workingColorSpace: 'linear' }), 'main', 0).colorSpace).toBe('linear');
    expect(evaluateScene(project([], { colorSpace: 'rec709' }, { workingColorSpace: 'linear' }), 'main', 0).colorSpace).toBe('rec709');
    expect(evaluateScene(project([]), 'main', 0).colorSpace).toBe('srgb');
  });

  it('übernimmt outputColorSpace und trennt Frame-Schlüssel danach', () => {
    const plain = evaluateScene(project([]), 'main', 0);
    const srgb = evaluateScene(project([], {}, { outputColorSpace: 'srgb' }), 'main', 0);
    const linear = evaluateScene(project([], {}, { outputColorSpace: 'linear' }), 'main', 0);
    expect(linear.outputColorSpace).toBe('linear');
    const key = (s: typeof plain) => frameKey(s, {}, {}, { width: 1, height: 1 });
    expect(key(srgb)).toBe(key(plain));
    expect(key(linear)).not.toBe(key(plain));
  });
});

describe('zIndex (17.3)', () => {
  it('sortiert Geschwister stabil nach animiertem zIndex', () => {
    const p = project([
      { id: 'a', type: 'rect', width: 1, height: 1, zIndex: { $keyframes: [{ t: 0, v: 0 }, { t: 10, v: 10 }] } },
      { id: 'b', type: 'rect', width: 1, height: 1, zIndex: 5 },
      { id: 'c', type: 'rect', width: 1, height: 1 },
      { id: 'd', type: 'rect', width: 1, height: 1, zIndex: -1 },
    ]);
    expect(evaluateScene(p, 'main', 0).nodes.map((n) => n.id)).toEqual(['d', 'a', 'c', 'b']);
    expect(evaluateScene(p, 'main', 10).nodes.map((n) => n.id)).toEqual(['d', 'c', 'b', 'a']);
  });

  it('sortiert Kinder von Gruppen und bestimmt die Layer-Reihenfolge im Planner', () => {
    const p = project([
      { id: 'top', type: 'rect', width: 1, height: 1, zIndex: 2 },
      s3d('s'),
      { id: 'g', type: 'group', children: [{ id: 'x', type: 'rect', width: 1, height: 1, zIndex: 1 }, { id: 'y', type: 'rect', width: 1, height: 1 }] },
    ]);
    const scene = evaluateScene(p, 'main', 0);
    expect(scene.nodes.find((n) => n.id === 'g')?.children.map((n) => n.id)).toEqual(['y', 'x']);
    expect(describePlan(planFrame(scene, registry))).toEqual(['three:s', 'skia:g+top']);
  });

  it('lässt Arrays ohne zIndex unverändert (gleiche Referenz)', () => {
    const nodes = [{ props: {} }, { props: { zIndex: 0 } }];
    expect(sortByZIndex(nodes)).toBe(nodes);
  });

  it('akzeptiert zIndex im Schema', () => {
    const errors = validateProject(project([{ id: 'r', type: 'rect', width: 1, height: 1, zIndex: { $expr: 'time > 1 ? 3 : 0' } }])).diagnostics.filter((d) => d.severity === 'error');
    expect(errors).toEqual([]);
  });
});

describe('Benannte Events (17.10)', () => {
  const markers = [
    { id: 'hit', time: '2s', kind: 'event', data: { power: 3, label: 'boom', loud: true } },
    { id: 'plain', time: '1s' },
  ];

  it('liefert Zeit und Daten eines Events in Expressions', () => {
    const p = project(
      [
        { id: 'a', type: 'rect', width: 1, height: 1, x: { $expr: 'event("hit")' }, y: { $expr: 'event("hit", "power") * 10' }, opacity: { $expr: 'event("hit", "loud")' } },
        { id: 'b', type: 'rect', width: 1, height: 1, timing: { from: '1s' }, x: { $expr: 'time >= event("hit") ? 100 : 0' } },
      ],
      { markers },
    );
    const at = (f: number) => evaluateScene(p, 'main', f).nodes;
    expect(at(0)[0]?.props).toMatchObject({ x: 2, y: 30, opacity: 1 });
    // Lokale Zeit: b beginnt bei 1 s, das Event liegt lokal bei 1 s.
    expect(at(30)[1]?.props['x']).toBe(0);
    expect(at(60)[1]?.props['x']).toBe(100);
  });

  it('meldet unbekannte Events und Marker ohne kind "event" als Diagnose', () => {
    const p = project([{ id: 'a', type: 'rect', width: 1, height: 1, x: { $expr: 'event("plain")' } }, { id: 'b', type: 'rect', width: 1, height: 1, x: { $expr: 'event("hit", "nope")' } }], { markers });
    const codes = evaluateScene(p, 'main', 0).diagnostics.map((d) => `${d.code}:${d.problem}`);
    expect(codes.some((c) => c.includes('Event "plain" does not exist'))).toBe(true);
    expect(codes.some((c) => c.includes('no data field "nope"'))).toBe(true);
  });
});

describe('sequence (17.10, T9)', () => {
  const clip = (id: string, duration: string, extra: Record<string, unknown> = {}) => ({ id, type: 'rect', width: 320, height: 180, timing: { duration }, ...extra });

  it('spielt Kinder nacheinander ab (harte Schnitte ohne Übergang)', () => {
    const p = project([{ id: 'seq', type: 'sequence', children: [clip('a', '1s'), clip('b', '2s'), clip('c', '1s')] }]);
    const ids = (f: number) => evaluateScene(p, 'main', f).nodes[0]?.children.map((n) => n.id);
    expect(evaluateScene(p, 'main', 0).nodes[0]?.type).toBe('group');
    expect(ids(0)).toEqual(['a']);
    expect(ids(29)).toEqual(['a']);
    expect(ids(30)).toEqual(['b']);
    expect(ids(89)).toEqual(['b']);
    expect(ids(90)).toEqual(['c']);
    expect(ids(120)).toEqual([]);
  });

  it('überlappt bei fade und blendet den neuen Clip über dem stehenden alten ein', () => {
    const p = project([{ id: 'seq', type: 'sequence', between: { type: 'fade', duration: 10, ease: 'linear' }, children: [clip('a', '1s'), clip('b', '1s')] }]);
    // b beginnt 10 Frames vor dem Ende von a (Frame 20).
    const at = (f: number) => evaluateScene(p, 'main', f).nodes[0]?.children ?? [];
    expect(at(19).map((n) => n.id)).toEqual(['a']);
    const mid = at(25);
    expect(mid.map((n) => n.id)).toEqual(['a', 'b']);
    expect(mid[0]?.props['opacity']).toBeUndefined();
    expect(mid[1]?.props['opacity']).toBeCloseTo(0.5, 5);
    expect(at(30).map((n) => n.id)).toEqual(['b']);
    // Gesamtdauer 2 s − 10 Frames: b endet bei Frame 50.
    expect(at(49).map((n) => n.id)).toEqual(['b']);
    expect(at(50)).toEqual([]);
  });

  it('schiebt bei slide-* den alten Clip mit hinaus (Push) und nutzt Übergänge je Lücke', () => {
    const p = project([
      {
        id: 'seq',
        type: 'sequence',
        between: { type: 'fade', duration: 6 },
        transitions: [{ type: 'slide-left', duration: 10, ease: 'linear' }, { type: 'cut' }],
        children: [clip('a', '1s'), clip('b', '1s'), clip('c', '1s')],
      },
    ]);
    const mid = evaluateScene(p, 'main', 25).nodes[0]?.children ?? [];
    expect(mid.map((n) => n.id)).toEqual(['a', 'b']);
    expect(mid[0]?.props['x']).toBeCloseTo(-160, 5);
    expect(mid[1]?.props['x']).toBeCloseTo(160, 5);
    // Zweite Lücke ist ein Schnitt: c beginnt genau am Ende von b (20 + 30 = Frame 50).
    expect(evaluateScene(p, 'main', 49).nodes[0]?.children.map((n) => n.id)).toEqual(['b']);
    expect(evaluateScene(p, 'main', 50).nodes[0]?.children.map((n) => n.id)).toEqual(['c']);
  });

  it('wendet Wipes als Reveal des neuen Clips an und behält eigene Übergänge an den Enden', () => {
    const p = project([
      {
        id: 'seq',
        type: 'sequence',
        between: { type: 'wipe-right', duration: 10 },
        children: [clip('a', '1s', { transition: { in: { type: 'fade', duration: 5 } } }), clip('b', '1s', { transition: { in: { type: 'fade', duration: 5 }, out: { type: 'fade', duration: 5 } } })],
      },
    ]);
    const start = evaluateScene(p, 'main', 0).nodes[0]?.children[0];
    expect(start?.props['opacity']).toBe(0);
    const mid = evaluateScene(p, 'main', 25).nodes[0]?.children ?? [];
    expect(mid[1]?.reveal?.direction).toBe('left');
    expect(mid[1]?.props['opacity']).toBeUndefined();
    const end = evaluateScene(p, 'main', 48).nodes[0]?.children[0];
    expect(end?.id).toBe('b');
    expect(Number(end?.props['opacity'])).toBeLessThan(1);
  });

  it('nimmt die Dauer einer composition-ref aus der verschachtelten Composition', () => {
    const p = {
      schemaVersion: SCHEMA_VERSION,
      compositions: [
        { id: 'main', width: 320, height: 180, fps: 30, duration: '10s', nodes: [{ id: 'seq', type: 'sequence', children: [{ id: 'ref', type: 'composition-ref', composition: 'intro' }, clip('b', '1s')] }] },
        { id: 'intro', width: 320, height: 180, fps: 60, duration: '0.5s', nodes: [] },
      ],
    };
    expect(evaluateScene(p, 'main', 14).nodes[0]?.children.map((n) => n.id)).toEqual(['ref']);
    expect(evaluateScene(p, 'main', 15).nodes[0]?.children.map((n) => n.id)).toEqual(['b']);
  });

  it('meldet Kinder ohne Dauer und ignoriertes timing.from', () => {
    const p = project([{ id: 'seq', type: 'sequence', children: [{ id: 'x', type: 'rect', width: 1, height: 1 }, clip('b', '1s', { timing: { from: 5, duration: '1s' } })] }]);
    const scene = evaluateScene(p, 'main', 0);
    expect(scene.diagnostics.map((d) => d.code)).toEqual(['OV_SEQUENCE_DURATION', 'OV_SEQUENCE_FROM_IGNORED']);
    expect(scene.nodes[0]?.children.map((n) => n.id)).toEqual(['b']);
  });

  it('nutzt transitions[i] der IR auch nach übersprungenen Kindern (Review m5)', () => {
    // Kind x hat keine Dauer und fällt weg; transitions[1] liegt zwischen b und c.
    const p = project([
      {
        id: 'seq',
        type: 'sequence',
        transitions: [{ type: 'cut' }, { type: 'cut' }, { type: 'fade', duration: 10, ease: 'linear' }],
        children: [clip('a', '1s'), { id: 'x', type: 'rect', width: 1, height: 1 }, clip('b', '1s'), clip('c', '1s')],
      },
    ]);
    // a → b: transitions[0] (cut, b ab Frame 30); b → c: transitions[2] (fade 10, c ab Frame 50).
    expect(evaluateScene(p, 'main', 45).nodes[0]?.children.map((n) => n.id)).toEqual(['b']);
    expect(evaluateScene(p, 'main', 55).nodes[0]?.children.map((n) => n.id)).toEqual(['b', 'c']);
  });

  it('ist im Schema gültig und lehnt falsche Übergänge ab', () => {
    const ok = project([{ id: 'seq', type: 'sequence', between: { type: 'fade', duration: '0.5s' }, transitions: [{ type: 'cut' }], children: [clip('a', '1s'), clip('b', '1s')] }]);
    expect(validateProject(ok).diagnostics.filter((d) => d.severity === 'error')).toEqual([]);
    const bad = project([{ id: 'seq', type: 'sequence', between: { type: 'fade' }, children: [] }]);
    expect(validateProject(bad).diagnostics.filter((d) => d.severity === 'error').length).toBeGreaterThan(0);
  });
});

describe('Frame-Schlüssel mit Motion-Blur-Subframes (Review M6)', () => {
  const blender = (position: unknown) => ({ id: 'b', type: 'blender', width: 10, height: 10, motionBlur: true, children: [{ id: 'm', type: 'mesh3d', position }] });

  it('unterscheidet gleiche Zustände am Frame mit anderer Bewegung', () => {
    const moving = project([blender({ $keyframes: [{ t: 0, v: [-3, 0, 0] }, { t: 10, v: [3, 0, 0] }] })]);
    const still = project([blender([0, 0, 0])]);
    const a = evaluateScene(moving, 'main', 5);
    const b = evaluateScene(still, 'main', 5);
    expect(a.nodes[0]?.children[0]?.props['position']).toEqual(b.nodes[0]?.children[0]?.props['position']);
    expect(a.motionKey).toBeDefined();
    expect(frameKey(a, {}, {}, { width: 10, height: 10 })).not.toBe(frameKey(b, {}, {}, { width: 10, height: 10 }));
  });

  it('lässt Szenen ohne Motion Blur und Subframe-Auswertungen ohne motionKey', () => {
    expect(evaluateScene(project([{ id: 'r', type: 'rect', width: 1, height: 1 }]), 'main', 0).motionKey).toBeUndefined();
    expect(evaluateScene(project([blender([0, 0, 0])]), 'main', 5, { motionKey: false }).motionKey).toBeUndefined();
  });

  it('berücksichtigt layer.motionBlur', () => {
    const layer = (x: unknown) => project([{ id: 'l', type: 'layer', motionBlur: { samples: 3, shutter: 0.5 }, children: [{ id: 'r', type: 'rect', width: 1, height: 1, x }] }]);
    const a = evaluateScene(layer({ $keyframes: [{ t: 0, v: 0 }, { t: 10, v: 100 }] }), 'main', 5);
    const b = evaluateScene(layer(50), 'main', 5);
    expect(frameKey(a, {}, {}, { width: 10, height: 10 })).not.toBe(frameKey(b, {}, {}, { width: 10, height: 10 }));
  });
});
