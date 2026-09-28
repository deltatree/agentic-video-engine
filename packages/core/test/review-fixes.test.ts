/**
 * Regressionstests zum Code-Review vom 2026-09-28, Gruppe C (C9–C12).
 */
import { describe, expect, it } from 'vitest';
import { Registry, SCHEMA_VERSION, applyPatches, evaluateScene, isRecord, walkEvaluated, type Patch } from '@agentic-video/core';

const base = (nodes: unknown[]): Record<string, unknown> => ({
  schemaVersion: SCHEMA_VERSION,
  compositions: [{ id: 'main', width: 100, height: 100, fps: 30, duration: 100, nodes }],
});

function countNodes(nodes: Parameters<typeof walkEvaluated>[0]): number {
  let n = 0;
  walkEvaluated(nodes, () => {
    n += 1;
  });
  return n;
}

/** Liest eine Node der ersten Composition. */
function nodeOf(project: Readonly<Record<string, unknown>>, id: string): Record<string, unknown> | undefined {
  const comps = project['compositions'];
  const first: unknown = Array.isArray(comps) ? comps[0] : undefined;
  const nodes: unknown = isRecord(first) ? first['nodes'] : undefined;
  const walk = (list: unknown): Record<string, unknown> | undefined => {
    if (!Array.isArray(list)) return undefined;
    for (const n of list) {
      if (!isRecord(n)) continue;
      if (n['id'] === id) return n;
      const hit = walk(n['children']);
      if (hit !== undefined) return hit;
    }
    return undefined;
  };
  return walk(nodes);
}

describe('C9: Rekursionsgrenze und Knotenbudget', () => {
  it('stoppt exponentielle composition-refs (10 Refs über 8 Ebenen) mit OV_EVAL_NODE_BUDGET', () => {
    const levels = 8;
    const compositions = Array.from({ length: levels + 1 }, (_, level) => ({
      id: `c${String(level)}`,
      width: 10,
      height: 10,
      fps: 30,
      duration: 10,
      nodes:
        level === levels
          ? [{ id: 'leaf', type: 'rect', width: 1, height: 1 }]
          : Array.from({ length: 10 }, (_, i) => ({ id: `r${String(i)}`, type: 'composition-ref', composition: `c${String(level + 1)}` })),
    }));
    const started = performance.now();
    const scene = evaluateScene({ schemaVersion: SCHEMA_VERSION, compositions }, 'c0', 0, { maxNodes: 5_000 });
    expect(performance.now() - started).toBeLessThan(5_000);
    expect(scene.diagnostics.filter((d) => d.code === 'OV_EVAL_NODE_BUDGET')).toHaveLength(1);
    expect(countNodes(scene.nodes)).toBeLessThanOrEqual(5_000);
  });

  it('nutzt ohne Option ein Budget von 100 000 Knoten', () => {
    const children = Array.from({ length: 1000 }, (_, i) => ({ id: `k${String(i)}`, type: 'rect', width: 1, height: 1 }));
    const nodes = Array.from({ length: 101 }, (_, i) => ({ id: `g${String(i)}`, type: 'group', children }));
    const scene = evaluateScene(base(nodes), 'main', 0);
    expect(scene.diagnostics.map((d) => d.code)).toContain('OV_EVAL_NODE_BUDGET');
    expect(countNodes(scene.nodes)).toBeLessThanOrEqual(100_000);
  });

  it('meldet eine selbst-rekursive Komponente mit OV_EVAL_DEPTH statt Stapelüberlauf', () => {
    const registry = new Registry();
    registry.registerComponent({ name: 'Loop', description: 'test', example: {}, expand: () => [{ id: 'again', type: 'component', component: 'Loop' }] });
    const scene = evaluateScene(base([{ id: 'l', type: 'component', component: 'Loop' }]), 'main', 0, { registry });
    expect(scene.diagnostics.map((d) => d.code)).toContain('OV_EVAL_DEPTH');
    expect(countNodes(scene.nodes)).toBeLessThanOrEqual(20);
  });

  it('meldet einen selbst-rekursiven Expander mit OV_EVAL_DEPTH', () => {
    const registry = new Registry();
    registry.registerExpander({ type: 'subtitles', expand: () => [{ id: 's', type: 'subtitles', track: 'captions' }] });
    const scene = evaluateScene(base([{ id: 'sub', type: 'subtitles' }]), 'main', 0, { registry });
    expect(scene.diagnostics.map((d) => d.code)).toContain('OV_EVAL_DEPTH');
  });
});

