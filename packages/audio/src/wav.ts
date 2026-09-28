/**
 * WAV-Ausgabe (RIFF/WAVE): 16 und 24 Bit PCM, 32 Bit IEEE-Float.
 */
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { OpenVideoError } from '@agentic-video/core';
import type { PcmBuffer } from './decode.js';

/** Optionen für {@link writeWav} und {@link encodeWav}. */
export interface WavOptions {
  /** 16 oder 24 = ganzzahliges PCM, 32 = IEEE-Float (Standard 24). */
  readonly bitDepth?: 16 | 24 | 32;
}

/**
 * Kodiert einen Puffer als WAV-Datei im Speicher. Ganzzahlige Formate werden auf [−1, 1] begrenzt
 * und gerundet (ohne Dither, damit die Ausgabe deterministisch bleibt).
 *
 * @example
 * ```ts
 * const bytes = encodeWav(buffer, { bitDepth: 16 });
 * ```
 */
export function encodeWav(buffer: PcmBuffer, options: WavOptions = {}): Uint8Array {
  const bits = options.bitDepth ?? 24;
  // Laufzeitprüfung für Aufrufer ohne TypeScript.
  if (![16, 24, 32].includes(bits)) {
    throw new OpenVideoError({ code: 'OV_AUDIO_WAV', errorClass: 'AudioError', problem: `Unsupported bit depth ${String(bits)}.`, suggestions: ['Use bitDepth 16, 24 or 32.'] });
  }
  const channels = buffer.channels.length;
  const frames = buffer.channels[0]?.length ?? 0;
  const bytesPer = bits / 8;
  const dataSize = frames * channels * bytesPer;
  const float = bits === 32;
  const fmtSize = float ? 18 : 16;
  const factSize = float ? 12 : 0;
  const headerSize = 12 + 8 + fmtSize + factSize + 8;
  const out = new Uint8Array(headerSize + dataSize);
  const view = new DataView(out.buffer);
  const ascii = (offset: number, text: string) => {
    for (let i = 0; i < text.length; i++) view.setUint8(offset + i, text.charCodeAt(i));
  };
  ascii(0, 'RIFF');
  view.setUint32(4, out.length - 8, true);
  ascii(8, 'WAVE');
  ascii(12, 'fmt ');
  view.setUint32(16, fmtSize, true);
  view.setUint16(20, float ? 3 : 1, true);
  view.setUint16(22, channels, true);
  view.setUint32(24, buffer.sampleRate, true);
  view.setUint32(28, buffer.sampleRate * channels * bytesPer, true);
  view.setUint16(32, channels * bytesPer, true);
  view.setUint16(34, bits, true);
  let p = 36;
  if (float) {
    view.setUint16(p, 0, true);
    p += 2;
    ascii(p, 'fact');
    view.setUint32(p + 4, 4, true);
    view.setUint32(p + 8, frames, true);
    p += 12;
  }
  ascii(p, 'data');
  view.setUint32(p + 4, dataSize, true);
  p += 8;
  for (let i = 0; i < frames; i++) {
    for (let c = 0; c < channels; c++) {
      const v = buffer.channels[c]?.[i] ?? 0;
      if (float) {
        view.setFloat32(p, v, true);
      } else {
        const clamped = Math.min(1, Math.max(-1, Number.isNaN(v) ? 0 : v));
        if (bits === 16) {
          view.setInt16(p, Math.round(clamped * 32767), true);
        } else {
          const s = Math.round(clamped * 8388607);
          view.setUint8(p, s & 0xff);
          view.setUint8(p + 1, (s >> 8) & 0xff);
          view.setUint8(p + 2, (s >> 16) & 0xff);
        }
      }
      p += bytesPer;
    }
  }
  return out;
}

/**
 * Schreibt einen Puffer als WAV-Datei. Legt fehlende Verzeichnisse an.
 *
 * @example
 * ```ts
 * await writeWav(master, 'out/mix.wav', { bitDepth: 24 });
 * ```
 */
export async function writeWav(buffer: PcmBuffer, path: string, options: WavOptions = {}): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, encodeWav(buffer, options));
}
