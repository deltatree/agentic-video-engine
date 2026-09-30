/**
 * Story 17.7: Audio aus `composition-ref` (rekursiv, mit Versatz) und Video-Ton mit `speed`,
 * `reverse` und `remap`. Prüft Klick-Onsets im gemischten Ton (FFmpeg dekodiert die Quellen).
 */
import { describe, expect, it } from 'vitest';
import { skipUnless } from '@agentic-video/testing';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { decodeAudio, encodeWav } from '@agentic-video/audio';
import { MemoryStore, createCache } from '@agentic-video/cache';
import { SCHEMA_VERSION, type AssetRecord, type AssetResolver } from '@agentic-video/core';
import { locateFfmpeg } from '@agentic-video/ffmpeg';
import { createAudioEngine, sampleAudioTimes } from '@agentic-video/render';

const SR = 48000;
const FPS = 30;
function hasFfmpeg(): boolean {
  try {
    locateFfmpeg();
    return true;
  } catch {
    return false;
  }
}
const ffmpegFound = hasFfmpeg();
if (!ffmpegFound) console.warn('Audio-Tests übersprungen: FFmpeg fehlt (OPENVIDEO_FFMPEG setzen).');

const dir = mkdtempSync(join(tmpdir(), 'ov-audio-nested-'));

/** WAV mit kurzen Klicks (2 ms, Amplitude 0,5) an den angegebenen Sekunden. */
function clickWav(name: string, seconds: number, clicks: readonly number[]): string {
  const n = Math.round(seconds * SR);
  const ch = new Float32Array(n);
  for (const t of clicks) for (let i = 0; i < 96; i++) ch[Math.round(t * SR) + i] = 0.5;
  const path = join(dir, `${name}.wav`);
  writeFileSync(path, encodeWav({ sampleRate: SR, channels: [ch, ch.slice()] }, { bitDepth: 24 }));
  return path;
}

const files = new Map<string, { path: string; duration: number; type: string }>([
  ['clicks', { path: clickWav('clicks', 2, [0.2, 0.6]), duration: 2, type: 'video' }],
  ['late', { path: clickWav('late', 2, [0.6]), duration: 2, type: 'video' }],
  ['beep', { path: clickWav('beep', 1, [0.1]), duration: 1, type: 'audio' }],
]);

const assets: AssetResolver = {
  get(id) {
    const f = files.get(id);
    if (f === undefined) return undefined;
    const record: AssetRecord = { id, type: f.type, src: f.path, path: f.path, hash: id, metadata: f.type === 'video' ? { audio: { channels: 2 } } : {}, duration: f.duration };
    return record;
  },
  bytes: () => Promise.reject(new Error('not used')),
  videoFrame: () => Promise.reject(new Error('not used')),
  all() {
    return [...files.keys()].flatMap((id) => {
      const r = this.get(id);
      return r === undefined ? [] : [r];
    });
  },
};

function project(main: Record<string, unknown>[], extra: Record<string, unknown>[] = []): Record<string, unknown> {
  return {
    schemaVersion: SCHEMA_VERSION,
    assets: [...files.entries()].map(([id, f]) => ({ id, type: f.type, src: f.path })),
    audio: [{ id: 'beep', asset: 'beep' }],
    compositions: [{ id: 'main', width: 16, height: 16, fps: FPS, duration: '2s', nodes: main }, ...extra],
  };
}

const video = (id: string, asset: string, timing: Record<string, unknown> = {}) => ({ id, type: 'video', asset, width: 16, height: 16, timing });

/** Onsets (Sekunden): Stellen, an denen der Betrag nach ≥ 20 ms Stille über die halbe Spitze steigt. */
async function onsets(p: Record<string, unknown>): Promise<number[]> {
  const engine = createAudioEngine({ assets, cache: createCache(new MemoryStore()) });
  const comps = p['compositions'];
  const main = Array.isArray(comps) ? comps[0] : undefined;
  if (typeof main !== 'object' || main === null) throw new Error('no composition');
  const outPath = join(dir, `mix-${String(Math.random()).slice(2)}.wav`);
  const result = await engine.renderComposition({ project: p, composition: { ...main }, startFrame: 0, endFrame: 2 * FPS, outPath });
  if (result === undefined) return [];
  const pcm = await decodeAudio(outPath, { sampleRate: SR, channels: 1 });
  const x = pcm.channels[0] ?? new Float32Array(0);
  let peak = 0;
  for (const v of x) peak = Math.max(peak, Math.abs(v));
  const out: number[] = [];
  let quiet = SR;
  for (let i = 0; i < x.length; i++) {
    const a = Math.abs(x[i] ?? 0);
    if (a > peak / 2 && quiet >= 0.02 * SR) out.push(i / SR);
    quiet = a > peak / 20 ? 0 : quiet + 1;
  }
  return out;
}

