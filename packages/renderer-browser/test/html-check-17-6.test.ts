/**
 * Story 17.6 (HTML-Teil): Canvas-, WebGL-, WebGPU- und Web-Component-Inhalte bleiben ohne Skripte
 * leer; die Prüfung meldet das als Warnung.
 */
import { describe, expect, it } from 'vitest';
import { checkHtmlNode } from '../src/html-check.js';

const codes = (html: string, allowScripts?: boolean): string[] =>
  checkHtmlNode({ id: 'h', type: 'html', width: 10, height: 10, html }, allowScripts === undefined ? {} : { allowScripts }).diagnostics.map((d) => `${d.code}:${d.severity}`);

describe('checkHtmlNode ohne Skripte (17.6)', () => {
  it('warnt bei Canvas, WebGL und WebGPU und benennt die Art', () => {
    expect(codes('<canvas id="c"></canvas>')).toEqual(['OV_HTML_CANVAS_NO_SCRIPTS:warning']);
    const webgl = checkHtmlNode({ id: 'h', type: 'html', html: '<canvas id="c"></canvas><script>c.getContext("webgl2")</script>' });
    expect(webgl.diagnostics.map((d) => d.code)).toEqual(['OV_HTML_SCRIPT', 'OV_HTML_CANVAS_NO_SCRIPTS']);
    expect(webgl.diagnostics[1]?.details).toEqual({ content: 'WebGL canvas' });
    expect(webgl.supported).toBe(true);
    const webgpu = checkHtmlNode({ id: 'h', type: 'html', html: "<CANVAS></CANVAS><script>navigator.gpu.requestAdapter(); c.getContext('webgpu')</script>" });
    expect(webgpu.diagnostics[1]?.details).toEqual({ content: 'WebGPU canvas' });
  });

  it('warnt bei Custom Elements, nicht bei SVG-Tags mit Bindestrich oder deklarativem Shadow DOM', () => {
    const wc = checkHtmlNode({ id: 'h', type: 'html', html: '<my-card title="x"><b>light</b></my-card><x-icon/>' });
    expect(wc.diagnostics.map((d) => d.code)).toEqual(['OV_HTML_WEB_COMPONENTS_NO_SCRIPTS']);
    expect(wc.diagnostics[0]?.details).toEqual({ elements: 'my-card, x-icon' });
    expect(codes('<svg><font-face font-family="x"/><missing-glyph/></svg>')).toEqual([]);
    expect(codes('<my-card><template shadowrootmode="open"><p>ok</p></template></my-card>')).toEqual([]);
    expect(codes('<p data-x="a-b">plain-text <span>x</span></p>')).toEqual([]);
  });

  it('meldet nichts davon, wenn Skripte erlaubt sind', () => {
    expect(codes('<canvas></canvas><my-card></my-card>', true)).toEqual([]);
  });
});
