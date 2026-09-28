import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { EvaluatedNode, RgbaImage } from '@agentic-video/core';
import { encodePng } from '@agentic-video/png';
import { createBrowserHost, type BrowserHost } from '../src/host.js';
import type { BrowserLayerPayload } from '../src/protocol.js';
import { buildRuntime, expectGolden, hashImage, memoryAssets, node, pixel, testFonts, TEST_FONT } from './helpers.js';

const W = 320;
const H = 180;
const FPS = 30;
const FONT = `font-family:'${TEST_FONT}';`;

function payload(nodes: EvaluatedNode[], frame: number, extra: Partial<BrowserLayerPayload> = {}): BrowserLayerPayload {
  return { nodes, width: W, height: H, scale: 1, frame, time: frame / FPS, fps: FPS, seed: 7, ...extra };
}

function html(id: string, frame: number, props: Record<string, unknown>, extra: Partial<EvaluatedNode> = {}): EvaluatedNode {
  return node(id, 'html', { width: W, height: H, ...props }, frame, 60, extra);
}

let host: BrowserHost;

async function render(nodes: EvaluatedNode[], frame: number, extra: Partial<BrowserLayerPayload> = {}): Promise<RgbaImage> {
  return host.render('html', payload(nodes, frame, extra));
}

beforeAll(async () => {
  buildRuntime();
  const blue = new Uint8Array(4 * 4 * 4).map((_, i) => (i % 4 === 2 || i % 4 === 3 ? 255 : 0));
  host = await createBrowserHost({ assets: memoryAssets({ dot: { path: 'store/dot.png', bytes: encodePng({ width: 4, height: 4, data: blue }) } }), fonts: testFonts(), width: W, height: H, allowHtmlScripts: true });
});

afterAll(async () => {
  await host.close();
});

