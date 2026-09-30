/**
 * Story 21.5: Hardware-Encoding ist Opt-in. Ohne `hardware` kodiert der Encoder auf der CPU,
 * auch wenn ein Hardware-Encoder verfügbar ist; so entstehen auf jeder Maschine dieselben Bytes.
 */
import { chmodSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { RgbaImage } from '@agentic-video/core';
import { createEncoder, locateFfmpeg, probeCapabilities } from '@agentic-video/ffmpeg';

const bins = locateFfmpeg();
const dir = mkdtempSync(join(tmpdir(), 'ov-hw-default-'));
/** FFmpeg, das NVENC meldet und die NVENC-Probe besteht (echte Kodierung mit NVENC scheitert). */
const fake = join(dir, 'ffmpeg-with-nvenc');
writeFileSync(
  fake,
  [
    '#!/bin/sh',
    'case "$*" in',
    `  *-encoders*) "${bins.ffmpeg}" "$@"; echo " V....D h264_nvenc           NVIDIA NVENC H.264 encoder (fake)"; exit 0 ;;`,
    '  *"-c:v h264_nvenc -f null"*) exit 0 ;;',
    'esac',
    `exec "${bins.ffmpeg}" "$@"`,
    '',
  ].join('\n'),
);
chmodSync(fake, 0o755);

const frame: RgbaImage = { width: 32, height: 32, data: new Uint8Array(32 * 32 * 4).fill(255) };

async function encode(hardware: 'auto' | undefined): Promise<string> {
  const enc = createEncoder({ ffmpegPath: fake, ffprobePath: bins.ffprobe, output: join(dir, `out-${hardware ?? 'default'}.mp4`), format: 'mp4', width: 32, height: 32, fps: 10, ...(hardware !== undefined ? { hardware } : {}) });
  await enc.write(frame);
  return (await enc.finish()).encoder;
}

describe('Hardware-Encoding als Opt-in (Story 21.5)', () => {
  it('die Probe sieht NVENC', async () => {
    expect((await probeCapabilities({ ffmpegPath: fake, ffprobePath: bins.ffprobe })).hardwareEncoders.nvenc).toBe(true);
  });

  it('ohne Angabe kodiert libx264 auf der CPU, obwohl NVENC verfügbar ist', async () => {
    expect(await encode(undefined)).toBe('libx264');
  });

  it('hardware: auto wählt NVENC (hier scheitert die echte Kodierung ohne GPU)', async () => {
    await expect(encode('auto')).rejects.toThrow(/nvenc/iu);
  });
});
