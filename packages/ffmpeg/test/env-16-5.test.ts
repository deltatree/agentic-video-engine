/**
 * Story 16.5 / Befund M2: FFmpeg und ffprobe bekommen eine minimale Umgebung – beim Probe,
 * beim Encoder und beim Frame-Reader. Ein Wrapper-Skript protokolliert die Umgebung jedes Aufrufs.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { chmodSync, existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { VideoFrameReader, createEncoder, ffmpegEnv, locateFfmpeg, runProcess } from '@agentic-video/ffmpeg';

function real(): { ffmpeg: string; ffprobe: string } | undefined {
  try {
    return locateFfmpeg();
  } catch (error) {
    if (error instanceof Error) return undefined;
    throw error;
  }
}

const bins = real();
const dir = mkdtempSync(join(tmpdir(), 'ov-ffmpeg-env-'));
const dump = join(dir, 'env.txt');
const wrapper = join(dir, 'ffmpeg-wrapper.sh');
const SECRET = 'OPENVIDEO_WORKER_TOKEN';
let previous: string | undefined;

beforeAll(() => {
  if (bins === undefined) return;
  writeFileSync(wrapper, `#!/bin/sh\nenv >> '${dump}'\nexec '${bins.ffmpeg}' "$@"\n`);
  chmodSync(wrapper, 0o755);
  previous = process.env[SECRET];
  process.env[SECRET] = 'secret-token-that-must-not-leak';
  process.env['AWS_SECRET_ACCESS_KEY'] = 'aws-secret-that-must-not-leak';
});

afterAll(() => {
  if (previous === undefined) Reflect.deleteProperty(process.env, SECRET);
  else process.env[SECRET] = previous;
  Reflect.deleteProperty(process.env, 'AWS_SECRET_ACCESS_KEY');
});

describe('minimale Umgebung für FFmpeg (Story 16.5, M2)', () => {
  it('ffmpegEnv lässt Tokens und S3-Schlüssel weg, GPU-Variablen bleiben', () => {
    expect(ffmpegEnv({ PATH: '/bin', OPENVIDEO_S3_SECRET_ACCESS_KEY: 'x', AWS_ACCESS_KEY_ID: 'y', CUDA_VISIBLE_DEVICES: '1', LIBVA_DRIVER_NAME: 'iHD' })).toEqual({ PATH: '/bin', CUDA_VISIBLE_DEVICES: '1', LIBVA_DRIVER_NAME: 'iHD' });
  });

  it.skipIf(bins === undefined)('runProcess, Encoder und Frame-Reader starten FFmpeg ohne Tokens', async () => {
    await runProcess(wrapper, ['-hide_banner', '-version']);
    const out = join(dir, 'clip.mp4');
    const enc = createEncoder({ output: out, format: 'mp4', codec: 'h264', width: 16, height: 16, fps: 10, ffmpegPath: wrapper, ...(bins !== undefined ? { ffprobePath: bins.ffprobe } : {}) });
    const frame = { width: 16, height: 16, data: new Uint8Array(16 * 16 * 4).fill(255) };
    for (let i = 0; i < 3; i++) await enc.write(frame);
    await enc.finish();
    const reader = await VideoFrameReader.open(out, { ffmpegPath: wrapper, ...(bins !== undefined ? { ffprobePath: bins.ffprobe } : {}) });
    await reader.frameAt(0);
    await reader.close();
    expect(existsSync(dump)).toBe(true);
    const text = readFileSync(dump, 'utf8');
    expect(text).toMatch(/^PATH=/mu);
    expect(text).not.toMatch(/must-not-leak/u);
    // Drei Starts über den Wrapper: runProcess, Encoder (plus Probe) und Reader.
    expect(text.match(/^PATH=/gmu)?.length ?? 0).toBeGreaterThanOrEqual(3);
  }, 60_000);
});
