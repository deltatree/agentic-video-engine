import { describe, expect, it } from 'vitest';
import { OpenVideoError, validateProject } from '@agentic-video/core';
import {
  AudioClip,
  AudioTrack,
  Box,
  Circle,
  Group,
  Marker,
  Rect,
  Scene,
  Text,
  ThreeScene,
  animate,
  component,
  composition,
  project,
  spring,
  toIR,
  type SdkElement,
  type SceneFrame,
} from '@agentic-video/sdk';
import { jsx, jsxs } from '@agentic-video/sdk/jsx-runtime';
import { jsxDEV } from '@agentic-video/sdk/jsx-dev-runtime';

const base = { width: 320, height: 180, fps: 10, duration: 5 };
const comp = (scene: SdkElement | ((f: SceneFrame) => SdkElement)) => toIR(composition({ ...base, scene }));
const nodes = (scene: SdkElement | ((f: SceneFrame) => SdkElement)): Record<string, unknown>[] => comp(scene).compositions[0]!.nodes;

/** Liest einen verschachtelten Wert aus Testdaten. */
function at(value: unknown, ...path: (string | number)[]): unknown {
  let cur: unknown = value;
  for (const key of path) cur = cur !== null && typeof cur === 'object' ? (cur as Record<string | number, unknown>)[key] : undefined;
  return cur;
}


function expectCode(fn: () => unknown, code: string): OpenVideoError {
  try {
    fn();
  } catch (error) {
    expect(error).toBeInstanceOf(OpenVideoError);
    expect((error as OpenVideoError).diagnostic.code).toBe(code);
    return error as OpenVideoError;
  }
  throw new Error(`expected ${code}`);
}

describe('toIR sampling', () => {
  it('samples changing values per frame and keeps constants literal', () => {
    const [rect] = nodes(({ frame }) => jsx(Scene, { children: jsx(Rect, { id: 'r', x: frame * 2, y: 7, width: 10, height: 10 }) }));
    expect(rect!.x).toEqual({ $sampled: { start: 0, values: [0, 2, 4, 6, 8] } });
    expect(rect!.y).toBe(7);
    expect(rect!.width).toBe(10);
  });

  it('keeps animation data literal when it is the same in every frame', () => {
    const [rect] = nodes(() => jsx(Rect, { x: animate(0, 100, { to: 4 }), width: 1, height: 1 }));
    expect(rect!.x).toEqual({ $keyframes: [{ t: 0, v: 0 }, { t: 4, v: 100 }] });
  });

  it('adds sampled visibility for nodes that exist only in some frames', () => {
    const ns = nodes(({ frame }) => jsxs(Scene, { children: [jsx(Rect, { id: 'a', width: 1, height: 1 }), frame >= 2 && jsx(Text, { id: 't', text: 'Hi' })] }));
    expect(ns.map((n) => n.id)).toEqual(['a', 't']);
    expect(ns[1]!.visible).toEqual({ $sampled: { start: 0, values: [false, false, true, true, true] } });
    expect(ns[0]!.visible).toBeUndefined();
  });

  it('fails with OV_SDK_UNSTABLE_TREE when an id changes its type', () => {
    const error = expectCode(() => nodes(({ frame }) => (frame < 3 ? jsx(Rect, { id: 'x', width: 1, height: 1 }) : jsx(Text, { id: 'x', text: 'a' }))), 'OV_SDK_UNSTABLE_TREE');
    expect(error.diagnostic.frame).toBe(3);
  });

  it('samples in node-local frames when the node has timing.from', () => {
    const [rect] = nodes(({ frame }) => jsx(Rect, { id: 'r', timing: { from: 2 }, x: frame, width: 1, height: 1 }));
    expect(rect!.x).toEqual({ $sampled: { start: 0, values: [2, 3, 4] } });
  });

  it('evaluates Remotion-style springs to numbers and clamps overshoot with a warning', () => {
    const warnings: string[] = [];
    const ir = toIR(composition({ ...base, duration: 30, scene: ({ frame }) => jsx(Rect, { id: 'r', width: 1, height: 1, opacity: spring({ frame }) }) }), { onDiagnostic: (d) => warnings.push(d.code) });
    const values = at(ir, 'compositions', 0, 'nodes', 0, 'opacity', '$sampled', 'values') as number[];
    expect(values[0]).toBe(0);
    expect(Math.max(...values)).toBeLessThanOrEqual(1);
    expect(warnings).toEqual(['OV_SDK_CLAMPED']);
    expect(validateProject(ir).ok).toBe(true);
  });

  it('computes spring({ frame, fps }) outside of scenes and needs fps otherwise', () => {
    expect(spring({ frame: 0, fps: 30 })).toBe(0);
    expect(spring({ frame: 300, fps: 30, from: 10, to: 20 })).toBeCloseTo(20, 3);
    expectCode(() => spring({ frame: 3 }), 'OV_SDK_SPRING_FPS');
    expect(spring({ from: 0, to: 1, at: 5 })).toEqual({ $spring: { from: 0, to: 1, at: 5 } });
  });

  it('calls the sample hook for every frame', () => {
    const seen: number[] = [];
    toIR(composition({ ...base, scene: () => jsx(Rect, { width: 1, height: 1 }) }), { sample: (f) => seen.push(f) });
    expect(seen).toEqual([0, 1, 2, 3, 4]);
  });
});

