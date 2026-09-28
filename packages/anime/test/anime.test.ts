import { describe, expect, it } from 'vitest';
import { validateProject } from '@agentic-video/core';
import { animate, applyTimeline, createTimeline, cubicBezier, LOSSY_CODE, mapEase, spring, stagger, steps, utils } from '@agentic-video/anime';

const project = {
  schemaVersion: '1.0.0',
  compositions: [
    {
      id: 'main',
      width: 1280,
      height: 720,
      fps: 30,
      duration: '4s',
      nodes: [
        { id: 'a', type: 'rect', x: 100, y: 50, width: 100, height: 100, fill: '#FF0000' },
        { id: 'b', type: 'rect', width: 100, height: 100, opacity: 0.5 },
        { id: 'c', type: 'text', text: 'Hello' },
        {
          id: 'list',
          type: 'group',
          children: [
            { id: 'i1', type: 'rect', y: 10, width: 10, height: 10 },
            { id: 'i2', type: 'rect', y: 10, width: 10, height: 10 },
            { id: 'i3', type: 'rect', y: 10, width: 10, height: 10 },
          ],
        },
      ],
    },
  ],
};

function valueOf(patches: readonly { op: string }[], nodeId: string, property: string): unknown {
  const hit = patches.find((p) => 'nodeId' in p && p.nodeId === nodeId && 'property' in p && p.property === property);
  return hit !== undefined && 'value' in hit ? hit.value : undefined;
}

describe('createTimeline', () => {
  it('places three entries with relative positions at the expected keyframe times', () => {
    const tl = createTimeline({ defaults: { duration: 500 } })
      .add('a', { x: 200, ease: 'inOutQuad' })
      .add('#b', { opacity: [0, 1] }, '-=100')
      .add('c', { rotate: '1turn', duration: 1000 }, '<<+=50');
    const { patches, diagnostics } = tl.compile(project);
    expect(diagnostics).toEqual([]);
    expect(tl.duration).toBe(1450);
    // x ist relativ zum Basiswert 100 der Node.
    expect(valueOf(patches, 'a', 'x')).toEqual({ $keyframes: [{ t: '0ms', v: 100 }, { t: '500ms', v: 300, ease: 'easeInOutQuad' }] });
    expect(valueOf(patches, 'b', 'opacity')).toEqual({ $keyframes: [{ t: '400ms', v: 0 }, { t: '900ms', v: 1, ease: 'easeOutQuad' }] });
    expect(valueOf(patches, 'c', 'rotation')).toEqual({ $keyframes: [{ t: '450ms', v: 0 }, { t: '1450ms', v: 360, ease: 'easeOutQuad' }] });
  });

  it('supports "<", labels and label offsets', () => {
    const tl = createTimeline({ defaults: { duration: 300 } })
      .add('a', { opacity: 0 })
      .label('intro')
      .add('b', { opacity: 1 }, 1000)
      .add('c', { opacity: 0 }, '<')
      .add('i1', { opacity: 0 }, 'intro+=20');
    const patches = tl.toPatches(project);
    expect(valueOf(patches, 'c', 'opacity')).toMatchObject({ $keyframes: [{ t: '1300ms' }, { t: '1600ms' }] });
    expect(valueOf(patches, 'i1', 'opacity')).toMatchObject({ $keyframes: [{ t: '320ms' }, { t: '620ms' }] });
    expect(() => createTimeline().add('a', { x: 1 }, 'missing')).toThrow(/Unknown timeline position/u);
  });

  it('distributes delays with stagger', () => {
    const tl = createTimeline().add(['i1', 'i2', 'i3'], { y: [20, 0], duration: 400, ease: 'linear', delay: stagger(100, { start: 50 }) });
    const patches = tl.toPatches(project);
    expect(valueOf(patches, 'i1', 'y')).toEqual({ $keyframes: [{ t: '50ms', v: 30 }, { t: '450ms', v: 10, ease: 'linear' }] });
    expect(valueOf(patches, 'i2', 'y')).toEqual({ $keyframes: [{ t: '150ms', v: 30 }, { t: '550ms', v: 10, ease: 'linear' }] });
    expect(valueOf(patches, 'i3', 'y')).toEqual({ $keyframes: [{ t: '250ms', v: 30 }, { t: '650ms', v: 10, ease: 'linear' }] });
    const center = stagger(100, { from: 'center' });
    expect([0, 1, 2, 3, 4].map((i) => center('x', i, 5))).toEqual([200, 100, 0, 100, 200]);
    expect([0, 1, 2].map((i) => stagger(10, { from: 'last' })('x', i, 3))).toEqual([20, 10, 0]);
    expect([0, 1, 2].map((i) => stagger([0, 100])('x', i, 3))).toEqual([0, 50, 100]);
    expect([0, 1, 2].map((i) => stagger(10, { from: 1 })('x', i, 3))).toEqual([10, 0, 10]);
  });

  it('evaluates function values per target', () => {
    const tl = createTimeline().add(['i1', 'i2'], { opacity: (_t: string, i: number) => i * 0.5, duration: (_t: string, i: number) => 100 * (i + 1) });
    const patches = tl.toPatches(project);
    expect(valueOf(patches, 'i2', 'opacity')).toMatchObject({ $keyframes: [{ t: '0ms', v: 1 }, { t: '200ms', v: 0.5 }] });
  });

  it('applies the timeline through applyPatches with a valid result', () => {
    const tl = createTimeline().add('a', { x: 50, scale: 1.5, fill: '#00F' }).add('c', { opacity: [0, 1] });
    const result = applyTimeline(project, tl);
    expect(result.ok).toBe(true);
    expect(validateProject(result.project).ok).toBe(true);
    const comp = (result.project['compositions'] as { nodes: Record<string, unknown>[] }[])[0];
    expect(comp?.nodes[0]?.['scale']).toEqual({ $keyframes: [{ t: '0ms', v: { x: 1, y: 1 } }, { t: '1000ms', v: { x: 1.5, y: 1.5 }, ease: 'easeOutQuad' }] });
    expect(comp?.nodes[0]?.['fill']).toMatchObject({ $keyframes: [{ v: '#FF0000' }, { v: '#0000FF' }] });
    expect(result.inverse.length).toBeGreaterThan(0);
  });
});

