import { describe, expect, it } from 'vitest';
import { validateProject } from '@agentic-video/core';
import {
  all,
  any,
  chain,
  Circle,
  delay,
  easeOutCubic,
  Img,
  Line,
  linear,
  loop,
  makeScene,
  Node,
  Rect,
  sequence,
  toProject,
  Txt,
  waitFor,
  waitUntil,
} from '@agentic-video/motion-canvas-adapter';

type Json = Record<string, unknown>;

function nodesOf(project: Json): Json[] {
  const comp = (project['compositions'] as Json[])[0];
  return (comp?.['nodes'] as Json[] | undefined) ?? [];
}

function find(nodes: readonly Json[], id: string): Json | undefined {
  for (const n of nodes) {
    if (n['id'] === id) return n;
    const hit = find((n['children'] as Json[] | undefined) ?? [], id);
    if (hit !== undefined) return hit;
  }
  return undefined;
}

function times(value: unknown): string[] {
  return (value as { $keyframes: { t: string }[] }).$keyframes.map((k) => k.t);
}

const OPTIONS = { width: 1920, height: 1080, fps: 30 };

describe('makeScene + toProject', () => {
  it('turns the acceptance scenario into keyframes at 0 s, 1 s, 1.5 s and 2.5 s', () => {
    const scene = makeScene('intro', function* (view) {
      const rect = new Rect({ key: 'box', width: 200, height: 100, fill: '#e13238' });
      view.add(rect);
      yield* all(rect.x(300, 1), rect.opacity(0, 1));
      yield* waitFor(0.5);
      yield* rect.x(0, 1);
    });
    const { project, diagnostics } = toProject([scene], OPTIONS);
    expect(diagnostics).toEqual([]);
    expect(validateProject(project).ok).toBe(true);
    const box = find(nodesOf(project), 'intro-box');
    expect(box?.['x']).toEqual({
      $keyframes: [
        { t: '0s', v: 0 },
        { t: '1s', v: 300, ease: 'easeInOutCubic' },
        { t: '1.5s', v: 300, ease: 'hold' },
        { t: '2.5s', v: 0, ease: 'easeInOutCubic' },
      ],
    });
    expect(times(box?.['x'])).toEqual(['0s', '1s', '1.5s', '2.5s']);
    expect(box?.['opacity']).toEqual({ $keyframes: [{ t: '0s', v: 1 }, { t: '1s', v: 0, ease: 'easeInOutCubic' }] });
    expect(find(nodesOf(project), 'intro-box-shape')).toEqual({ id: 'intro-box-shape', type: 'rect', width: 200, height: 100, x: -100, y: -50, fill: '#E13238' });
    expect(nodesOf(project)[0]).toMatchObject({ id: 'intro', type: 'group', x: 960, y: 540, origin: { x: 0, y: 0 }, timing: { from: '0s', duration: '2.5s' } });
    expect((project['compositions'] as Json[])[0]?.['duration']).toBe('2.5s');
  });

  it('runs any, sequence, loop, chain and delay on a symbolic clock', () => {
    const scene = makeScene('flow', function* (view) {
      const a = new Circle({ key: 'a', size: 50, fill: 'white' });
      const b = new Rect({ key: 'b', size: [10, 10], fill: 'red' });
      const c = new Rect({ key: 'c', size: 10, fill: 'blue', opacity: 0 });
      view.add(a, b, c);
      yield* any(a.x(100, 2, linear), waitFor(0.5));
      yield* sequence(0.25, b.opacity(0, 1), c.opacity(1, 1));
      yield* loop(3, (i) => b.rotation(120 * (i + 1), 0.5, linear));
      yield* chain(delay(0.5, () => c.fill('#00ff00')), c.scale.x(2, 1, easeOutCubic));
    });
    const { project, diagnostics } = toProject([scene], OPTIONS);
    expect(diagnostics).toEqual([]);
    expect(validateProject(project).ok).toBe(true);
    const nodes = nodesOf(project);
    // any: wartet nur auf waitFor(0.5); der Tween von a läuft bis 2 s weiter.
    expect(times(find(nodes, 'flow-a')?.['x'])).toEqual(['0s', '2s']);
    // sequence: versetzte Starts bei 0.5 s und 0.75 s
    expect(times(find(nodes, 'flow-b')?.['opacity'])).toEqual(['0s', '0.5s', '1.5s']);
    expect(times(find(nodes, 'flow-c')?.['opacity'])).toEqual(['0s', '0.75s', '1.75s']);
    // loop: drei Drehungen ab 1.75 s
    expect(find(nodes, 'flow-b')?.['rotation']).toEqual({
      $keyframes: [
        { t: '0s', v: 0 },
        { t: '1.75s', v: 0, ease: 'hold' },
        { t: '2.25s', v: 120, ease: 'linear' },
        { t: '2.75s', v: 240, ease: 'linear' },
        { t: '3.25s', v: 360, ease: 'linear' },
      ],
    });
    expect(find(nodes, 'flow-c-shape')?.['fill']).toEqual({ $keyframes: [{ t: '0s', v: '#0000FF' }, { t: '3.75s', v: '#00FF00', ease: 'hold' }] });
    expect(find(nodes, 'flow-c')?.['scale']).toEqual({
      $keyframes: [
        { t: '0s', v: { x: 1, y: 1 } },
        { t: '3.75s', v: { x: 1, y: 1 }, ease: 'hold' },
        { t: '4.75s', v: { x: 2, y: 1 }, ease: 'easeOutCubic' },
      ],
    });
    expect(nodesOf(project)[0]?.['timing']).toEqual({ from: '0s', duration: '4.75s' });
  });

  it('reads signal values at the symbolic time of the reading thread', () => {
    const seen: number[] = [];
    const scene = makeScene('read', function* (view) {
      const rect = new Rect({ size: 10 });
      view.add(rect);
      yield* all(
        rect.x(300, 1, linear),
        (function* () {
          yield* waitFor(0.5);
          seen.push(rect.x());
        })(),
      );
      seen.push(rect.x());
      rect.position([10, 20]);
      seen.push(rect.position().y);
    });
    toProject([scene], OPTIONS);
    expect(seen).toEqual([150, 300, 20]);
  });

  it('exports waitUntil events as markers and uses their durations', () => {
    const scene = makeScene('beats', function* (view) {
      const rect = new Rect({ key: 'r', size: 10, fill: 'white' });
      view.add(rect);
      yield* waitUntil('drop');
      yield* rect.position([100, -50], 1);
    });
    const { project } = toProject([scene, scene], { ...OPTIONS, events: { drop: 0.75 } });
    const comp = (project['compositions'] as Json[])[0];
    expect(comp?.['markers']).toEqual([
      { id: 'drop', time: '0.75s', label: 'drop', kind: 'event' },
      { id: 'drop-2', time: '2.5s', label: 'drop', kind: 'event' },
    ]);
    const nodes = nodesOf(project);
    expect(times(find(nodes, 'beats-r')?.['y'])).toEqual(['0s', '0.75s', '1.75s']);
    // Zweite Szene beginnt nach der ersten.
    expect(nodes[1]).toMatchObject({ id: 'beats-2', timing: { from: '1.75s', duration: '1.75s' } });
    expect(validateProject(project).ok).toBe(true);
  });

  it('centers text, lines and children like Motion Canvas', () => {
    const scene = makeScene('shapes', function* (view) {
      const label = new Txt({ key: 'label', text: 'Hello', fontSize: 40, fill: '#ffffff' });
      const line = new Line({ key: 'line', points: [[-100, 0], [100, 0]], stroke: 'white', lineWidth: 8, end: 0 });
      const group = new Node({ key: 'group', x: -200, children: [new Circle({ key: 'dot', size: 20, fill: 'red', y: 30 })] });
      view.add(label, line, group);
      yield* line.end(1, 1);
    });
    const { project, diagnostics } = toProject([scene], OPTIONS);
    expect(diagnostics).toEqual([]);
    expect(validateProject(project).ok).toBe(true);
    const nodes = nodesOf(project);
    expect(find(nodes, 'shapes-label-shape')).toMatchObject({ type: 'text', text: 'Hello', fontSize: 40, fill: '#FFFFFF', textAlign: 'center', width: 7680, x: -3840, y: -24 });
    expect(find(nodes, 'shapes-line-shape')).toMatchObject({ type: 'polyline', points: [[-100, 0], [100, 0]], stroke: '#FFFFFF', strokeWidth: 8, trimEnd: { $keyframes: [{ t: '0s', v: 0 }, { t: '1s', v: 1, ease: 'easeInOutCubic' }] } });
    expect(find(nodes, 'shapes-group')).toMatchObject({ x: -200, children: [{ id: 'shapes-dot', y: 30 }] });
  });

  it('reports unsupported features as lossy', () => {
    const scene = makeScene('lossy', function* (view) {
      const box = new Rect({ key: 'box', size: 100, fill: 'white', layout: true, shadowBlur: 4 });
      const img = new Img({ key: 'logo', src: 'assets/logo.png' });
      view.add(box, img);
      yield* box.x(100, 1, (t: number) => t * t);
    });
    const { project, diagnostics } = toProject([scene], OPTIONS);
    expect(validateProject(project).ok).toBe(true);
    expect(diagnostics.every((d) => d.code === 'OV_IMPORT_LOSSY' && d.severity === 'warning')).toBe(true);
    const problems = diagnostics.map((d) => d.problem).join('\n');
    expect(problems).toContain('Layout property "layout"');
    expect(problems).toContain('Property "shadowBlur"');
    expect(problems).toContain('Custom timing function');
    expect(problems).toContain('Img without width and height');
    expect(project['assets']).toEqual([{ id: 'lossy-logo-asset', type: 'image', src: 'assets/logo.png' }]);
  });

  it('refuses nodes outside scenes and endless loops', () => {
    expect(() => new Rect()).toThrow(/only be used while a scene runs/u);
    const endless = makeScene('endless', function* () {
      yield* loop(Number.POSITIVE_INFINITY, () => waitFor(1));
    });
    expect(() => toProject([endless], OPTIONS)).toThrow(/finite/u);
  });
});