function expectOnsets(actual: readonly number[], expected: readonly number[]): void {
  expect(actual.length, `onsets ${JSON.stringify(actual)}`).toBe(expected.length);
  expected.forEach((t, i) => {
    expect(Math.abs((actual[i] ?? Number.NaN) - t), `onset ${String(i)}: ${String(actual[i])} vs ${String(t)}`).toBeLessThan(0.003);
  });
}

describe.skipIf(skipUnless(ffmpegFound, 'FFmpeg fehlt: OPENVIDEO_FFMPEG setzen'))('Audio in verschachtelten Compositions (Story 17.7)', () => {
  it('mischt den Ton einer composition-ref (Spur und Video) mit ihrem Versatz', async () => {
    const inner = {
      id: 'inner',
      width: 16,
      height: 16,
      fps: 25,
      duration: '1s',
      tracks: [{ id: 't', kind: 'audio', clips: [{ id: 'c', source: 'beep', start: 0 }] }],
      nodes: [video('v', 'late', { from: '0.2s' })],
    };
    // Spur: Klick bei 0,1 s; Video ab 0,2 s mit Klick bei 0,6 s → 0,8 s. Ref ab 0,5 s.
    expectOnsets(await onsets(project([{ id: 'ref', type: 'composition-ref', composition: 'inner', timing: { from: '0.5s' } }], [inner])), [0.6, 1.3]);
  });

  it('verschachtelt rekursiv (Ref in Ref)', async () => {
    const leaf = { id: 'leaf', width: 16, height: 16, fps: 30, duration: '1s', tracks: [{ id: 't', kind: 'audio', clips: [{ id: 'c', source: 'beep', start: 0 }] }], nodes: [] };
    const middle = { id: 'middle', width: 16, height: 16, fps: 30, duration: '1.5s', nodes: [{ id: 'r2', type: 'composition-ref', composition: 'leaf', timing: { from: '0.25s' } }] };
    expectOnsets(await onsets(project([{ id: 'r1', type: 'composition-ref', composition: 'middle', timing: { from: '0.5s' } }], [middle, leaf])), [0.85]);
  });

  it('spielt Video-Ton mit speed doppelt so schnell', async () => {
    expectOnsets(await onsets(project([video('v', 'clicks', { speed: 2, duration: '1s' })])), [0.1, 0.3]);
  });

  it('spielt Video-Ton mit reverse rückwärts', async () => {
    // Lokale Zeit (29 − f) / 30 s: Klick-Ende (0,202 s) bei 29/30 − 0,202 s; der Klick 0,6 s bei 29/30 − 0,602 s.
    const got = await onsets(project([video('v', 'clicks', { reverse: true, duration: '1s' })]));
    expectOnsets(got, [29 / 30 - 0.602, 29 / 30 - 0.202]);
  });

  it('folgt remap (Quellzeit als Funktion der Node-Zeit)', async () => {
    // remap: 0,5 s + Node-Zeit → Klick bei 0,6 s erscheint bei 0,1 s.
    const remap = { $expr: '0.5 + time' };
    expectOnsets(await onsets(project([video('v', 'clicks', { remap, duration: '1s' })])), [0.1]);
  });

  it('lässt einfache Video-Nodes auf dem Clip-Pfad (unverändert)', () => {
    expect(sampleAudioTimes(project([video('v', 'clicks', { from: '0.5s' })]), 'main')).toEqual([]);
    const sampled = sampleAudioTimes(project([video('v', 'clicks', { speed: 2, duration: '0.5s' })]), 'main');
    expect(sampled.map((s) => [s.id, s.kind, s.startFrame, s.times.length])).toEqual([['v', 'video', 0, 15]]);
    expect(sampled[0]?.times[3]).toBeCloseTo(0.2, 10);
  });
});
