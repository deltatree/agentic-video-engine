import { describe, expect, it } from 'vitest';
import { importLottie, LOSSY_CODE } from '@agentic-video/importers';
import { find, flatten, problems, validateImport } from './helpers.js';

const staticKs = (p: number[] = [0, 0, 0]) => ({ o: { a: 0, k: 100 }, r: { a: 0, k: 0 }, p: { a: 0, k: p }, a: { a: 0, k: [0, 0, 0] }, s: { a: 0, k: [100, 100, 100] } });

/** Ein selbst gebauter "Loader": Null-Layer mit Rotation, Ring mit Trim Path, Precomp, Hintergrund mit Verlauf. */
const LOADER = {
  v: '5.7.4',
  fr: 30,
  ip: 0,
  op: 90,
  w: 512,
  h: 512,
  nm: 'Loader',
  ddd: 0,
  assets: [
    {
      id: 'comp_0',
      layers: [
        {
          ind: 1,
          ty: 4,
          nm: 'Dot',
          ks: {
            ...staticKs(),
            r: { a: 0, k: 0, x: 'wiggle(2, 5)' },
            p: {
              a: 1,
              k: [
                { t: 0, s: [100, 256], o: { x: 0.5, y: 0 }, i: { x: 0.5, y: 1 } },
                { t: 30, s: [412, 256] },
              ],
            },
          },
          shapes: [
            {
              ty: 'sh',
              nm: 'Diamond',
              ks: {
                a: 0,
                k: {
                  c: true,
                  v: [[0, -10], [10, 0], [0, 10], [-10, 0]],
                  i: [[0, 0], [0, 0], [0, 0], [0, 0]],
                  o: [[0, 0], [0, 0], [0, 0], [0, 0]],
                },
              },
            },
            { ty: 'fl', nm: 'Orange', c: { a: 0, k: [1, 0.5, 0, 1] }, o: { a: 0, k: 80 }, r: 1 },
          ],
          ip: 0,
          op: 60,
          st: 0,
        },
      ],
    },
  ],
  layers: [
    {
      ind: 1,
      ty: 3,
      nm: 'Controller',
      ks: {
        ...staticKs([256, 256, 0]),
        r: {
          a: 1,
          k: [
            { t: 0, s: [0], o: { x: [0.33], y: [0] }, i: { x: [0.67], y: [1] } },
            { t: 60, s: [360] },
          ],
        },
      },
      ip: 0,
      op: 90,
      st: 0,
    },
    {
      ind: 2,
      ty: 4,
      nm: 'Ring',
      parent: 1,
      ks: {
        ...staticKs(),
        o: {
          a: 1,
          k: [
            { t: 0, s: [0], h: 1 },
            { t: 10, s: [100] },
          ],
        },
      },
      shapes: [
        {
          ty: 'gr',
          nm: 'Ring Group',
          it: [
            { ty: 'el', nm: 'Circle', p: { a: 0, k: [0, 0] }, s: { a: 0, k: [200, 200] } },
            { ty: 'st', nm: 'Stroke', c: { a: 0, k: [0.2, 0.4, 1, 1] }, o: { a: 0, k: 100 }, w: { a: 0, k: 12 }, lc: 2, lj: 2 },
            {
              ty: 'tm',
              s: { a: 0, k: 0 },
              e: {
                a: 1,
                k: [
                  { t: 0, s: [0], o: { x: 0.4, y: 0 }, i: { x: 0.2, y: 1 } },
                  { t: 45, s: [100] },
                ],
              },
              o: { a: 0, k: 0 },
              m: 1,
            },
            { ty: 'tr', p: { a: 0, k: [0, 0] }, a: { a: 0, k: [0, 0] }, s: { a: 0, k: [100, 100] }, r: { a: 0, k: 0 }, o: { a: 0, k: 100 } },
          ],
        },
      ],
      ip: 0,
      op: 90,
      st: 0,
    },
    { ind: 3, ty: 0, nm: 'Dots', refId: 'comp_0', w: 512, h: 512, ks: staticKs(), ip: 30, op: 90, st: 20, ef: [{ ty: 5, nm: 'Slider' }] },
    {
      ind: 4,
      ty: 4,
      nm: 'Background',
      ks: staticKs(),
      shapes: [
        { ty: 'rc', nm: 'Panel', p: { a: 0, k: [256, 256] }, s: { a: 0, k: [512, 512] }, r: { a: 0, k: 32 } },
        { ty: 'gf', o: { a: 0, k: 100 }, t: 1, s: { a: 0, k: [0, 0] }, e: { a: 0, k: [512, 0] }, g: { p: 2, k: { a: 0, k: [0, 1, 1, 1, 1, 0, 0, 0] } } },
        { ty: 'sr', nm: 'Star' },
      ],
      ip: 0,
      op: 90,
      st: 0,
    },
  ],
};

