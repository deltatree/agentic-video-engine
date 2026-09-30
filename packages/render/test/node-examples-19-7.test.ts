/**
 * Story 19.7: Jedes Node-Beispiel aus `NODE_EXAMPLES` ist gegen Schema und Semantik gültig (checkProject
 * mit Komponenten, Schriften und Backends) und jedes 2D-Beispiel rendert einmal mit Skia.
 * Browser-, 3D- und Blender-Beispiele werden nur validiert (packages/schema/test/node-examples.test.ts).
 */
import { beforeAll, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EXAMPLE_TYPES_NOT_2D, NODE_SCHEMAS, exampleProject, type BuiltinNodeType, type RgbaImage } from '@agentic-video/core';
import { encodePng } from '@agentic-video/png';
import { checkProject, createNodeEnvironment, renderFrame } from '@agentic-video/render';
import { skipUnless } from '@agentic-video/testing';

const ffmpeg = process.env['OPENVIDEO_FFMPEG'] ?? '/usr/bin/ffmpeg';
const hasFfmpeg = existsSync(ffmpeg);
const TYPES_2D = (Object.keys(NODE_SCHEMAS) as BuiltinNodeType[]).filter((t) => !EXAMPLE_TYPES_NOT_2D.includes(t));
let dir: string;

/** Deckendes Bild aus einer Farbfunktion (deckend: vormultipliziert = gerade). */
function image(width: number, height: number, color: (x: number, y: number) => readonly [number, number, number, number]): RgbaImage {
  const data = new Uint8Array(width * height * 4);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const [r, g, b, a] = color(x, y);
      data.set([Math.round((r * a) / 255), Math.round((g * a) / 255), Math.round((b * a) / 255), a], (y * width + x) * 4);
    }
  }
  return { width, height, data };
}

/** Minimales Lottie: ein Quadrat, das sich in 60 Frames einmal dreht. */
const SPINNER = {
  v: '5.7.4', fr: 30, ip: 0, op: 60, w: 200, h: 200, nm: 'spinner', ddd: 0, assets: [],
  layers: [{
    ddd: 0, ind: 1, ty: 4, nm: 'square', sr: 1, ao: 0, ip: 0, op: 60, st: 0, bm: 0,
    ks: { o: { a: 0, k: 100 }, r: { a: 1, k: [{ t: 0, s: [0], i: { x: [1], y: [1] }, o: { x: [0], y: [0] } }, { t: 60, s: [360] }] }, p: { a: 0, k: [100, 100, 0] }, a: { a: 0, k: [0, 0, 0] }, s: { a: 0, k: [100, 100, 100] } },
    shapes: [{ ty: 'gr', nm: 'g', it: [
      { ty: 'rc', nm: 'r', d: 1, s: { a: 0, k: [100, 100] }, p: { a: 0, k: [0, 0] }, r: { a: 0, k: 16 } },
      { ty: 'fl', nm: 'f', c: { a: 0, k: [1, 0.35, 0.12, 1] }, o: { a: 0, k: 100 }, r: 1 },
      { ty: 'tr', p: { a: 0, k: [0, 0] }, a: { a: 0, k: [0, 0] }, s: { a: 0, k: [100, 100] }, r: { a: 0, k: 0 }, o: { a: 0, k: 100 } },
    ] }],
  }],
};

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'ov-node-examples-'));
  mkdirSync(join(dir, 'assets'));
  // Logo: orange Scheibe mit weißem Ring auf Transparenz.
  writeFileSync(join(dir, 'assets', 'logo.png'), encodePng(image(128, 128, (x, y) => {
    const d = Math.hypot(x - 63.5, y - 63.5);
    return d < 44 ? [255, 90, 31, 255] : d < 56 ? [255, 255, 255, 255] : [0, 0, 0, 0];
  })));
  // Sprite Sheet: vier Frames nebeneinander, je ein Balken an anderer Höhe.
  writeFileSync(join(dir, 'assets', 'walk-sheet.png'), encodePng(image(256, 64, (x, y) => {
    const frame = Math.floor(x / 64);
    return Math.abs(y - (12 + frame * 12)) < 8 ? [79, 140, 255, 255] : [27, 42, 74, 255];
  })));
  writeFileSync(join(dir, 'assets', 'spinner.json'), JSON.stringify(SPINNER));
  if (hasFfmpeg) execFileSync(ffmpeg, ['-y', '-loglevel', 'error', '-f', 'lavfi', '-i', 'testsrc2=size=320x180:rate=30:duration=2', '-pix_fmt', 'yuv420p', join(dir, 'assets', 'clip.mp4')]);
});

/** Anteil der Pixel, die sich vom Composition-Hintergrund #0B0D12 unterscheiden. */
function changedFraction(img: RgbaImage): number {
  let changed = 0;
  for (let i = 0; i < img.data.length; i += 4) {
    if (Math.abs((img.data[i] ?? 0) - 0x0b) + Math.abs((img.data[i + 1] ?? 0) - 0x0d) + Math.abs((img.data[i + 2] ?? 0) - 0x12) > 6) changed++;
  }
  return changed / (img.data.length / 4);
}

describe('Node-Beispiele rendern (Story 19.7)', () => {
  it('trennt 2D- von Browser-/3D-/Blender-Beispielen', () => {
    expect(TYPES_2D).toContain('sequence');
    expect(TYPES_2D).toContain('subtitles');
    expect(TYPES_2D).not.toContain('html');
    expect(TYPES_2D).not.toContain('scene3d');
    expect(TYPES_2D).toHaveLength(21);
  });

  for (const type of TYPES_2D) {
    const needsFfmpeg = type === 'video';
    it.skipIf(needsFfmpeg && skipUnless(hasFfmpeg, `FFmpeg fehlt (${ffmpeg}): OPENVIDEO_FFMPEG setzen, um das video-Beispiel zu rendern`))(`${type}: gültig und mit Skia gerendert`, async () => {
      const project = exampleProject(type);
      const env = await createNodeEnvironment({ projectDir: dir, project, skipDefaultProviders: true });
      try {
        expect(env.assetDiagnostics).toEqual([]);
        expect(checkProject(env, project).filter((d) => d.severity === 'error')).toEqual([]);
        const result = await renderFrame(env, project, { frame: 20, useCache: false });
        expect(result.diagnostics.filter((d) => d.severity === 'error')).toEqual([]);
        expect(result.image.width).toBe(640);
        expect(changedFraction(result.image), 'das Beispiel zeichnet sichtbar etwas').toBeGreaterThan(0.001);
        if (process.env['OV_EXAMPLES_OUT'] !== undefined) writeFileSync(join(process.env['OV_EXAMPLES_OUT'], `${type}.png`), encodePng(result.image));
      } finally {
        await env.dispose();
      }
    });
  }
});
