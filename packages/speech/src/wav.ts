/**
 * WAV-Hilfen: Kopf lesen, mit FFmpeg normalisieren, temporäre Arbeitsordner.
 */
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { OpenVideoError } from '@agentic-video/core';
import { locateFfmpeg, runProcess } from '@agentic-video/ffmpeg';

/** Abtastrate aller erzeugten Stimmen (FR-58). */
export const VOICE_SAMPLE_RATE = 48_000;
/** Abtastrate, die whisper.cpp erwartet. */
export const ASR_SAMPLE_RATE = 16_000;

/** Kopfdaten einer PCM-WAV-Datei. */
export interface WavInfo {
  readonly sampleRate: number;
  readonly channels: number;
  readonly bitsPerSample: number;
  /** Dauer in Sekunden. */
  readonly duration: number;
}

function invalidWav(problem: string): OpenVideoError {
  return new OpenVideoError({
    code: 'OV_SPEECH_OUTPUT',
    errorClass: 'SpeechError',
    problem,
    suggestions: ['Make sure the voice provider writes a RIFF/WAVE file.', 'Play the output file with ffplay to check it.'],
  });
}

/**
 * Liest Abtastrate, Kanäle, Bittiefe und Dauer aus einem WAV-Kopf.
 *
 * @example
 * ```ts
 * wavInfo(bytes); // { sampleRate: 48000, channels: 1, bitsPerSample: 16, duration: 1.25 }
 * ```
 */
export function wavInfo(bytes: Uint8Array): WavInfo {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const tag = (at: number) => String.fromCharCode(...bytes.subarray(at, at + 4));
  if (bytes.length < 12 || tag(0) !== 'RIFF' || tag(8) !== 'WAVE') throw invalidWav('Audio data is not a RIFF/WAVE file.');
  let pos = 12;
  let fmt: { channels: number; sampleRate: number; byteRate: number; bits: number } | undefined;
  while (pos + 8 <= bytes.length) {
    const id = tag(pos);
    const size = view.getUint32(pos + 4, true);
    const body = pos + 8;
    if (id === 'fmt ' && body + 16 <= bytes.length) {
      fmt = { channels: view.getUint16(body + 2, true), sampleRate: view.getUint32(body + 4, true), byteRate: view.getUint32(body + 8, true), bits: view.getUint16(body + 14, true) };
    } else if (id === 'data') {
      if (fmt === undefined || fmt.byteRate === 0) throw invalidWav('WAV data chunk comes before a valid fmt chunk.');
      const dataSize = Math.min(size, bytes.length - body);
      return { sampleRate: fmt.sampleRate, channels: fmt.channels, bitsPerSample: fmt.bits, duration: dataSize / fmt.byteRate };
    }
    pos = body + size + (size % 2);
  }
  throw invalidWav('WAV file has no data chunk.');
}

/**
 * Wandelt eine Audiodatei mit FFmpeg in 16-Bit-PCM-WAV, mono, mit fester Abtastrate.
 * Metadaten werden entfernt (`bitexact`), damit gleiche Eingaben gleiche Bytes ergeben.
 *
 * @example
 * ```ts
 * await normalizeWav('/tmp/raw.wav', '/tmp/voice.wav', 48000);
 * ```
 */
export async function normalizeWav(inputPath: string, outputPath: string, sampleRate: number, timeoutMs = 120_000): Promise<void> {
  const { ffmpeg } = locateFfmpeg();
  await runProcess(
    ffmpeg,
    ['-nostdin', '-y', '-loglevel', 'error', '-i', inputPath, '-map_metadata', '-1', '-ac', '1', '-ar', String(sampleRate), '-c:a', 'pcm_s16le', '-fflags', '+bitexact', '-flags:a', '+bitexact', outputPath],
    { timeoutMs },
  );
}

/**
 * Führt `fn` mit einem frischen temporären Ordner aus und löscht ihn danach.
 *
 * @example
 * ```ts
 * const bytes = await withTempDir((dir) => readFile(join(dir, 'x.wav')));
 * ```
 */
export async function withTempDir<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), 'ov-speech-'));
  try {
    return await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}
