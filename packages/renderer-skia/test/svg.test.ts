import { describe, expect, it } from 'vitest';
import { detectDirection, filterMatrix, fitRect, parseSvg, parseSvgTransform, svgColor, svgLength, svgNumbers } from '@agentic-video/renderer-skia';

describe('parseSvg', () => {
  it('builds a tree with merged style attributes, ids and entities', () => {
    const doc = parseSvg(`<?xml version="1.0"?><!DOCTYPE svg><!-- c -->
      <svg xmlns="http://www.w3.org/2000/svg" width="120" height="60" viewBox="0 0 240 120">
        <g id="grp" style="fill: red; stroke:blue" opacity="0.5"><rect id="r" x="1" y="2" width="3" height="4"/></g>
        <text x="5" y="6">A &amp; B &#65;&#x42;</text>
        <title>ignored</title>
      </svg>`);
    expect(doc.width).toBe(120);
    expect(doc.height).toBe(60);
    expect(doc.viewBox).toEqual([0, 0, 240, 120]);
    const g = doc.root.children[0];
    expect(g?.name).toBe('g');
    expect(g?.attrs).toMatchObject({ fill: 'red', stroke: 'blue', opacity: '0.5', id: 'grp' });
    expect(doc.ids.get('r')?.attrs['width']).toBe('3');
    expect(doc.root.children[1]?.text.trim()).toBe('A & B AB');
    expect(doc.unsupported).toEqual([]);
  });

  it('uses the viewBox size without width and height and lists unsupported elements', () => {
    const doc = parseSvg('<svg viewBox="0 0 50 20"><clipPath id="c"/><image href="x.png"/><mask/><filter/><foreignObject/><path d="M0 0"/></svg>');
    expect([doc.width, doc.height]).toEqual([50, 20]);
    // clipPath, image und mask werden seit Story 17.6 gezeichnet.
    expect(doc.unsupported).toEqual(['filter', 'foreignObject']);
  });

  it('never throws on broken markup', () => {
    expect(parseSvg('<svg><g><rect width="1"').root.name).toBe('svg');
    expect(parseSvg('no svg at all').width).toBe(300);
  });
});

describe('svg helpers', () => {
  it('parses transforms', () => {
    expect(parseSvgTransform('translate(10 20)')).toEqual([1, 0, 0, 1, 10, 20]);
    expect(parseSvgTransform('scale(2) translate(1,1)')).toEqual([2, 0, 0, 2, 2, 2]);
    const r = parseSvgTransform('rotate(90 10 10)');
    expect(r.map((v) => Math.round(v * 1e6) / 1e6)).toEqual([0, 1, -1, 0, 20, 0]);
    expect(parseSvgTransform('matrix(1 2 3 4 5 6)')).toEqual([1, 2, 3, 4, 5, 6]);
    expect(parseSvgTransform('skewX(45)')[2]).toBeCloseTo(1, 10);
    expect(parseSvgTransform(undefined)).toEqual([1, 0, 0, 1, 0, 0]);
  });

  it('parses colors, lengths and number lists', () => {
    expect(svgColor('#f00')).toBe('#FF0000FF');
    expect(svgColor('#11223344')).toBe('#11223344');
    expect(svgColor('rgb(255, 0, 0)')).toBe('#FF0000FF');
    expect(svgColor('rgba(0,0,255,0.5)')).toBe('#0000FF80');
    expect(svgColor('Navy')).toBe('#000080FF');
    expect(svgColor('none')).toBeUndefined();
    expect(svgLength('50%', 0, 200)).toBe(100);
    expect(svgLength('12px', 0)).toBe(12);
    expect(svgLength('abc', 7)).toBe(7);
    expect(svgNumbers('0,0 10-5 .5e1')).toEqual([0, 0, 10, -5, 5]);
  });
});

describe('renderer helpers', () => {
  it('fits boxes', () => {
    expect(fitRect('contain', 200, 100, { x: 0, y: 0, width: 100, height: 100 })).toEqual({ x: 0, y: 25, width: 100, height: 50, clip: false });
    expect(fitRect('cover', 200, 100, { x: 0, y: 0, width: 100, height: 100 })).toEqual({ x: -50, y: 0, width: 200, height: 100, clip: true });
    expect(fitRect('fill', 200, 100, { x: 0, y: 0, width: 100, height: 100 })).toEqual({ x: 0, y: 0, width: 100, height: 100, clip: false });
    expect(fitRect('none', 20, 10, { x: 0, y: 0, width: 100, height: 100 })).toEqual({ x: 40, y: 45, width: 20, height: 10, clip: true });
  });

  it('detects the writing direction', () => {
    expect(detectDirection('123 שלום')).toBe('rtl');
    expect(detectDirection('Hello שלום')).toBe('ltr');
    expect(detectDirection('123')).toBe('ltr');
  });

  it('builds CSS filter matrices', () => {
    expect(filterMatrix({ type: 'brightness', amount: 2 })?.slice(0, 5)).toEqual([2, 0, 0, 0, 0]);
    expect(filterMatrix({ type: 'invert', amount: 1 })?.slice(0, 5)).toEqual([-1, 0, 0, 0, 1]);
    expect(filterMatrix({ type: 'grayscale', amount: 0 })?.[0]).toBeCloseTo(1, 10);
    expect(filterMatrix({ type: 'hue-rotate', degrees: 0 })?.[0]).toBeCloseTo(1, 10);
    expect(filterMatrix({ type: 'color-matrix', matrix: [1, 2] })).toBeUndefined();
    expect(filterMatrix({ type: 'blur', radius: 2 })).toBeUndefined();
  });
});
