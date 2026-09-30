/**
 * Story 17.4: animierte Bilder (GIF) in `image`-Nodes laufen über den Video-Frame-Pfad.
 * Das GIF erzeugt der Test mit FFmpeg: 0,5 s rot, dann 0,5 s blau, Endlosschleife.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { skipUnless } from '@agentic-video/testing';
import { execFileSync } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MemoryStore, createCache } from '@agentic-video/cache';
import { SCHEMA_VERSION, type RgbaImage } from '@agentic-video/core';
import { locateFfmpeg } from '@agentic-video/ffmpeg';
import { createNodeEnvironment, renderFrame, type NodeEnvironment } from '@agentic-video/render';

function ffmpegPath(): string | undefined {
  try {
    return locateFfmpeg().ffmpeg;
  } catch (error) {
    if (error instanceof Error) return undefined;
    throw error;
  }
}

const ffmpeg = ffmpegPath();
const dir = mkdtempSync(join(tmpdir(), 'ov-gif-'));

const projectFor = (src: string) => ({
  schemaVersion: SCHEMA_VERSION,
  assets: [{ id: 'anim', type: 'image', src }],
  compositions: [
    {
      id: 'main',
      width: 32,
      height: 32,
      fps: 30,
      duration: '3s',
      background: '#000000',
      nodes: [{ id: 'gif', type: 'image', asset: 'anim', width: 32, height: 32, smoothing: 'nearest' }],
    },
  ],
});
const project = projectFor('anim.gif');
const apngProject = projectFor('anim.png');

let env: NodeEnvironment | undefined;
let apngEnv: NodeEnvironment | undefined;

beforeAll(async () => {
  if (ffmpeg === undefined) return;
  const input = ['-y', '-loglevel', 'error', '-f', 'lavfi', '-i', 'color=c=red:s=16x16:r=10:d=1'];
  const draw = "drawbox=x=0:y=0:w=16:h=16:color=blue:t=fill:enable='gte(t,0.5)'";
  // Eigene Palette ohne Dithering: Die GIF-Farben bleiben exakt rot und blau.
  execFileSync(ffmpeg, [...input, '-vf', `${draw},split[a][b];[a]palettegen=reserve_transparent=0[p];[b][p]paletteuse=dither=none`, '-loop', '0', join(dir, 'anim.gif')]);
  execFileSync(ffmpeg, [...input, '-vf', draw, '-plays', '0', '-f', 'apng', join(dir, 'anim.png')]);
  env = await createNodeEnvironment({ projectDir: dir, project, cache: createCache(new MemoryStore()), skipDefaultProviders: true });
  apngEnv = await createNodeEnvironment({ projectDir: dir, project: apngProject, cache: createCache(new MemoryStore()), skipDefaultProviders: true });
});

afterAll(async () => {
  await env?.dispose();
  await apngEnv?.dispose();
});

function center(image: RgbaImage): number[] {
  const o = (16 * image.width + 16) * 4;
  return [...image.data.subarray(o, o + 4)];
}

describe('Animierte Bilder in image-Nodes (Story 17.4)', () => {
  it.skipIf(skipUnless(ffmpeg !== undefined, 'FFmpeg fehlt: OPENVIDEO_FFMPEG setzen'))('erkennt das GIF als animiert', () => {
    expect(env?.assets.get('anim')?.metadata['animated']).toBe(true);
    expect(env?.assetDiagnostics.filter((d) => d.severity === 'error')).toEqual([]);
  });

  it.skipIf(skipUnless(ffmpeg !== undefined, 'FFmpeg fehlt: OPENVIDEO_FFMPEG setzen'))('zeigt den Frame zur lokalen Zeit und läuft in einer Schleife', async () => {
    const e = env;
    if (e === undefined) throw new Error('environment missing');
    const at = async (frame: number) => {
      const r = await renderFrame(e, project, { frame });
      expect(r.diagnostics.filter((d) => d.severity === 'error')).toEqual([]);
      return center(r.image);
    };
    const red = await at(3);
    const blue = await at(21);
    const loopRed = await at(33);
    expect(red[0]).toBeGreaterThan(200);
    expect(red[2]).toBeLessThan(40);
    expect(blue[0]).toBeLessThan(40);
    expect(blue[2]).toBeGreaterThan(200);
    expect(loopRed).toEqual(red);
  });

  it.skipIf(skipUnless(ffmpeg !== undefined, 'FFmpeg fehlt: OPENVIDEO_FFMPEG setzen'))('trennt Frame-Schlüssel animierter Bilder nach Zeit', async () => {
    if (env === undefined) throw new Error('environment missing');
    const a = await renderFrame(env, project, { frame: 3 });
    const b = await renderFrame(env, project, { frame: 21 });
    expect(a.key).not.toBe(b.key);
  });

  it.skipIf(skipUnless(ffmpeg !== undefined, 'FFmpeg fehlt: OPENVIDEO_FFMPEG setzen'))('spielt auch APNG über den Video-Frame-Pfad ab', async () => {
    if (apngEnv === undefined) throw new Error('environment missing');
    expect(apngEnv.assets.get('anim')?.metadata['animated']).toBe(true);
    const first = center((await renderFrame(apngEnv, apngProject, { frame: 3 })).image);
    const second = center((await renderFrame(apngEnv, apngProject, { frame: 21 })).image);
    expect(first[0]).toBeGreaterThan(200);
    expect(second[2]).toBeGreaterThan(200);
  });
});