describe('animate', () => {
  it('maps property keyframe arrays to consecutive segments', () => {
    const patches = animate('a', { x: [{ to: 50, duration: 200 }, { to: 0, duration: 300, ease: 'linear' }] }).toPatches(project);
    expect(valueOf(patches, 'a', 'x')).toEqual({
      $keyframes: [
        { t: '0ms', v: 100 },
        { t: '200ms', v: 150, ease: 'easeOutQuad' },
        { t: '500ms', v: 100, ease: 'linear' },
      ],
    });
  });

  it('maps loop and alternate to keyframe repeat', () => {
    const patches = animate('a', { scale: [1, 1.5], loop: 2, alternate: true, duration: 400, ease: 'linear' }).toPatches(project);
    expect(valueOf(patches, 'a', 'scale')).toEqual({
      $keyframes: [{ t: '0ms', v: { x: 1, y: 1 } }, { t: '400ms', v: { x: 1.5, y: 1.5 }, ease: 'linear' }],
      loop: 'pingpong',
      repeat: 3,
    });
    expect(valueOf(animate('b', { opacity: 0, loop: true }).toPatches(project), 'b', 'opacity')).toMatchObject({ loop: 'repeat', repeat: 'infinite' });
  });

  it('plays reversed tweens backwards with the mirrored easing', () => {
    const patches = animate('b', { opacity: [0, 1], reversed: true, ease: 'inCubic' }).toPatches(project);
    expect(valueOf(patches, 'b', 'opacity')).toEqual({ $keyframes: [{ t: '0ms', v: 1 }, { t: '1000ms', v: 0, ease: 'easeOutCubic' }] });
  });

  it('handles units, relative values and scaleX', () => {
    const patches = animate('a', { rotate: '0.5turn', y: '+=30', scaleX: 2, duration: 100, ease: 'linear' }).toPatches(project);
    expect(valueOf(patches, 'a', 'rotation')).toMatchObject({ $keyframes: [{ v: 0 }, { v: 180 }] });
    expect(valueOf(patches, 'a', 'y')).toMatchObject({ $keyframes: [{ v: 50 }, { v: 80 }] });
    expect(valueOf(patches, 'a', 'scale')).toMatchObject({ $keyframes: [{ v: { x: 1, y: 1 } }, { v: { x: 2, y: 1 } }] });
  });

  it('reports every loss and ignored parameter', () => {
    const tl = animate(['a', '.card', 'ghost'], { x: '10%', rotateX: 45, opacity: 0, autoplay: true, onComplete: () => undefined, ease: 'outElastic(1, .5)' });
    const { diagnostics } = tl.compile(project);
    const codes = diagnostics.map((d) => `${d.code}:${d.severity}:${d.path ?? ''}`);
    expect(codes).toContain('OV_ANIME_IGNORED:info:timeline[0].autoplay');
    expect(codes).toContain(`${LOSSY_CODE}:warning:timeline[0].onComplete`);
    expect(codes).toContain(`${LOSSY_CODE}:warning:timeline[0].targets`);
    expect(codes).toContain(`${LOSSY_CODE}:warning:timeline[0].x`);
    expect(codes).toContain(`${LOSSY_CODE}:warning:timeline[0].rotateX`);
    expect(codes).toContain(`${LOSSY_CODE}:warning:timeline[0].ease`);
    expect(codes).toContain(`${LOSSY_CODE}:warning:targets.ghost`);
  });

  it('cuts overlapping tweens on the same property with a diagnostic', () => {
    const tl = createTimeline().add('b', { opacity: [0, 1], duration: 1000, ease: 'linear' }).add('b', { opacity: 0, duration: 500, ease: 'linear' }, 500);
    const { patches, diagnostics } = tl.compile(project);
    expect(valueOf(patches, 'b', 'opacity')).toEqual({
      $keyframes: [
        { t: '0ms', v: 0 },
        { t: '500ms', v: 0.5, ease: 'linear' },
        { t: '1000ms', v: 0, ease: 'linear' },
      ],
    });
    expect(diagnostics.map((d) => d.problem).join()).toContain('overlaps');
  });
});