describe('importLottie native', () => {
  const result = importLottie(JSON.stringify(LOADER), { mode: 'native', idPrefix: 'loader' });
  const [root] = result.nodes;

  it('produces schema-valid IR', () => {
    expect(validateImport(result.nodes, result.assets)).toEqual([]);
  });

  it('creates a clipped root group with the animation duration and reversed layer order', () => {
    expect(root).toMatchObject({ id: 'loader', type: 'group', width: 512, height: 512, clip: true, timing: { duration: '3s' } });
    const names = (root?.['children'] as Record<string, unknown>[]).map((c) => c['id']);
    // Background liegt unten (zuerst), Ring (in Eltern-Hülle) oben; der Null-Layer zeichnet nichts.
    expect(names).toEqual(['loader-Background', 'loader-Dots', 'loader-parent-1']);
  });

  it('maps parenting to a wrapper with the parent transform and keyframes with cubic-bezier easing', () => {
    const wrapper = find(result.nodes, 'loader-parent-1');
    expect(wrapper).toMatchObject({
      type: 'group',
      origin: { x: 0, y: 0 },
      x: 256,
      y: 256,
      rotation: { $keyframes: [{ t: '0s', v: 0 }, { t: '2s', v: 360, ease: 'cubic-bezier(0.33,0,0.67,1)' }] },
    });
    expect(wrapper).not.toHaveProperty('opacity');
  });

  it('maps hold keyframes and layer timing', () => {
    expect(find(result.nodes, 'loader-Ring')).toMatchObject({
      timing: { from: '0s', duration: '3s' },
      opacity: { $keyframes: [{ t: '0s', v: 0 }, { t: '0.333333s', v: 1, ease: 'hold' }] },
    });
  });

  it('maps ellipse, stroke and trim path', () => {
    expect(find(result.nodes, 'loader-Circle')).toEqual({
      id: 'loader-Circle',
      type: 'ellipse',
      width: 200,
      height: 200,
      x: -100,
      y: -100,
      stroke: '#3366FF',
      strokeWidth: 12,
      strokeCap: 'round',
      strokeJoin: 'round',
      trimEnd: { $keyframes: [{ t: '0s', v: 0 }, { t: '1.5s', v: 1, ease: 'cubic-bezier(0.4,0,0.2,1)' }] },
    });
  });

  it('maps precomps to groups with shifted timing', () => {
    expect(find(result.nodes, 'loader-Dots')).toMatchObject({ timing: { from: '1s', duration: '2s' } });
    // Precomp-Zeit = Layer-Zeit + (ip - st) = lokale Zeit + 10 Frames
    expect(find(result.nodes, 'loader-Dot')).toMatchObject({
      timing: { from: '-0.333333s', duration: '2s' },
      x: { $keyframes: [{ t: '0s', v: 100 }, { t: '1s', v: 412, ease: 'cubic-bezier(0.5,0,0.5,1)' }] },
      y: 256,
    });
    expect(find(result.nodes, 'loader-Diamond')).toEqual({
      id: 'loader-Diamond',
      type: 'path',
      d: 'M0 -10 C0 -10 10 0 10 0 C10 0 0 10 0 10 C0 10 -10 0 -10 0 C-10 0 0 -10 0 -10 Z',
      opacity: 0.8,
      fill: '#FF8000',
    });
  });

  it('maps rectangles with gradient fills in pixel units', () => {
    expect(find(result.nodes, 'loader-Panel')).toEqual({
      id: 'loader-Panel',
      type: 'rect',
      width: 512,
      height: 512,
      cornerRadius: 32,
      fill: { type: 'linear', stops: [{ offset: 0, color: '#FFFFFF' }, { offset: 1, color: '#000000' }], start: { x: 0, y: 0 }, end: { x: 512, y: 0 }, units: 'pixels' },
    });
  });

  it('reports each loss once with OV_IMPORT_LOSSY', () => {
    expect(result.diagnostics.every((d) => d.code === LOSSY_CODE && d.severity === 'warning')).toBe(true);
    const list = problems(result.diagnostics);
    expect(list).toHaveLength(3);
    expect(list.some((p) => p.includes('"Dot"') && p.includes('expressions'))).toBe(true);
    expect(list.some((p) => p.includes('"Dots"') && p.includes('effects'))).toBe(true);
    expect(list.some((p) => p.includes('sr "Star"') && p.includes('Polystar'))).toBe(true);
  });

  it('never produces duplicate ids', () => {
    const ids = flatten(result.nodes).map((n) => n['id']);
    expect(new Set(ids).size).toBe(ids.length);
  });
});

describe('importLottie embed', () => {
  it('creates one lossless lottie node plus asset', () => {
    const text = JSON.stringify(LOADER);
    const { nodes, assets, diagnostics } = importLottie(text, { mode: 'embed', idPrefix: 'loader' });
    expect(nodes).toEqual([{ id: 'loader', type: 'lottie', asset: 'loader-asset', width: 512, height: 512 }]);
    expect(assets[0]?.asset).toMatchObject({ id: 'loader-asset', type: 'lottie', src: 'assets/loader-asset.json' });
    expect(new TextDecoder().decode(assets[0]?.bytes)).toBe(text);
    expect(diagnostics).toEqual([]);
    expect(validateImport(nodes, assets)).toEqual([]);
  });

  it('rejects files without size and frame rate', () => {
    expect(() => importLottie('{"layers":[]}', { mode: 'embed' })).toThrow(/"w", "h" and "fr"/u);
  });
});
