/**
 * Dekodieren von Audioquellen über FFmpeg zu Float32 (FR-52).
 */
import { OpenVideoError } from '@agentic-video/core';
import { locateFfmpeg, probeMedia, runProcess, type FfmpegLocateOptions } from '@agentic-video/ffmpeg';

/**
 * Audio im Speicher: ein Float32-Array je Kanal, Werte in [−1, 1] (Überschreitung möglich).
 *
 * @example
 * ```ts
 * const silence: PcmBuffer = { sampleRate: 48000, channels: [new Float32Array(48000), new Float32Array(48000)] };
 * ```
 */
export interface PcmBuffer {
  readonly sampleRate: number;
  readonly channels: Float32Array[];
}

/** Optionen für {@link decodeAudio}. */
export interface DecodeOptions extends FfmpegLocateOptions {
  /** Ziel-Abtastrate (Standard 48 000). */
  readonly sampleRate?: number;
  /** Anzahl der Kanäle (Standard 2). Mono-Quellen werden auf alle Kanäle verteilt. */
  readonly channels?: number;
  /** Start in der Quelle in Sekunden. */
  readonly start?: number;
  /** Länge in der Quelle in Sekunden (vor der Tempo-Änderung). */
  readonly duration?: number;
  /** Tempo-Faktor (z. B. 2 = doppelt so schnell). Umsetzung über eine `atempo`-Kette, Tonhöhe bleibt. */
  readonly rate?: number;
  readonly timeoutMs?: number;
}

/**
 * Baut die `atempo`-Kette für einen Tempo-Faktor. Jedes Glied bleibt in [0.5, 2].
 *
 * @example
 * ```ts
 * atempoChain(3); // ['atempo=2', 'atempo=1.5']
 * atempoChain(0.25); // ['atempo=0.5', 'atempo=0.5']
 * ```
 */
export function atempoChain(rate: number): string[] {
  if (!(rate > 0) || !Number.isFinite(rate)) {
    throw new OpenVideoError({ code: 'OV_AUDIO_RATE', errorClass: 'AudioError', problem: `Invalid playback rate ${String(rate)}.`, suggestions: ['Use a playbackRate between 0.25 and 4.'] });
  }
  const out: string[] = [];
  let r = rate;
  while (r > 2) {
    out.push('atempo=2');
    r /= 2;
  }
  while (r < 0.5) {
    out.push('atempo=0.5');
    r /= 0.5;
  }
  if (Math.abs(r - 1) > 1e-12) out.push(`atempo=${String(r)}`);
  return out;
}

/**
 * Demuxer, die `decodeAudio` für Eingaben zulässt (M3, Story 16.5): nur Container mit eingebetteten
 * Daten. Formate, die andere Dateien oder URLs nachladen (`hls`, `concat`, `dash`, Playlists,
 * `image2`-Muster), fehlen absichtlich.
 */
export const AUDIO_INPUT_FORMATS: readonly string[] = ['wav', 'w64', 'mp3', 'flac', 'ogg', 'aac', 'aiff', 'caf', 'mov', 'mp4', 'm4a', 'matroska', 'webm', 'avi', 'mpegts', 'mpeg', 'asf', 'flv', 'ac3', 'eac3', 'dts', 'wv', 'amr', 'au', 'ape', 'tta', 'loas'];

/**
 * FFmpeg-Eingabeoptionen für eine lokale Mediendatei: nur Protokolle `file` und `pipe`, nur
 * Demuxer aus {@link AUDIO_INPUT_FORMATS}. Gehören direkt vor `-i`.
 *
 * @example
 * ```ts
 * const args = [...safeInputArgs(), '-i', 'music.mp3'];
 * ```
 */
export function safeInputArgs(): string[] {
  return ['-protocol_whitelist', 'file,pipe', '-format_whitelist', AUDIO_INPUT_FORMATS.join(',')];
}

/**
 * Dekodiert eine Audio- oder Videodatei zu Float32 je Kanal.
 *
 * @example
 * ```ts
 * const music = await decodeAudio('music.mp3', { sampleRate: 48000, start: 10, duration: 5 });
 * music.channels[0]?.length; // 240000
 * ```
 */
export async function decodeAudio(path: string, options: DecodeOptions = {}): Promise<PcmBuffer> {
  const sampleRate = options.sampleRate ?? 48000;
  const channels = options.channels ?? 2;
  const { ffmpeg } = locateFfmpeg(options);
  const filters = atempoChain(options.rate ?? 1);
  // Mono wird auf alle Kanäle kopiert (volle Lautstärke). Die automatische Umrechnung von FFmpeg
  // würde Mono als Center mit −3 dB verteilen; das Pan-Gesetz des Mixers soll allein entscheiden.
  const info = await probeMedia(path, options);
  if (info.audio?.channels === 1 && channels > 1) {
    filters.unshift(`pan=${String(channels)}c|${Array.from({ length: channels }, (_, c) => `c${String(c)}=c0`).join('|')}`);
  }
  const args = [
    '-hide_banner', '-loglevel', 'error', '-nostdin',
    ...(options.start !== undefined && options.start > 0 ? ['-ss', options.start.toFixed(6)] : []),
    ...(options.duration !== undefined ? ['-t', Math.max(0, options.duration).toFixed(6)] : []),
    ...safeInputArgs(), '-i', path,
    '-map', '0:a:0', '-vn', '-sn',
    ...(filters.length > 0 ? ['-af', filters.join(',')] : []),
    '-ac', String(channels), '-ar', String(sampleRate),
    '-f', 'f32le', '-c:a', 'pcm_f32le', '-',
  ];
  const { stdout } = await runProcess(ffmpeg, args, {
    timeoutMs: options.timeoutMs ?? 300_000,
    suggestions: ['Check that the file exists and contains an audio stream.', 'Convert the file to WAV with FFmpeg and try again.'],
  });
  const frames = Math.floor(stdout.length / (4 * channels));
  const out = Array.from({ length: channels }, () => new Float32Array(frames));
  const view = new DataView(stdout.buffer, stdout.byteOffset, stdout.byteLength);
  for (let i = 0; i < frames; i++) {
    for (let c = 0; c < channels; c++) {
      const target = out[c];
      if (target !== undefined) target[i] = view.getFloat32((i * channels + c) * 4, true);
    }
  }
  return { sampleRate, channels: out };
}
