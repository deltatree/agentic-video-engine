import { describe, expect, it } from 'vitest';
import { importSvg, LOSSY_CODE } from '@agentic-video/importers';
import { find, problems, validateImport } from './helpers.js';

const LOGO = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE svg PUBLIC "-//W3C//DTD SVG 1.1//EN" "http://www.w3.org/Graphics/SVG/1.1/DTD/svg11.dtd">
<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" width="400" height="200" viewBox="0 0 200 100">
  <title>ACME logo</title>
  <style>
    .brand { fill: #3366FF; }
    #badge { stroke: rgb(255, 0, 0); stroke-width: 2 }
  </style>
  <defs>
    <linearGradient id="grad" x1="0" y1="0" x2="1" y2="0">
      <stop offset="0" stop-color="#fff"/>
      <stop offset="100%" stop-color="black" stop-opacity="0.5"/>
    </linearGradient>
    <radialGradient id="glow" gradientUnits="userSpaceOnUse" cx="150" cy="50" r="30">
      <stop offset="0" style="stop-color: yellow"/>
      <stop offset="1" stop-color="orange"/>
    </radialGradient>
    <clipPath id="clip"><circle cx="0" cy="0" r="15"/></clipPath>
    <filter id="blur"><feGaussianBlur stdDeviation="3"/></filter>
    <g id="dot"><circle r="5" fill="red"/></g>
  </defs>
  <rect id="card" class="brand" x="10" y="10" width="80" height="40" rx="6" opacity="0.8"/>
  <rect id="bg" x="0" y="60" width="200" height="40" fill="url(#grad)"/>
  <g id="badge-group" transform="translate(100 50) rotate(45)" clip-path="url(#clip)">
    <ellipse id="badge" cx="0" cy="0" rx="20" ry="10" fill="none"/>
  </g>
  <circle id="glow-dot" cx="150" cy="50" r="30" fill="url(#glow)" filter="url(#blur)"/>
  <path id="rule" d="M10 90 L190 90" stroke="#000" stroke-dasharray="4 2" stroke-linecap="round" fill="none"/>
  <polygon id="arrow" points="0,0 10,0 5,8" transform="matrix(1 0 0 1 180 5)"/>
  <text id="title" x="100" y="30" font-family="Inter, sans-serif" font-size="12" font-weight="bold" text-anchor="middle">Hello <tspan fill="red">World</tspan></text>
  <image id="icon" x="0" y="0" width="10" height="10" href="data:image/png;base64,iVBORw0KGgo="/>
  <image id="remote" href="https://example.com/a.png" width="5" height="5"/>
  <use id="dot-copy" href="#dot" x="20" y="80"/>
  <line id="flat" x1="0" y1="0" x2="10" y2="10" stroke="blue" transform="scale(0 1)"/>
  <foreignObject width="10" height="10"/>
</svg>`;

describe('importSvg', () => {
  const result = importSvg(LOGO, { idPrefix: 'logo' });

  it('produces schema-valid IR', () => {
    expect(validateImport(result.nodes, result.assets)).toEqual([]);
  });

  it('maps the root viewport and viewBox to groups', () => {
    const [root] = result.nodes;
    expect(root).toMatchObject({ id: 'logo', type: 'group', width: 400, height: 200, clip: true });
    const scaler = (root?.['children'] as Record<string, unknown>[])[0];
    expect(scaler).toMatchObject({ type: 'group', scale: { x: 2, y: 2 }, origin: { x: 0, y: 0 } });
  });

  it('maps rect with class style, rx and opacity', () => {
    expect(find(result.nodes, 'logo-card')).toEqual({ id: 'logo-card', type: 'rect', width: 80, height: 40, cornerRadius: 6, x: 10, y: 10, fill: '#3366FF', opacity: 0.8 });
  });

  it('maps a bounding-box linear gradient with stop opacity', () => {
    expect(find(result.nodes, 'logo-bg')?.['fill']).toEqual({
      type: 'linear',
      stops: [
        { offset: 0, color: '#FFFFFF' },
        { offset: 1, color: '#00000080' },
      ],
      start: { x: 0, y: 0 },
      end: { x: 1, y: 0 },
      units: 'relative',
    });
  });

  it('maps a userSpaceOnUse radial gradient to pixels in the node box', () => {
    expect(find(result.nodes, 'logo-glow-dot')).toMatchObject({
      type: 'ellipse',
      x: 120,
      y: 20,
      width: 60,
      height: 60,
      fill: { type: 'radial', center: { x: 30, y: 30 }, radius: 30, units: 'pixels', stops: [{ offset: 0, color: '#FFFF00' }, { offset: 1, color: '#FFA500' }] },
    });
  });

  it('decomposes group transforms and turns clipPath into an alpha mask', () => {
    const group = find(result.nodes, 'logo-badge-group');
    expect(group).toMatchObject({ x: 100, y: 50, rotation: 45, origin: { x: 0, y: 0 } });
    expect(group?.['mask']).toMatchObject({ mode: 'alpha', node: { type: 'ellipse', width: 30, height: 30, x: -15, y: -15, fill: '#000000' } });
    expect(find(result.nodes, 'logo-badge')).toEqual({ id: 'logo-badge', type: 'ellipse', width: 40, height: 20, x: -20, y: -10, fill: 'transparent', stroke: '#FF0000', strokeWidth: 2 });
  });

  it('keeps stroke attributes and uses the bounds corner as transform pivot', () => {
    expect(find(result.nodes, 'logo-rule')).toMatchObject({ type: 'path', d: 'M10 90 L190 90', stroke: '#000000', strokeDash: [4, 2], strokeCap: 'round', fill: 'transparent' });
    expect(find(result.nodes, 'logo-arrow')).toMatchObject({ type: 'polygon', points: [[0, 0], [10, 0], [5, 8]], x: 180, y: 5, fill: '#000000' });
  });

  it('maps text with anchor, weight and family', () => {
    const title = find(result.nodes, 'logo-title');
    expect(title).toMatchObject({ type: 'text', text: 'Hello World', fontFamily: 'Inter', fontWeight: 700, fontSize: 12, textAlign: 'center' });
    const width = Number(title?.['width']);
    expect(Number(title?.['x']) + width / 2).toBeCloseTo(100);
    expect(title?.['y']).toBeCloseTo(30 - 0.9 * 12);
  });

  it('extracts data-URI images as assets', () => {
    expect(find(result.nodes, 'logo-icon')).toMatchObject({ type: 'image', asset: 'logo-icon-asset', width: 10, height: 10, fit: 'contain' });
    expect(result.assets).toHaveLength(1);
    expect(result.assets[0]?.asset).toMatchObject({ id: 'logo-icon-asset', type: 'image', src: 'assets/logo-icon-asset.png' });
    expect(Array.from(result.assets[0]?.bytes ?? [])).toEqual([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  });

  it('resolves <use> with its own offset', () => {
    const use = find(result.nodes, 'logo-dot-copy');
    expect(use).toMatchObject({ type: 'group', x: 20, y: 80 });
    expect(JSON.stringify(use)).toContain('"fill":"#FF0000"');
  });

  it('bakes a non-decomposable transform into a path', () => {
    expect(find(result.nodes, 'logo-flat')).toMatchObject({ type: 'path', d: 'M0 0 L0 10', stroke: '#0000FF' });
  });

  it('reports every loss with OV_IMPORT_LOSSY', () => {
    expect(result.diagnostics.every((d) => d.code === LOSSY_CODE && d.severity === 'warning' && d.suggestions.length > 0)).toBe(true);
    const list = problems(result.diagnostics);
    expect(list).toHaveLength(6);
    expect(list.some((p) => p.includes('circle#glow-dot') && p.includes('SVG filters are not supported'))).toBe(true);
    expect(list.some((p) => p.includes('tspan') && p.includes('merged'))).toBe(true);
    expect(list.some((p) => p.includes('text#title') && p.includes('baseline'))).toBe(true);
    expect(list.some((p) => p.includes('image#remote') && p.includes('not embedded'))).toBe(true);
    expect(list.some((p) => p.includes('line#flat') && p.includes('cannot be decomposed'))).toBe(true);
    expect(list.some((p) => p.includes('foreignObject') && p.includes('not supported'))).toBe(true);
  });
});

describe('importSvg details', () => {
  it('reports unsupported CSS selectors, patterns, masks and markers', () => {
    const { nodes, diagnostics } = importSvg(
      `<svg width="10" height="10"><style>g rect { fill: red } @media print { rect { fill: blue } }</style>
        <defs><pattern id="p" width="2" height="2"/><mask id="m"/><marker id="k"/></defs>
        <rect width="5" height="5" fill="url(#p) green" mask="url(#m)" marker-end="url(#k)"/></svg>`,
    );
    expect(validateImport(nodes)).toEqual([]);
    expect(find(nodes, 'svg-rect-1')?.['fill']).toBe('#008000');
    const list = problems(diagnostics).join('\n');
    expect(list).toContain('"g rect"');
    expect(list).toContain('"@media print"');
    expect(list).toContain('Paint server <pattern>');
    expect(list).toContain('luminance mask');
    expect(list).toContain('marker-end');
  });

  it('decomposes skew and non-uniform scale exactly', () => {
    const { nodes } = importSvg('<svg width="100" height="100"><rect width="10" height="10" transform="translate(5 6) skewX(30) scale(2 3)"/></svg>');
    expect(find(nodes, 'svg-rect-1')).toMatchObject({ x: 5, y: 6, scale: { x: 2, y: 3 }, skew: { x: 30, y: 0 }, origin: { x: 0, y: 0 } });
  });

  it('rejects documents without an svg root', () => {
    expect(() => importSvg('<html/>')).toThrow(/not <svg>/u);
  });
});