describe('Golden: HTML-Layer', () => {
  it('CSS-Transforms und Node-Matrix', async () => {
    const inner = html('transforms', 0, {
      width: 200,
      height: 120,
      x: 60,
      y: 30,
      rotation: 10,
      scale: { x: 0.9, y: 0.9 },
      html: '<div class="a"></div><div class="b"></div><div class="c"></div>',
      css: '.a,.b,.c{position:absolute;width:50px;height:50px;top:35px}.a{left:10px;background:#e63946;transform:rotate(30deg)}.b{left:75px;background:#457b9d;transform:skewX(20deg) scale(0.8)}.c{left:140px;background:#2a9d8f;transform:perspective(120px) rotateY(45deg)}body{outline:2px solid #1d3557;outline-offset:-2px}',
    });
    expectGolden('transforms', await render([inner], 0));
  });

  it('Filter, Schatten und Blend Mode im Layer', async () => {
    const base = html('base', 0, { html: '<div style="position:absolute;left:20px;top:20px;width:280px;height:140px;background:linear-gradient(90deg,#ffbe0b,#3a86ff)"></div>' });
    const filtered = html('filtered', 0, {
      width: 140,
      height: 100,
      x: 30,
      y: 40,
      html: '<div style="margin:20px;width:100px;height:60px;background:#ff006e;filter:saturate(0.5)"></div>',
      filters: [
        { type: 'blur', radius: 2 },
        { type: 'hue-rotate', degrees: 90 },
        { type: 'color-matrix', matrix: [0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 0, 0, 0, 0, 1, 0] },
      ],
      shadow: { color: 'rgba(0,0,0,0.6)', blur: 4, offsetX: 6, offsetY: 6 },
    });
    const blended = html('blended', 0, { width: 120, height: 120, x: 180, y: 30, blendMode: 'multiply', opacity: 0.8, html: '<div style="width:120px;height:120px;border-radius:50%;background:#8338ec"></div>' });
    expectGolden('filters-blend', await render([base, filtered, blended], 0));
  });

  it('CSS-Masken, clip-path und Reveal', async () => {
    const masked = html('masked', 0, {
      html: '<div class="m"></div><div class="c"></div>',
      css: '.m{position:absolute;left:10px;top:20px;width:140px;height:140px;background:#06d6a0;-webkit-mask-image:radial-gradient(circle,#000 40%,transparent 70%);mask-image:radial-gradient(circle,#000 40%,transparent 70%)}.c{position:absolute;left:170px;top:20px;width:140px;height:140px;background:#ef476f;clip-path:polygon(50% 0,100% 100%,0 100%)}',
    });
    const revealed = html('revealed', 0, { width: 100, height: 40, x: 110, y: 130, html: '<div style="width:100px;height:40px;background:#118ab2"></div>' }, { reveal: { shape: 'rect', direction: 'left', progress: 0.5 } });
    expectGolden('masks', await render([masked, revealed], 0));
  });

  it('Verläufe (linear, radial, konisch)', async () => {
    const n = html('gradients', 0, {
      html: '<div class="l"></div><div class="r"></div><div class="c"></div>',
      css: 'div{position:absolute;top:30px;width:90px;height:120px}.l{left:10px;background:linear-gradient(135deg,#f72585,#4cc9f0)}.r{left:115px;background:radial-gradient(circle at 30% 30%,#fff,#7209b7 70%,transparent 71%)}.c{left:220px;border-radius:50%;height:90px;background:conic-gradient(red,yellow,lime,aqua,blue,magenta,red)}',
    });
    expectGolden('gradients', await render([n], 0));
  });

  it('Typografie mit Webfont aus dem FontResolver', async () => {
    const n = html('typography', 0, {
      html: `<p class="a">Agentic Video</p><p class="b">Kerning AVA · ffi · 0123</p><p class="c">Light 300 &amp; Black 900</p>`,
      css: `body{${FONT}color:#111;padding:10px}p{margin:4px 0}.a{font-size:36px;font-weight:800;letter-spacing:-1px}.b{font-size:22px;font-weight:400}.c{font-size:20px;font-weight:300}.c::after{content:' ✓';font-weight:900}`,
      background: '#fdfcdc',
    });
    expectGolden('typography', await render([n], 0));
  });

  it('SVG', async () => {
    const n = html('svg', 0, {
      html: '<svg width="320" height="180" viewBox="0 0 320 180"><defs><linearGradient id="g"><stop offset="0" stop-color="#ff9f1c"/><stop offset="1" stop-color="#2ec4b6"/></linearGradient></defs><path d="M20 160 C 80 10, 160 10, 300 160" stroke="url(#g)" stroke-width="12" fill="none" stroke-linecap="round"/><circle cx="160" cy="90" r="30" fill="#e71d36" fill-opacity="0.7"/><rect x="230" y="20" width="60" height="40" rx="8" fill="none" stroke="#011627" stroke-dasharray="6 4" stroke-width="3"/></svg>',
    });
    expectGolden('svg', await render([n], 0));
  });

  it('Canvas-2D-Skript mit window.openvideo', async () => {
    const n = html('canvas2d', 12, {
      html: `<canvas id="c" width="320" height="180"></canvas><script>
        const ctx = c.getContext('2d');
        openvideo.onFrame(({ time, frame }) => {
          ctx.clearRect(0, 0, 320, 180);
          ctx.fillStyle = '#3a0ca3';
          ctx.fillRect(20 + time * 200, 40, 60, 60);
          ctx.beginPath(); ctx.arc(250, 120, 20 + frame, 0, Math.PI * 2); ctx.fillStyle = 'rgba(247,37,133,0.7)'; ctx.fill();
          ctx.fillStyle = '#000'; ctx.font = "20px '${TEST_FONT}'"; ctx.fillText('frame ' + frame, 20, 160);
        });
      </script>`,
    });
    expectGolden('canvas2d', await render([n], 12));
  });

  it('WebGL-Skript', async () => {
    const n = html('webgl', 0, {
      html: `<canvas id="c" width="320" height="180"></canvas><script>
        const gl = c.getContext('webgl2', { premultipliedAlpha: true, alpha: true });
        const vs = gl.createShader(gl.VERTEX_SHADER);
        gl.shaderSource(vs, '#version 300 es\\nin vec2 p; out vec2 v; void main(){ v = p * 0.5 + 0.5; gl_Position = vec4(p, 0.0, 1.0); }');
        gl.compileShader(vs);
        const fs = gl.createShader(gl.FRAGMENT_SHADER);
        gl.shaderSource(fs, '#version 300 es\\nprecision highp float; in vec2 v; out vec4 o; void main(){ o = vec4(v.x, v.y, 1.0 - v.x, 1.0); }');
        gl.compileShader(fs);
        const prog = gl.createProgram(); gl.attachShader(prog, vs); gl.attachShader(prog, fs); gl.linkProgram(prog); gl.useProgram(prog);
        const buf = gl.createBuffer(); gl.bindBuffer(gl.ARRAY_BUFFER, buf);
        gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-0.8, -0.8, 0.8, -0.8, 0.0, 0.8]), gl.STATIC_DRAW);
        const loc = gl.getAttribLocation(prog, 'p'); gl.enableVertexAttribArray(loc); gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0);
        gl.clearColor(0, 0, 0, 0); gl.clear(gl.COLOR_BUFFER_BIT); gl.drawArrays(gl.TRIANGLES, 0, 3);
      </script>`,
    });
    expectGolden('webgl', await render([n], 0));
  });

  it('Web Component mit Shadow DOM', async () => {
    const n = html('component', 0, {
      html: `<ov-badge label="Web Component"></ov-badge><script>
        customElements.define('ov-badge', class extends HTMLElement {
          connectedCallback() {
            const root = this.attachShadow({ mode: 'open' });
            root.innerHTML = '<style>div{margin:40px;padding:20px 30px;border-radius:24px;background:#264653;color:#e9c46a;font:700 26px "${TEST_FONT}";display:inline-block}</style><div></div>';
            root.querySelector('div').textContent = this.getAttribute('label');
          }
        });
      </script>`,
      css: 'div{background:red}',
    });
    expectGolden('web-component', await render([n], 0));
  });

  it('CSS-Animation frame-genau', async () => {
    const n = html('animation', 15, {
      html: '<div class="box"></div>',
      css: '@keyframes move{from{transform:translateX(0) rotate(0deg);background:#0000ff}to{transform:translateX(200px) rotate(90deg);background:#ff0000}}.box{position:absolute;left:30px;top:60px;width:60px;height:60px;animation:move 1s linear infinite}',
    });
    expectGolden('css-animation-frame15', await render([n], 15));
  });
});