describe('easing and utils', () => {
  it('maps Anime.js easings to OpenVideo easings', () => {
    expect(mapEase('inOutQuad', 'e')).toEqual({ ease: 'easeInOutQuad', diagnostics: [] });
    expect(mapEase('easeOutBounce', 'e').ease).toBe('easeOutBounce');
    expect(mapEase(cubicBezier(0.4, 0, 0.2, 1), 'e').ease).toBe('cubic-bezier(0.4,0,0.2,1)');
    expect(mapEase(steps(4), 'e').ease).toBe('steps(4,end)');
    expect(mapEase(spring({ stiffness: 200, damping: 12 }), 'e')).toEqual({ ease: 'spring(200,12,1)', diagnostics: [] });
    const out3 = mapEase('out(3)', 'e');
    expect(out3.ease).toBe('easeOutCubic');
    expect(out3.diagnostics).toHaveLength(1);
    const approx = mapEase('out', 'e');
    expect(approx.ease).toBe('easeOutQuad');
    expect(approx.diagnostics[0]?.code).toBe(LOSSY_CODE);
    const unknown = mapEase('wobble', 'e');
    expect(unknown.ease).toBe('linear');
    expect(unknown.diagnostics[0]).toMatchObject({ code: LOSSY_CODE, severity: 'warning' });
    expect(mapEase((t: number) => t, 'e').ease).toBe('linear');
  });

  it('draws deterministic random numbers', () => {
    expect(utils.random(0, 100, 0, 42, 'a')).toBe(utils.random(0, 100, 0, 42, 'a'));
    const r1 = utils.createSeededRandom(7);
    const r2 = utils.createSeededRandom(7);
    const a = [r1(0, 1, 3), r1(0, 1, 3), r1(0, 1, 3)];
    expect([r2(0, 1, 3), r2(0, 1, 3), r2(0, 1, 3)]).toEqual(a);
    expect(new Set(a).size).toBeGreaterThan(1);
    expect(a.every((v) => v >= 0 && v <= 1)).toBe(true);
  });
});
