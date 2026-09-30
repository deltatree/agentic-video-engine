/**
 * Story 17.6: textPath mit textAnimation und Hintergrund; SVG mit clipPath, mask, image, tspan
 * und pattern; Prüfung von SVG-Bildquellen. Die Goldens wurden visuell geprüft.
 */
import { describe, expect, it } from 'vitest';
import { encodePng } from '@agentic-video/png';
import { checkSvgDocument, parseSvg, resolveSvgImageHref } from '@agentic-video/renderer-skia';
import { asset, assets, backend, expectGolden, hash, n, pixel, render } from './helpers.js';

const BG = (w: number, h: number, color = '#15161C') => n('rect', { width: w, height: h, fill: color });

/** 8×8-PNG: vier Farbquadranten. */
function quadrantPng(): Uint8Array {
  const s = 8;
  const data = new Uint8Array(s * s * 4);
  for (let y = 0; y < s; y++) {
    for (let x = 0; x < s; x++) {
      const i = (y * s + x) * 4;
      const q = (x < 4 ? 0 : 1) + (y < 4 ? 0 : 2);
      const c = [[255, 60, 60], [60, 200, 90], [60, 120, 255], [250, 210, 40]][q] ?? [0, 0, 0];
      data[i] = c[0] ?? 0;
      data[i + 1] = c[1] ?? 0;
      data[i + 2] = c[2] ?? 0;
      data[i + 3] = 255;
    }
  }
  return encodePng({ width: s, height: s, data });
}

const PNG = quadrantPng();
const DATA_URI = `data:image/png;base64,${Buffer.from(PNG).toString('base64')}`;

describe('textPath mit textAnimation und Hintergrund (Story 17.6)', () => {
  const d = 'M20 150 C 100 20, 260 20, 340 150';
  const node = (extra: Record<string, unknown>, frame = 0) =>
    n('text', { text: 'Words ride the curve', fontSize: 26, fill: '#FFD166', textPath: { d, offset: 16 }, ...extra }, { frame });

  it('zeichnet den Hintergrund entlang des Pfads', async () => {
    const plain = await render([BG(360, 180), node({})], { width: 360, height: 180 });
    const withBg = await render([BG(360, 180), node({ background: { color: '#3A86FFCC', paddingX: 10, paddingY: 4, radius: 8 } })], { width: 360, height: 180 });
    expect(hash(withBg)).not.toBe(hash(plain));
    expectGolden('text-path-background', withBg);
  });

  it('animiert Einheiten auf dem Pfad', async () => {
    const anim = { unit: 'word', stagger: 4, duration: 10, from: { opacity: 0, y: -30, scale: 0.5 } };
    const start = await render([BG(360, 180), node({ textAnimation: anim }, 0)], { width: 360, height: 180, frame: 0 });
    const mid = await render([BG(360, 180), node({ textAnimation: anim }, 8)], { width: 360, height: 180, frame: 8 });
    const end = await render([BG(360, 180), node({ textAnimation: anim }, 40)], { width: 360, height: 180, frame: 40 });
    const plain = await render([BG(360, 180), node({})], { width: 360, height: 180 });
    // Frame 0: alles unsichtbar (nur Hintergrundfläche); am Ende wie ohne Animation.
    expect(hash(start)).toBe(hash(await render([BG(360, 180)], { width: 360, height: 180 })));
    expect(hash(end)).toBe(hash(plain));
    expect(hash(mid)).not.toBe(hash(plain));
    expectGolden('text-path-animation', mid);
  });
});