describe('C10: Fehler in expand', () => {
  it('wird zur Diagnose an der Node; der Rest der Szene bleibt', () => {
    const registry = new Registry();
    registry.registerComponent({
      name: 'Broken',
      description: 'test',
      example: {},
      expand: () => {
        throw new TypeError('kaputt');
      },
    });
    registry.registerExpander({
      type: 'subtitles',
      expand: () => {
        throw new RangeError('auch kaputt');
      },
    });
    const p = base([
      { id: 'a', type: 'component', component: 'Broken' },
      { id: 's', type: 'subtitles' },
      { id: 'ok', type: 'rect', width: 1, height: 1 },
    ]);
    const scene = evaluateScene(p, 'main', 0, { registry });
    expect(scene.nodes.map((n) => n.id)).toEqual(['ok']);
    const errors = scene.diagnostics.filter((d) => d.code === 'OV_COMPONENT_EXPAND');
    expect(errors.map((d) => d.nodeId)).toEqual(['a', 's']);
    expect(errors[0]?.problem).toContain('kaputt');
  });
});

describe('C11: Patch-Umkehrungen', () => {
  it('addKeyframe auf einem verschachtelten Pfad lässt sich vollständig umkehren', () => {
    const project = base([{ id: 'dot', type: 'ellipse', width: 10, height: 10 }]);
    const r = applyPatches(project, [{ op: 'addKeyframe', nodeId: 'dot', property: 'scale.x', keyframe: { t: '1s', v: 2 } }], { validate: false });
    expect(r.ok).toBe(true);
    const back = applyPatches(r.project, r.inverse, { validate: false });
    expect(back.ok).toBe(true);
    expect(JSON.stringify(back.project)).toBe(JSON.stringify(project));
  });

  it('stellt einen alten Wert null wieder her, statt die Property zu löschen', () => {
    const project = { ...base([{ id: 'dot', type: 'ellipse', width: 10, height: 10 }]), metadata: { note: null } };
    const r = applyPatches(project, [{ op: 'setProjectProperty', property: 'metadata.note', value: 'x' }], { validate: false });
    expect(r.ok).toBe(true);
    const back = applyPatches(r.project, r.inverse, { validate: false });
    expect(back.project['metadata']).toEqual({ note: null });
  });

  it('setzt mit keepNull den Wert null, ohne keepNull löscht null weiterhin', () => {
    const project = base([{ id: 'dot', type: 'ellipse', width: 10, height: 10, name: 'n' }]);
    const keep = applyPatches(project, [{ op: 'setProperty', nodeId: 'dot', property: 'name', value: null, keepNull: true }], { validate: false });
    expect(nodeOf(keep.project, 'dot')?.['name']).toBeNull();
    const back = applyPatches(keep.project, keep.inverse, { validate: false });
    expect(nodeOf(back.project, 'dot')?.['name']).toBe('n');
    const removed = applyPatches(project, [{ op: 'setProperty', nodeId: 'dot', property: 'name', value: null }], { validate: false });
    expect(nodeOf(removed.project, 'dot') !== undefined && Object.hasOwn(nodeOf(removed.project, 'dot') ?? {}, 'name')).toBe(false);
  });

  it('lehnt addNode ab, wenn eine ID im neuen Teilbaum schon existiert oder doppelt ist', () => {
    const project = base([{ id: 'dot', type: 'ellipse', width: 10, height: 10 }]);
    const clash: Patch = { op: 'addNode', parentId: null, node: { id: 'g', type: 'group', children: [{ id: 'dot', type: 'rect', width: 1, height: 1 }] } };
    const r = applyPatches(project, [clash], { validate: false });
    expect(r.ok).toBe(false);
    expect(r.diagnostics[0]?.problem).toContain('"dot" already exists');
    const twice: Patch = {
      op: 'addNode',
      parentId: null,
      node: { id: 'g', type: 'group', children: [{ id: 'k', type: 'rect', width: 1, height: 1 }, { id: 'k', type: 'rect', width: 1, height: 1 }] },
    };
    const r2 = applyPatches(project, [twice], { validate: false });
    expect(r2.ok).toBe(false);
    expect(r2.diagnostics[0]?.problem).toContain('"k"');
    const masked: Patch = { op: 'addNode', parentId: null, node: { id: 'm', type: 'rect', width: 1, height: 1, mask: { node: { id: 'dot', type: 'rect', width: 1, height: 1 } } } };
    expect(applyPatches(project, [masked], { validate: false }).ok).toBe(false);
  });
});

describe('C12: Out-Übergang (Befund false)', () => {
  it('ist in stetiger Zeit spiegelsymmetrisch zum In-Übergang: p(t) = p_in(D − t)', () => {
    const p = base([{ id: 'a', type: 'rect', width: 10, height: 10, timing: { from: 0, duration: 30 }, transition: { in: { type: 'fade', duration: 10 }, out: { type: 'fade', duration: 10 } } }]);
    for (const t of [0, 2.5, 5, 7.5]) {
      const din = evaluateScene(p, 'main', t).nodes[0]?.props['opacity'];
      const dout = evaluateScene(p, 'main', 30 - t).nodes[0]?.props['opacity'];
      if (t === 0) expect(dout).toBeUndefined();
      else expect(dout).toBeCloseTo(Number(din), 10);
    }
  });
});
