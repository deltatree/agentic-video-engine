/**
 * A/V-Sync im kodierten MP4 (Story 22.5, Testplan R4, Audit P2-8): Ein Klick im Ton und ein
 * Blitz-Frame im Bild liegen auf demselben Zeitpunkt. Geprüft wird die fertige Datei (H.264 + AAC,
 * inklusive Encoder-Verzögerung und Edit-Liste), nicht der Mix davor. Toleranz: ±1 Frame.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { encodeWav } from '@agentic-video/audio';
import { MemoryStore, createCache } from '@agentic-video/cache';
import { SCHEMA_VERSION } from '@agentic-video/core';
import { locateFfmpeg } from '@agentic-video/ffmpeg';
import { createNodeEnvironment, renderVideo, type NodeEnvironment } from '@agentic-video/render';
import { findOnsets, skipUnless } from '@agentic-video/testing';

function tools(): { ffmpeg: string; ffprobe: string } | undefined {
  try {
    return locateFfmpeg();
  } catch (error) {
    if (error instanceof Error) return undefined;
    throw error;
  }
}

const bins = tools();
const SR = 48_000;
const FPS = 30;
/** Klick und Blitz in Sekunden (nicht auf Frame 0, damit ein fester Versatz auffällt). */
const EVENTS = [0.5, 1.4];
const SECONDS = 2;

let dir: string;
let env: NodeEnvironment | undefined;

/** Stille mit kurzen Klicks (2 ms, Amplitude 0,8) an den Ereignissen. */
function clickTrack(): Uint8Array {
  const ch = new Float32Array(SECONDS * SR);
  for (const t of EVENTS) for (let i = 0; i < 96; i++) ch[Math.round(t * SR) + i] = 0.8;
  return encodeWav({ sampleRate: SR, channels: [ch, ch.slice()] }, { bitDepth: 16 });
}

/** Schwarzes Bild; ein weißes Rechteck genau einen Frame lang je Ereignis. */
const project = {
  schemaVersion: SCHEMA_VERSION,
  assets: [{ id: 'clicks', type: 'audio', src: 'assets/clicks.wav' }],
  audio: [{ id: 'clicks', asset: 'clicks' }],
  compositions: [
    {
      id: 'main',
      width: 64,
      height: 36,
      fps: FPS,
      duration: SECONDS * FPS,
      background: '#000000',
      tracks: [{ id: 'sound', kind: 'audio', clips: [{ id: 'c1', source: 'clicks', start: 0 }] }],
      nodes: EVENTS.map((t, i) => ({ id: `flash${String(i)}`, type: 'rect', width: 64, height: 36, fill: '#FFFFFF', timing: { from: Math.round(t * FPS), duration: 1 } })),
    },
  ],
};

beforeAll(async () => {
  if (bins === undefined) return;
  dir = mkdtempSync(join(tmpdir(), 'ov-avsync-'));
  mkdirSync(join(dir, 'assets'));
  writeFileSync(join(dir, 'assets', 'clicks.wav'), clickTrack());
  env = await createNodeEnvironment({ projectDir: dir, project, cache: createCache(new MemoryStore()) });
});

afterAll(async () => {
  await env?.dispose();
});

/** Mittlere Helligkeit je dekodiertem Video-Frame (Zeitstempel aus der Datei). */
function flashTimes(ffmpeg: string, ffprobe: string, file: string): number[] {
  const times = execFileSync(ffprobe, ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'frame=best_effort_timestamp_time', '-of', 'csv=p=0', file], { encoding: 'utf8' })
    .trim()
    .split('\n')
    .map(Number);
  const gray = execFileSync(ffmpeg, ['-v', 'error', '-i', file, '-map', '0:v:0', '-vf', 'scale=8:4', '-f', 'rawvideo', '-pix_fmt', 'gray', '-'], { maxBuffer: 1 << 26 });
  const per = 8 * 4;
  const out: number[] = [];
  for (let f = 0; f * per < gray.length; f++) {
    let sum = 0;
    for (let i = 0; i < per; i++) sum += gray[f * per + i] ?? 0;
    if (sum / per > 128) out.push(times[f] ?? Number.NaN);
  }
  return out;
}

/** Klick-Zeitpunkte im dekodierten Ton (Edit-Liste und Encoder-Verzögerung berücksichtigt FFmpeg). */
function clickTimes(ffmpeg: string, file: string): number[] {
  const raw = execFileSync(ffmpeg, ['-v', 'error', '-i', file, '-map', '0:a:0', '-ac', '1', '-ar', String(SR), '-f', 'f32le', '-'], { maxBuffer: 1 << 26 });
  const samples = new Float32Array(raw.buffer, raw.byteOffset, Math.floor(raw.length / 4));
  return findOnsets(samples, SR, 0.2, { holdOff: 0.1 });
}

/** Startzeit eines Streams in der Datei (Sekunden). */
function streamStart(ffprobe: string, file: string, stream: 'v:0' | 'a:0'): number {
  return Number(execFileSync(ffprobe, ['-v', 'error', '-select_streams', stream, '-show_entries', 'stream=start_time', '-of', 'csv=p=0', file], { encoding: 'utf8' }).trim());
}

describe.skipIf(skipUnless(bins !== undefined, 'FFmpeg fehlt: OPENVIDEO_FFMPEG und OPENVIDEO_FFPROBE setzen'))('A/V-Sync im MP4 (Story 22.5)', () => {
  it('Klick und Blitz-Frame liegen in der kodierten Datei höchstens einen Frame auseinander', async () => {
    if (bins === undefined || env === undefined) throw new Error('environment missing');
    const file = join(dir, 'out', 'sync.mp4');
    await renderVideo(env, project, { outPath: file, profile: { format: 'mp4', codec: 'h264' } });
    // Beide auf der Präsentations-Zeitachse der Datei: Blitz-Zeitstempel direkt, Klicks relativ zum Audio-Start.
    const videoStart = streamStart(bins.ffprobe, file, 'v:0');
    const audioStart = streamStart(bins.ffprobe, file, 'a:0');
    const flashes = flashTimes(bins.ffmpeg, bins.ffprobe, file);
    const clicks = clickTimes(bins.ffmpeg, file).map((t) => t + audioStart);
    // Ein Blitz je Ereignis, genau auf seinem Frame.
    expect(flashes).toHaveLength(EVENTS.length);
    EVENTS.forEach((t, i) => {
      expect(Math.abs((flashes[i] ?? Number.NaN) - videoStart - Math.round(t * FPS) / FPS), `flash ${String(i)}`).toBeLessThan(1e-3);
    });
    // Ein Klick je Ereignis; Abstand zum Blitz ≤ 1 Frame.
    expect(clicks, `clicks ${JSON.stringify(clicks)}`).toHaveLength(EVENTS.length);
    clicks.forEach((c, i) => {
      const flash = flashes[i] ?? Number.NaN;
      expect(Math.abs(c - flash), `click ${String(c)} vs. flash ${String(flash)}`).toBeLessThanOrEqual(1 / FPS);
    });
  });
});
