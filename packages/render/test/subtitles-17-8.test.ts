/**
 * Story 17.8 im Render: Karaoke-Fill innerhalb des Worts sitzt an der gemessenen Stelle
 * (echter Textmesser des Skia-Backends, Box mit Innenabstand).
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MemoryStore, createCache } from '@agentic-video/cache';
import { SCHEMA_VERSION, type RgbaImage } from '@agentic-video/core';
import { createNodeEnvironment, renderFrame, type NodeEnvironment } from '@agentic-video/render';

function project(): Record<string, unknown> {
  return {
    schemaVersion: SCHEMA_VERSION,
    compositions: [
      {
        id: 'main',
        width: 640,
        height: 200,
        fps: 30,
        duration: '3s',
        background: '#000000',
        tracks: [
          {
            id: 'subs',
            kind: 'subtitle',
            cues: [{ start: 0, end: 90, text: 'Hello world', words: [{ text: 'Hello', start: 0, end: 30 }, { text: 'world', start: 30, end: 60 }] }],
          },
        ],
        nodes: [{ id: 'cap', type: 'subtitles', track: 'subs', style: 'karaoke', fontSize: 64, color: '#FFFFFF', highlightColor: '#FF0000', box: { color: '#0000FF', paddingX: 40, paddingY: 8 } }],
      },
    ],
  };
}

let env: NodeEnvironment;

beforeAll(async () => {
  env = await createNodeEnvironment({ projectDir: mkdtempSync(join(tmpdir(), 'ov-karaoke-')), project: project(), cache: createCache(new MemoryStore()), skipDefaultProviders: true });
});

afterAll(async () => {
  await env.dispose();
});

function redPixels(image: RgbaImage): number {
  let n = 0;
  for (let i = 0; i < image.data.length; i += 4) if ((image.data[i] ?? 0) > 180 && (image.data[i + 1] ?? 0) < 90 && (image.data[i + 2] ?? 0) < 90) n++;
  return n;
}

describe('Karaoke-Fill im Render (Story 17.8)', () => {
  it('füllt das laufende Wort zur Hälfte, wenn die Hälfte seiner Zeit vorbei ist', async () => {
    const at = async (frame: number) => redPixels((await renderFrame(env, project(), { frame, useCache: false })).image);
    const none = await at(30);
    const half = await at(45);
    const full = await at(62);
    expect(full).toBeGreaterThan(none);
    const ratio = (half - none) / (full - none);
    expect(ratio).toBeGreaterThan(0.35);
    expect(ratio).toBeLessThan(0.65);
  });
});
