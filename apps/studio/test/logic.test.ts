/**
 * Reine Logik des Studios: Ausrichten, Verteilen, Einrasten, IDs, Kurven, Schema-Felder.
 */
import { describe, expect, it } from 'vitest';
import { fieldsFor } from '../src/fields.js';
import { alignDeltas, distributeDeltas, snapMove } from '../src/geometry.js';
import { bezierOf, bezierText, cloneWithNewIds, setNumberAt, topLevel, uniqueId } from '../src/ir.js';
import { locateInText } from '../src/panels/Bottom.js';

const boxes = new Map([
  ['a', { x: 10, y: 10, width: 20, height: 20 }],
  ['b', { x: 50, y: 40, width: 10, height: 30 }],
  ['c', { x: 100, y: 0, width: 40, height: 10 }],
]);

describe('geometry', () => {
  it('aligns to the common left, right, top and bottom edge', () => {
    expect(alignDeltas(boxes, 'left').get('c')).toEqual({ dx: -90, dy: 0 });
    expect(alignDeltas(boxes, 'right').get('a')).toEqual({ dx: 110, dy: 0 });
    expect(alignDeltas(boxes, 'top').get('b')).toEqual({ dx: 0, dy: -40 });
    expect(alignDeltas(boxes, 'bottom').get('c')).toEqual({ dx: 0, dy: 60 });
    expect(alignDeltas(boxes, 'center').get('a')).toEqual({ dx: 55, dy: 0 });
    expect(alignDeltas(boxes, 'middle').get('a')).toEqual({ dx: 0, dy: 15 });
  });

  it('distributes with equal gaps and keeps the outer boxes', () => {
    const d = distributeDeltas(boxes, 'horizontal');
    expect(d.get('a')).toEqual({ dx: 0, dy: 0 });
    expect(d.get('c')).toEqual({ dx: 0, dy: 0 });
    // Spanne 130, belegt 70 → Lücke 30: b beginnt bei 10 + 20 + 30 = 60.
    expect(d.get('b')).toEqual({ dx: 10, dy: 0 });
  });

  it('snaps edges and centers within the threshold only', () => {
    const box = { x: 0, y: 0, width: 40, height: 10 };
    // Linke Kante 97 → 100.
    expect(snapMove(box, 97, 0, [100], [], 5)).toEqual({ dx: 100, dy: 0, lineX: 100 });
    // Rechte Kante 103 → 100.
    expect(snapMove(box, 63, 0, [100], [], 5)).toEqual({ dx: 60, dy: 0, lineX: 100 });
    // Mitte 78 → 80.
    expect(snapMove(box, 58, 0, [80], [], 5)).toEqual({ dx: 60, dy: 0, lineX: 80 });
    expect(snapMove(box, 70, 0, [100], [], 5)).toEqual({ dx: 70, dy: 0 });
    expect(snapMove(box, 0, 44, [], [50], 2)).toEqual({ dx: 0, dy: 45, lineY: 50 });
  });
});

describe('ir helpers', () => {
  const comp = { nodes: [{ id: 'g', type: 'group', children: [{ id: 'child', type: 'rect' }] }, { id: 'solo', type: 'rect' }] };

  it('creates unique ids and fresh ids for copies', () => {
    const taken = new Set(['title', 'title-2']);
    expect(uniqueId('title', taken)).toBe('title-3');
    const copy = cloneWithNewIds(comp.nodes[0] ?? {}, new Set(['g', 'child']));
    expect(copy['id']).toBe('g-copy');
    expect(JSON.stringify(copy)).toContain('child-copy');
    expect(cloneWithNewIds({ id: 'g-copy', type: 'rect' }, new Set(['g-copy']))['id']).toBe('g-copy-2');
  });

  it('drops selected descendants of selected groups', () => {
    expect(topLevel(comp, ['child', 'g', 'solo'])).toEqual(['g', 'solo']);
    expect(topLevel(comp, ['missing'])).toEqual([]);
  });

  it('sets static values directly and keyframed values through a keyframe', () => {
    expect(setNumberAt('n', 'x', 10, 20.004, 3)).toEqual([{ op: 'setProperty', nodeId: 'n', property: 'x', value: 20 }]);
    expect(setNumberAt('n', 'x', { $keyframes: [{ t: 0, v: 0 }] }, 5, 3)).toEqual([{ op: 'addKeyframe', nodeId: 'n', property: 'x', keyframe: { t: 3, v: 5 } }]);
    expect(setNumberAt('n', 'x', { $expr: 'time' }, 5, 3)).toBeUndefined();
  });

  it('reads and writes bezier easings', () => {
    expect(bezierOf('cubic-bezier(0.4, 0, 0.2, 1)')).toEqual([0.4, 0, 0.2, 1]);
    expect(bezierOf('easeInOut')).toEqual([0.42, 0, 0.58, 1]);
    expect(bezierText([0.12345, 0, 1, 1])).toBe('cubic-bezier(0.123, 0, 1, 1)');
  });

  it('locates nodes and properties in project.json text', () => {
    const text = JSON.stringify({ compositions: [{ id: 'main', nodes: [{ id: 'a', type: 'rect' }, { id: 'b', type: 'text', fontSize: 20 }] }] }, null, 2);
    const offset = locateInText(text, { pointer: '/compositions/0/nodes/1/fontSize' });
    expect(offset).toBeDefined();
    expect(text.slice(offset ?? 0).startsWith('"fontSize"')).toBe(true);
    expect(text.slice(locateInText(text, { nodeId: 'a' }) ?? 0).startsWith('"id": "a"')).toBe(true);
    expect(locateInText('<Rect id="hero" />', { nodeId: 'hero' })).toBe(6);
  });
});

describe('schema fields', () => {
  it('derives inspector fields from the node schema', () => {
    const text = new Map(fieldsFor('text').map((f) => [f.name, f]));
    expect(text.get('x')).toMatchObject({ animatable: true, field: { kind: 'number' } });
    expect(text.get('fill')?.field.kind).toBe('color');
    expect(text.get('textAlign')?.field.kind).toBe('enum');
    expect(text.get('scale')).toMatchObject({ animatable: true, field: { kind: 'vec2' } });
    expect(text.get('opacity')?.field).toMatchObject({ kind: 'number', min: 0, max: 1 });
    expect(text.has('children')).toBe(false);
    expect(fieldsFor('unknown-type')).toEqual([]);
  });
});