describe('Semantik', () => {
  it('Uhr: Frame 30 zweimal gerendert → gleiches Bild', async () => {
    const clock = (frame: number) => html('clock', frame, { html: `<div id=t style="${FONT}font-size:24px"></div><script>t.textContent=Date.now()</script>` });
    const first = await render([clock(30)], 30);
    await render([clock(5)], 5);
    const second = await render([clock(30)], 30);
    expect(hashImage(second)).toBe(hashImage(first));
    expect(first.data.some((v) => v !== 0)).toBe(true);
  });

  it('CSS-Animation: Frame 15 bei 30 fps zeigt den Zustand bei 500 ms, unabhängig von vorherigen Frames', async () => {
    const anim = (frame: number) => html('fade', frame, { html: '<div class=b></div>', css: '@keyframes c{from{background:rgb(0,0,255)}to{background:rgb(255,0,0)}}.b{width:100%;height:100%;animation:c 1s linear}' });
    await render([anim(29)], 29);
    const after = await render([anim(15)], 15);
    const [r, g, b, a] = pixel(after, 10, 10);
    expect(a).toBe(255);
    expect(g).toBe(0);
    expect(Math.abs(r - 128)).toBeLessThanOrEqual(1);
    expect(Math.abs(b - 128)).toBeLessThanOrEqual(1);
    await render([anim(3)], 3);
    const again = await render([anim(15)], 15);
    expect(hashImage(again)).toBe(hashImage(after));
  });

  it('Transparenz: HTML ohne Hintergrund hat Alpha 0 außerhalb des Inhalts', async () => {
    const image = await render([html('transparent', 0, { html: '<div style="margin:40px;width:50px;height:50px;background:#000"></div>' })], 0);
    expect(pixel(image, 5, 5)).toEqual([0, 0, 0, 0]);
    expect(pixel(image, 300, 170)).toEqual([0, 0, 0, 0]);
    expect(pixel(image, 60, 60)).toEqual([0, 0, 0, 255]);
  });

  it('liefert vormultipliziertes Alpha', async () => {
    const image = await render([html('half', 0, { html: '', background: 'rgba(255,0,0,0.5)' })], 0);
    const [r, g, b, a] = pixel(image, 100, 100);
    expect(Math.abs(a - 128)).toBeLessThanOrEqual(1);
    expect(Math.abs(r - a)).toBeLessThanOrEqual(1);
    expect([g, b]).toEqual([0, 0]);
  });

  it('Vorschau-Skalierung: scale 0.5 halbiert Box und Position', async () => {
    const n = html('scaled', 0, { width: 100, height: 100, x: 100, y: 40, html: '', background: '#00ff00' });
    const image = await host.render('html', payload([n], 0, { width: 160, height: 90, scale: 0.5 }));
    expect([image.width, image.height]).toEqual([160, 90]);
    expect(pixel(image, 52, 22)).toEqual([0, 255, 0, 255]);
    expect(pixel(image, 98, 68)).toEqual([0, 255, 0, 255]);
    expect(pixel(image, 48, 22)[3]).toBe(0);
    expect(pixel(image, 102, 22)[3]).toBe(0);
  });

  it('virtuelle Timer: setTimeout(1000) feuert erst bei Frame 30', async () => {
    const timer = (frame: number) => html('timer', frame, { html: '<div id=b style="width:100%;height:100%"></div><script>setTimeout(() => { b.style.background = "#f00"; }, 1000)</script>' });
    expect(pixel(await render([timer(29)], 29), 5, 5)[3]).toBe(0);
    expect(pixel(await render([timer(30)], 30), 5, 5)).toEqual([255, 0, 0, 255]);
  });

  it('onFrame und CSS-Variablen erhalten Frame, Zeit und Fortschritt', async () => {
    const bar = (frame: number) =>
      html('bar', frame, {
        html: '<div id=a style="height:20px;background:#00f"></div><div id=b></div><script>openvideo.onFrame(s => { a.style.width = (s.frame * 4) + "px"; })</script>',
        css: '#b{height:20px;width:calc(var(--ov-time) * 100px);background:#0f0}',
      });
    const image = await render([bar(15)], 15);
    expect(pixel(image, 58, 10)).toEqual([0, 0, 255, 255]);
    expect(pixel(image, 62, 10)[3]).toBe(0);
    expect(pixel(image, 48, 30)).toEqual([0, 255, 0, 255]);
    expect(pixel(image, 52, 30)[3]).toBe(0);
  });

  it('lädt Assets über /assets/<id> von der eigenen Origin', async () => {
    const image = await render([html('asset', 0, { html: '<img src="/assets/dot" style="display:block;width:40px;height:40px;image-rendering:pixelated">' })], 0);
    expect(pixel(image, 20, 20)).toEqual([0, 0, 255, 255]);
    expect(pixel(image, 60, 20)[3]).toBe(0);
  });

  it('lehnt fremde Node-Typen ab', async () => {
    await expect(host.render('html', payload([node('r', 'rect', { width: 10, height: 10 })], 0))).rejects.toMatchObject({ diagnostic: { code: 'OV_BROWSER_RENDER' } });
  });

  it('lehnt ungültige Ausgabegrößen ab', async () => {
    await expect(host.render('html', payload([], 0, { width: 0 }))).rejects.toMatchObject({ diagnostic: { code: 'OV_BROWSER_SIZE' } });
  });
});