describe('SVG: clipPath, mask, image, tspan, pattern (Story 17.6)', () => {
  const markup = `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" viewBox="0 0 400 200" width="400" height="200">
    <defs>
      <clipPath id="circle"><circle cx="50" cy="50" r="40"/></clipPath>
      <clipPath id="half" clipPathUnits="objectBoundingBox"><rect x="0" y="0" width="0.5" height="1"/></clipPath>
      <linearGradient id="fade" x1="0" y1="0" x2="1" y2="0"><stop offset="0" stop-color="white"/><stop offset="1" stop-color="black"/></linearGradient>
      <mask id="m"><rect x="110" y="10" width="80" height="80" fill="url(#fade)"/></mask>
      <pattern id="dots" width="16" height="16" patternUnits="userSpaceOnUse"><rect width="16" height="16" fill="#223"/><circle cx="8" cy="8" r="4" fill="#ffb703"/></pattern>
      <pattern id="stripes" width="0.25" height="1"><rect width="10" height="80" fill="#8ecae6"/></pattern>
    </defs>
    <rect x="10" y="10" width="80" height="80" fill="#e63946" clip-path="url(#circle)"/>
    <rect x="110" y="10" width="80" height="80" fill="#2a9d8f" mask="url(#m)"/>
    <rect x="210" y="10" width="80" height="80" fill="#f4a261" clip-path="url(#half)"/>
    <image x="310" y="10" width="80" height="80" href="${DATA_URI}" style="image-rendering: pixelated"/>
    <rect x="10" y="110" width="180" height="80" fill="url(#dots)" stroke="#fff"/>
    <rect x="210" y="110" width="80" height="80" fill="url(#stripes)"/>
    <text x="300" y="140" font-size="14" fill="#fff">Hello <tspan fill="#ff006e" font-weight="bold">bold</tspan><tspan x="300" dy="22" fill="#8ecae6">next line</tspan></text>
    <image x="300" y="170" width="24" height="24" xlink:href="asset:quad"/>
    <image x="330" y="170" width="24" height="24" href="../images/quad.png"/>
  </svg>`;

  it('zeichnet alle Elemente (Golden)', async () => {
    const list = assets([asset('quad', 'image', PNG, { src: 'assets/images/quad.png' }), asset('pic', 'svg', new TextEncoder().encode(markup), { src: 'assets/vector/pic.svg' })]);
    const img = await render([BG(400, 200), n('svg', { asset: 'pic', width: 400, height: 200 })], { width: 400, height: 200, assets: list });
    // clipPath: Ecke außerhalb des Kreises leer, Mitte rot.
    expect(pixel(img, 50, 50).slice(0, 3)).toEqual([230, 57, 70]);
    expect(pixel(img, 12, 12).slice(0, 3)).toEqual([21, 22, 28]);
    // Maske: links hell (sichtbar), rechts dunkel (fast ausgeblendet).
    expect(pixel(img, 115, 50)[1] ?? 0).toBeGreaterThan(130);
    expect(pixel(img, 186, 50)[1] ?? 0).toBeLessThan(40);
    // objectBoundingBox-Clip: linke Hälfte sichtbar, rechte nicht.
    expect(pixel(img, 230, 50).slice(0, 3)).toEqual([244, 162, 97]);
    expect(pixel(img, 280, 50).slice(0, 3)).toEqual([21, 22, 28]);
    // Bild aus Data-URI (oben links rot) und Asset-Bilder.
    expect(pixel(img, 320, 20)[0] ?? 0).toBeGreaterThan(200);
    expect(pixel(img, 305, 175)[0] ?? 0).toBeGreaterThan(200);
    expect(pixel(img, 335, 175)[0] ?? 0).toBeGreaterThan(200);
    // Muster: Punktmitte gelb, Kachelecke dunkel.
    expect(pixel(img, 24, 120).slice(0, 3)).toEqual([255, 183, 3]);
    expect(pixel(img, 17, 113).slice(0, 3)).toEqual([34, 34, 51]);
    expectGolden('svg-17-6', img);
  });

  it('meldet blockierte Bildquellen als Warnung (Inline und Asset)', async () => {
    const skia = await backend();
    const inline = skia.check({ id: 's', type: 'svg', markup: '<svg><image href="https://example.com/a.png"/><image href="/etc/passwd"/><image href="asset:x"/></svg>' });
    expect(inline.supported).toBe(true);
    expect(inline.diagnostics.map((d) => d.code)).toEqual(['OV_SVG_IMAGE_BLOCKED', 'OV_SVG_IMAGE_BLOCKED']);
    const doc = parseSvg('<svg><image href="../../../outside.png"/><image href="asset:nope"/><image href="data:image/svg+xml,<svg/>"/><filter/></svg>');
    const list = assets([asset('quad', 'image', PNG, { src: 'assets/images/quad.png' })]);
    expect(checkSvgDocument(doc, 'assets/vector', list).map((d) => d.code)).toEqual(['OV_SVG_UNSUPPORTED', 'OV_SVG_IMAGE_BLOCKED', 'OV_SVG_IMAGE_BLOCKED', 'OV_SVG_IMAGE_BLOCKED']);
  });

  it('löst Bildquellen nur innerhalb des Projects auf', () => {
    const list = assets([asset('quad', 'image', PNG, { src: 'assets/images/quad.png' }), asset('snd', 'audio', new Uint8Array([1]), { src: 'assets/snd.wav' })]);
    expect(resolveSvgImageHref('../images/quad.png', 'assets/vector', list)).toEqual({ kind: 'asset', id: 'quad' });
    expect(resolveSvgImageHref('assets/images/quad.png', '', list)).toEqual({ kind: 'asset', id: 'quad' });
    expect(resolveSvgImageHref('asset:quad', '', list)).toEqual({ kind: 'asset', id: 'quad' });
    expect(resolveSvgImageHref('../snd.wav', 'assets/vector', list).kind).toBe('blocked');
    expect(resolveSvgImageHref('../../../x.png', 'assets', list).kind).toBe('blocked');
    expect(resolveSvgImageHref('file:///etc/passwd', '', list).kind).toBe('blocked');
    expect(resolveSvgImageHref(DATA_URI, '', undefined).kind).toBe('data');
    expect(resolveSvgImageHref('asset:quad', '', undefined).kind).toBe('unverified');
  });
});