describe('toIR elements and aliases', () => {
  it('gives stable ids from type and tree position', () => {
    const ns = nodes(jsxs(Scene, { children: [jsx(Text, { text: 'a' }), jsx(Text, { text: 'b' }), jsxs(Group, { children: [jsx(Rect, { width: 1, height: 1 })] })] }));
    expect(ns.map((n) => n.id)).toEqual(['text-1', 'text-2', 'group-1']);
    expect(at(ns, 2, 'children', 0, 'id')).toBe('group-1-rect-1');
  });

  it('applies font, Circle and 3D rotation aliases', () => {
    const ns = nodes(jsxs(Scene, { children: [jsx(Text, { text: 'a', font: 'Inter' }), jsx(Circle, { radius: 5 })] }));
    expect(ns[0]!.fontFamily).toBe('Inter');
    expect(ns[1]).toMatchObject({ type: 'ellipse', width: 10, height: 10 });
    const ir = comp(jsx(Scene, { children: jsx(ThreeScene, { children: jsx(Box, { width: 2, rotationY: 45 }) }) }));
    const box = at(ir, 'compositions', 0, 'nodes', 0, 'children', 0);
    expect(box).toMatchObject({ type: 'mesh3d', rotation: [0, 45, 0], geometry: { type: 'box', width: 2 } });
  });

  it('stores jsxDEV source positions in meta.source', () => {
    const [text] = nodes(jsxDEV(Text, { text: 'a' }, undefined, false, { fileName: 'video.tsx', lineNumber: 12, columnNumber: 3 }));
    expect(text!.meta).toEqual({ source: { file: 'video.tsx', line: 12, column: 3 } });
  });

  it('lifts markers and audio tracks and declares audio assets', () => {
    const ir = comp(jsxs(Scene, { children: [jsx(Marker, { id: 'drop', time: '1s' }), jsx(AudioTrack, { role: 'music', children: jsx(AudioClip, { src: './music.mp3', start: 0 }) })] }));
    const c = ir.compositions[0]!;
    expect(c.markers).toEqual([{ id: 'drop', time: '1s' }]);
    expect(c.tracks).toEqual([{ id: 'audio-1', kind: 'audio', role: 'music', clips: [{ id: 'audio-1-clip-1', source: 'music', start: 0 }] }]);
    expect(ir.assets).toEqual([{ id: 'music', type: 'audio', src: './music.mp3' }]);
    expect(validateProject(ir).ok).toBe(true);
  });

  it('splits component props into node fields and component props', () => {
    const LowerThird = component('LowerThird');
    const [n] = nodes(jsx(LowerThird, { id: 'lt', x: 10, title: 'Ada' }));
    expect(n).toEqual({ id: 'lt', type: 'component', x: 10, component: 'LowerThird', props: { title: 'Ada' } });
  });

  it('rejects functions and non-finite numbers as property values', () => {
    expectCode(() => nodes(jsx(Rect, { width: 1, height: 1, x: () => 1 } as unknown as Parameters<typeof Rect>[0])), 'OV_SDK_INVALID_PROP');
    expectCode(() => nodes(jsx(Rect, { width: 1, height: 1, x: Number.NaN })), 'OV_SDK_INVALID_PROP');
  });

  it('rejects unknown elements and text children', () => {
    expectCode(() => nodes({ type: 'Nope', props: {} }), 'OV_SDK_UNKNOWN_ELEMENT');
    expectCode(() => nodes(jsx(Group, { children: 'hello' as unknown as SdkElement })), 'OV_SDK_INVALID_CHILD');
  });

  it('builds projects with several compositions', () => {
    const a = composition({ ...base, id: 'intro', scene: jsx(Rect, { width: 1, height: 1 }) });
    const b = composition({ ...base, scene: jsx(Rect, { width: 1, height: 1 }) });
    const ir = toIR(project({ compositions: [a, b], metadata: { title: 'T' } }));
    expect(ir.compositions.map((c) => c.id)).toEqual(['intro', 'composition-2']);
    expect(ir.metadata).toEqual({ title: 'T' });
  });
});
