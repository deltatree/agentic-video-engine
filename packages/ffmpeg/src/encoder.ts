/**
 * Video-Encoding über einen FFmpeg-Prozess (FR-60..FR-64).
 *
 * Eingabe sind vormultiplizierte RGBA-Bilder. Der Encoder entmultipliziert sie (gerades Alpha)
 * und schreibt sie als `rawvideo rgba` über stdin. Ohne `alpha` wird Alpha auf 255 gesetzt.
 *
 * Determinismus: `-fflags +bitexact`, `-flags:v +bitexact`, `-flags:a +bitexact`,
 * `-map_metadata -1` und eine feste Threadzahl (Standard 4).
 *
 * ## Abbildung von `quality` (0–100, 100 = beste Qualität, Standard 75)
 *
 * | Codec | Parameter | Formel | q=0 | q=75 | q=100 |
 * |---|---|---|---|---|---|
 * | h264 (libx264) | `-crf` | `round(35 − 0.23·q)` | 35 | 18 | 12 |
 * | h265 (libx265) | `-crf` | `round(38 − 0.24·q)` | 38 | 20 | 14 |
 * | vp9 (libvpx-vp9) | `-crf`, `-b:v 0` | `round(55 − 0.4·q)` | 55 | 25 | 15 |
 * | av1 (libsvtav1, libaom-av1) | `-crf` | `round(55 − 0.35·q)` | 55 | 29 | 20 |
 * | h264/h265 Hardware | `-cq`/`-global_quality`/`-qp` | wie CPU-CRF | | | |
 * | h264/h265 VideoToolbox | `-q:v` | `round(q)` | 0 | 75 | 100 |
 * | webp (libwebp) | `-quality` | `round(q)` | 0 | 75 | 100 |
 * | jpeg (mjpeg) | `-q:v` | `round(31 − 0.29·q)` | 31 | 9 | 2 |
 * | prores, prores-4444 | Profil `hq` bzw. `4444` | fest | | | |
 * | ffv1, png, gif | verlustfrei bzw. Palette | fest | | | |
 */
import { spawn, type ChildProcessByStdio } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import type { Readable, Writable } from 'node:stream';
import { OpenVideoError, type ColorSpace, type OutputFormat, type RgbaImage, type VideoCodec } from '@agentic-video/core';
import { probeCapabilities, type FfmpegCapabilities, type HardwareFamily } from './capabilities.js';
import { locateFfmpeg, type FfmpegLocateOptions } from './locate.js';
import { unpremultiplyInto } from './pixels.js';
import { appendLimited, ffmpegEnv, processError, runProcess, spawnError, timeoutError, waitForExit } from './process.js';
import { toRational } from './probe.js';

/** Hardware-Wahl: `auto` nutzt Hardware nur nach erfolgreicher Probe, sonst immer CPU. */
export type HardwareMode = 'auto' | 'none' | HardwareFamily;

/** Audio-Codecs für das Muxen. */
export type AudioCodec = 'aac' | 'opus' | 'pcm';

/** Optionen für {@link createEncoder}. */
export interface EncoderOptions extends FfmpegLocateOptions {
  /** Ausgabedatei, bei `*-sequence` ein Verzeichnis (Dateien `frame-000000.<ext>`). */
  readonly output: string;
  readonly format: OutputFormat;
  /** Standard je Format: mp4/mov → h264 (mov mit Alpha → prores-4444), webm → vp9, gif → gif, webp → webp, png-sequence → png. */
  readonly codec?: VideoCodec;
  readonly width: number;
  readonly height: number;
  readonly fps: number;
  /** 0–100, 100 = beste Qualität (Standard 75). Abbildung siehe Moduldokumentation. */
  readonly quality?: number;
  readonly alpha?: boolean;
  /** Farbraum für die Metadaten (Standard `srgb`). */
  readonly colorSpace?: ColorSpace;
  /** Hardware-Encoder: `none` (Standard, CPU, bitgleich), `auto` (nach Probe) oder eine Familie. */
  readonly hardware?: HardwareMode;
  /** WAV-Datei, die als Tonspur gemuxt wird. */
  readonly audioPath?: string;
  /** Standard: webm → opus, sonst aac. */
  readonly audioCodec?: AudioCodec;
  /** Audio-Bitrate in kbit/s (Standard 192; bei pcm ohne Wirkung). */
  readonly audioBitrate?: number;
  /** Feste Threadzahl für den Encoder (Standard 4). */
  readonly threads?: number;
  /** Timeout für das Schreiben eines Frames und für den Abschluss in Millisekunden (Standard 600 000). */
  readonly timeoutMs?: number;
  /**
   * Codec aus einem Plugin (Story 21.1): ersetzt `codec` und die eingebauten Video-Argumente.
   * `formats` begrenzt die Container; `args` wird gegen eine Allowlist geprüft ({@link checkCustomCodecArgs}).
   */
  readonly customCodec?: CustomCodec;
}

/** Ein Video-Codec aus einem Plugin (`CodecDefinition` in core). */
export interface CustomCodec {
  readonly id: string;
  readonly formats: readonly string[];
  /** FFmpeg-Argumente des Video-Encoders, z. B. `['-c:v', 'libx264', '-crf', '18', '-pix_fmt', 'yuv420p']`. */
  readonly args: readonly string[];
}

/** Zahl, z. B. `18`, `-1`, `0.5`. */
const NUMBER = /^-?\d{1,9}(?:\.\d{1,6})?$/u;
/** Ganzzahl, z. B. `4`, `-1`. */
const INTEGER = /^-?\d{1,9}$/u;
/** Bitrate, z. B. `2500k`, `4M`, `0`. */
const BITRATE = /^\d{1,9}(?:\.\d{1,6})?[kKMG]?$/u;
/** Einfacher Bezeichner ohne Pfad- und Trennzeichen, z. B. `slow`, `yuv420p`, `high`, `4.1`. */
const TOKEN = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/u;
/** Encoder-Name, z. B. `libx264`, `h264_nvenc`, `libsvtav1`. */
const ENCODER = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/u;
/** Wert in `-x264-params` & Co.: keine Pfade (`/`, `\`), keine Trenner (`:`, `=`). */
const PARAM_VALUE = /^[A-Za-z0-9_.,+-]{1,64}$/u;

/** Erlaubte Schlüssel in den Encoder-Parameterlisten (keine Schlüssel mit Dateien, keine Threads). */
const X264_PARAMS: ReadonlySet<string> = new Set([
  'keyint', 'min-keyint', 'scenecut', 'bframes', 'b-adapt', 'b-bias', 'b-pyramid', 'ref', 'no-deblock', 'deblock', 'crf', 'qp', 'qpmin', 'qpmax', 'qpstep',
  'vbv-maxrate', 'vbv-bufsize', 'vbv-init', 'aq-mode', 'aq-strength', 'rc-lookahead', 'mbtree', 'no-mbtree', 'weightp', 'weightb', 'no-weightb', 'me', 'merange',
  'subme', 'psy-rd', 'psy', 'no-psy', 'mixed-refs', 'no-mixed-refs', '8x8dct', 'no-8x8dct', 'trellis', 'fast-pskip', 'no-fast-pskip', 'dct-decimate', 'no-dct-decimate',
  'cabac', 'no-cabac', 'direct', 'partitions', 'open-gop', 'bluray-compat', 'colorprim', 'transfer', 'colormatrix', 'range', 'fullrange', 'nal-hrd', 'filler',
  'chroma-qp-offset', 'deadzone-inter', 'deadzone-intra', 'ipratio', 'pbratio', 'qcomp', 'cplxblur', 'qblur', 'intra-refresh', 'stitchable', 'slices', 'aud',
]);
const X265_PARAMS: ReadonlySet<string> = new Set([
  'keyint', 'min-keyint', 'scenecut', 'bframes', 'b-adapt', 'ref', 'crf', 'qp', 'vbv-maxrate', 'vbv-bufsize', 'vbv-init', 'aq-mode', 'aq-strength', 'rc-lookahead',
  'psy-rd', 'psy-rdoq', 'rdoq-level', 'rd', 'me', 'merange', 'subme', 'deblock', 'no-deblock', 'sao', 'no-sao', 'strong-intra-smoothing', 'no-strong-intra-smoothing',
  'open-gop', 'no-open-gop', 'colorprim', 'transfer', 'colormatrix', 'range', 'master-display', 'max-cll', 'hdr10', 'hdr10-opt', 'repeat-headers', 'aud', 'hrd',
  'profile', 'level-idc', 'high-tier', 'no-high-tier', 'tu-intra-depth', 'tu-inter-depth', 'limit-tu', 'ctu', 'min-cu-size', 'weightp', 'weightb', 'cutree', 'no-cutree',
  'log-level', 'info', 'no-info', 'lossless', 'cbqpoffs', 'crqpoffs', 'selective-sao', 'tskip', 'no-tskip', 'rect', 'no-rect', 'amp', 'no-amp',
]);
const SVTAV1_PARAMS: ReadonlySet<string> = new Set([
  'preset', 'crf', 'qp', 'tune', 'keyint', 'irefresh-type', 'lookahead', 'scd', 'enable-overlays', 'enable-tf', 'enable-qm', 'qm-min', 'qm-max', 'film-grain',
  'film-grain-denoise', 'fast-decode', 'tile-rows', 'tile-columns', 'aq-mode', 'enable-cdef', 'enable-restoration', 'sharpness', 'variance-boost-strength',
  'enable-variance-boost', 'color-primaries', 'transfer-characteristics', 'matrix-coefficients', 'color-range', 'mastering-display', 'content-light', 'hierarchical-levels',
]);
const AOM_PARAMS: ReadonlySet<string> = new Set([
  'tune', 'enable-cdef', 'enable-restoration', 'enable-qm', 'deltaq-mode', 'aq-mode', 'sharpness', 'enable-chroma-deltaq', 'enable-tpl-model', 'arnr-strength',
  'arnr-maxframes', 'lag-in-frames', 'kf-max-dist', 'kf-min-dist', 'enable-fwd-kf', 'cq-level', 'tile-columns', 'tile-rows', 'row-mt', 'denoise-noise-level',
]);

/** Bekannte Flags für `-movflags` (keine, die Dateien lesen oder schreiben). */
const MOVFLAGS: ReadonlySet<string> = new Set([
  'faststart', 'frag_keyframe', 'empty_moov', 'default_base_moof', 'separate_moof', 'omit_tfhd_offset', 'negative_cts_offsets', 'cmaf', 'delay_moov', 'write_colr',
  'write_gama', 'disable_chpl', 'skip_sidx', 'global_sidx', 'frag_discont', 'use_metadata_tags', 'skip_trailer',
]);

/** Prüft `schlüssel=wert:schlüssel=wert` gegen eine Schlüsselliste. */
function paramList(keys: ReadonlySet<string>): (value: string) => boolean {
  return (value) => value.split(':').every((pair) => {
    const eq = pair.indexOf('=');
    const key = eq < 0 ? pair : pair.slice(0, eq);
    return keys.has(key) && (eq < 0 || PARAM_VALUE.test(pair.slice(eq + 1)));
  });
}

/** `-movflags +faststart+frag_keyframe` */
function movflags(value: string): boolean {
  const parts = value.split(/[+-]/u);
  return /^[+-]?[a-z_]+(?:[+-][a-z_]+)*$/u.test(value) && parts.every((p) => p === '' || MOVFLAGS.has(p));
}

/**
 * Allowlist der Optionen in Video-Argumenten eines Plugins (Review Q2): Name → Prüfung des Werts.
 * Jede Option hat genau einen Wert. Nicht enthalten (und damit verboten) sind u. a. Eingaben,
 * Ausgaben, Muxer, Mappings, alle Filter (`-vf`, `-filter*`, `-lavfi`), Fortschritt/Berichte,
 * `-threads` (setzt OpenVideo) und `-r`/`-s` (Maße und Bildrate setzt OpenVideo).
 */
const ALLOWED_CUSTOM_OPTIONS: ReadonlyMap<string, (value: string) => boolean> = (() => {
  const base: [string, (value: string) => boolean][] = [
    ['-c:v', (v) => ENCODER.test(v)],
    ['-codec:v', (v) => ENCODER.test(v)],
    ['-vcodec', (v) => ENCODER.test(v)],
    ['-crf', (v) => NUMBER.test(v)],
    ['-qp', (v) => NUMBER.test(v)],
    ['-q:v', (v) => NUMBER.test(v)],
    ['-cq', (v) => NUMBER.test(v)],
    ['-global_quality', (v) => NUMBER.test(v)],
    ['-qmin', (v) => INTEGER.test(v)],
    ['-qmax', (v) => INTEGER.test(v)],
    ['-b:v', (v) => BITRATE.test(v)],
    ['-minrate', (v) => BITRATE.test(v)],
    ['-maxrate', (v) => BITRATE.test(v)],
    ['-bufsize', (v) => BITRATE.test(v)],
    ['-preset', (v) => TOKEN.test(v)],
    ['-tune', (v) => TOKEN.test(v)],
    ['-profile:v', (v) => TOKEN.test(v)],
    ['-level', (v) => TOKEN.test(v)],
    ['-pix_fmt', (v) => TOKEN.test(v)],
    ['-tag:v', (v) => TOKEN.test(v)],
    ['-colorspace', (v) => TOKEN.test(v)],
    ['-color_primaries', (v) => TOKEN.test(v)],
    ['-color_trc', (v) => TOKEN.test(v)],
    ['-color_range', (v) => TOKEN.test(v)],
    ['-g', (v) => INTEGER.test(v)],
    ['-keyint_min', (v) => INTEGER.test(v)],
    ['-bf', (v) => INTEGER.test(v)],
    ['-refs', (v) => INTEGER.test(v)],
    ['-sc_threshold', (v) => INTEGER.test(v)],
    ['-x264-params', paramList(X264_PARAMS)],
    ['-x265-params', paramList(X265_PARAMS)],
    ['-svtav1-params', paramList(SVTAV1_PARAMS)],
    ['-aom-params', paramList(AOM_PARAMS)],
    ['-row-mt', (v) => INTEGER.test(v)],
    ['-cpu-used', (v) => INTEGER.test(v)],
    ['-deadline', (v) => TOKEN.test(v)],
    ['-quality', (v) => TOKEN.test(v)],
    ['-speed', (v) => INTEGER.test(v)],
    ['-tiles', (v) => /^\d{1,2}x\d{1,2}$/u.test(v)],
    ['-tile-columns', (v) => INTEGER.test(v)],
    ['-tile-rows', (v) => INTEGER.test(v)],
    ['-lag-in-frames', (v) => INTEGER.test(v)],
    ['-auto-alt-ref', (v) => INTEGER.test(v)],
    ['-aq-mode', (v) => INTEGER.test(v)],
    ['-lossless', (v) => INTEGER.test(v)],
    ['-movflags', movflags],
  ];
  const map = new Map<string, (value: string) => boolean>();
  for (const [name, check] of base) {
    map.set(name, check);
    // Gleichbedeutend mit Stream-Angabe für das Video, z. B. `-crf:v`, `-preset:v`.
    if (!name.includes(':') && name !== '-vcodec' && name !== '-movflags') map.set(`${name}:v`, check);
  }
  return map;
})();

const CUSTOM_ARGS_SUGGESTIONS: readonly string[] = [
  'Only pass video encoder options as "-option value" pairs: -c:v, -crf, -qp, -b:v, -maxrate, -bufsize, -preset, -tune, -profile:v, -level, -pix_fmt, -g, -keyint_min, -bf, -x264-params, -x265-params, -row-mt, -cpu-used, -deadline, -movflags and similar.',
  'Inputs, outputs, filters (-vf, -filter*), muxers, stream mappings, threads, frame rate, size, progress/report files and URLs are set by OpenVideo and may not appear.',
];

/**
 * Prüft die FFmpeg-Argumente eines Plugin-Codecs (Story 21.1, Review Q2) gegen eine Allowlist:
 * Jedes Argument ist entweder eine erlaubte Option oder der Wert direkt dahinter. Werte werden
 * je Option geprüft (Zahlen, Bezeichner, Parameterlisten ohne Pfade, bekannte `-movflags`).
 *
 * @example
 * ```ts
 * checkCustomCodecArgs({ id: 'x264-film', formats: ['mp4'], args: ['-c:v', 'libx264', '-tune', 'film'] });
 * ```
 */
export function checkCustomCodecArgs(codec: CustomCodec): void {
  const reject = (arg: string, why: string): OpenVideoError =>
    encodeError('OV_ENCODE_CODEC_ARGS', `Codec "plugin:${codec.id}" uses the FFmpeg argument "${arg}", which plugins may not set (${why}).`, CUSTOM_ARGS_SUGGESTIONS, { codec: codec.id, argument: arg });
  let hasEncoder = false;
  for (let i = 0; i < codec.args.length; i += 2) {
    const name = codec.args[i] ?? '';
    const check = ALLOWED_CUSTOM_OPTIONS.get(name);
    if (check === undefined) throw reject(name, name.startsWith('-') ? 'option not allowed' : 'value without an option');
    const value = codec.args[i + 1];
    if (value === undefined) throw reject(name, 'missing value');
    if (!check(value)) throw reject(`${name} ${value}`, 'value not allowed');
    if (name === '-c:v' || name === '-codec:v' || name === '-vcodec') hasEncoder = true;
  }
  if (!hasEncoder) {
    throw encodeError('OV_ENCODE_CODEC_ARGS', `Codec "plugin:${codec.id}" does not choose an encoder with -c:v.`, ['Return e.g. ["-c:v", "libx264", ...] from encoderArgs.'], { codec: codec.id });
  }
}

/** Ergebnis eines abgeschlossenen Encodings (für das Manifest). */
export interface EncodeResult {
  /** Ausgabedatei oder alle Dateien einer Sequenz. */
  readonly paths: readonly string[];
  readonly frames: number;
  /** Dauer in Sekunden (`frames / fps`). */
  readonly duration: number;
  readonly format: OutputFormat;
  /** Codec; Plugin-Codecs als `plugin:<id>`. */
  readonly codec: VideoCodec | 'jpeg' | `plugin:${string}`;
  /** Verwendeter FFmpeg-Encoder, z. B. `libx264`. */
  readonly encoder: string;
  readonly audioEncoder: string | undefined;
  /** Hardware-Familie oder `undefined` für CPU. */
  readonly hardware: HardwareFamily | undefined;
  readonly ffmpeg: string;
  /** Vollständige FFmpeg-Argumente ohne Programmpfad. */
  readonly args: readonly string[];
}

/** Ein laufender Encoder. */
export interface Encoder {
  /** Schreibt einen vormultiplizierten Frame. */
  write(image: RgbaImage): Promise<void>;
  /** Schließt die Eingabe und wartet auf FFmpeg. */
  finish(): Promise<EncodeResult>;
  /** Bricht ab und löscht die bisher geschriebene Ausgabe. */
  abort(): Promise<void>;
}

const FORMAT_CODECS: Readonly<Record<OutputFormat, readonly VideoCodec[]>> = {
  mp4: ['h264', 'h265', 'vp9', 'av1'],
  mov: ['h264', 'h265', 'prores', 'prores-4444', 'ffv1'],
  webm: ['vp9', 'av1'],
  gif: ['gif'],
  webp: ['webp'],
  'png-sequence': ['png'],
  'jpeg-sequence': [],
  'webp-sequence': ['webp'],
};

const ALPHA_COMBINATIONS: readonly string[] = ['webm/vp9', 'mov/prores-4444', 'png-sequence/png', 'webp-sequence/webp'];

const SEQUENCE_EXT: Partial<Record<OutputFormat, string>> = { 'png-sequence': 'png', 'jpeg-sequence': 'jpg', 'webp-sequence': 'webp' };

function encodeError(code: string, problem: string, suggestions: readonly string[], details?: Record<string, string | number | boolean>): OpenVideoError {
  return new OpenVideoError({ code, errorClass: 'EncodeError', problem, suggestions, ...(details !== undefined ? { details } : {}) });
}

function defaultCodec(format: OutputFormat, alpha: boolean): VideoCodec | 'jpeg' {
  switch (format) {
    case 'mp4':
      return 'h264';
    case 'mov':
      return alpha ? 'prores-4444' : 'h264';
    case 'webm':
      return 'vp9';
    case 'gif':
      return 'gif';
    case 'webp':
    case 'webp-sequence':
      return 'webp';
    case 'png-sequence':
      return 'png';
    case 'jpeg-sequence':
      return 'jpeg';
  }
}

/** Geprüfte, vollständige Encoder-Einstellungen. */
interface Plan {
  readonly format: OutputFormat;
  readonly codec: VideoCodec | 'jpeg' | `plugin:${string}`;
  /** Video-Argumente eines Plugin-Codecs. */
  readonly custom?: CustomCodec;
  readonly alpha: boolean;
  readonly quality: number;
  readonly threads: number;
  readonly colorSpace: ColorSpace;
  readonly hardware: HardwareMode;
  readonly audioCodec: AudioCodec | undefined;
  readonly audioBitrate: number;
  readonly sequenceExt: string | undefined;
}

/** Prüft Format, Codec, Alpha, Maße und Audio ohne Prozessstart. */
function resolvePlan(o: EncoderOptions): Plan {
  const alpha = o.alpha ?? false;
  const allowed = FORMAT_CODECS[o.format];
  const custom = o.customCodec;
  if (custom !== undefined) {
    if (!custom.formats.includes(o.format)) {
      throw encodeError('OV_ENCODE_CODEC_UNSUPPORTED', `Codec "plugin:${custom.id}" is not supported in format "${o.format}".`, [`Use one of: ${custom.formats.join(', ')}.`], { format: o.format, codec: `plugin:${custom.id}` });
    }
    if (SEQUENCE_EXT[o.format] !== undefined) {
      throw encodeError('OV_ENCODE_CODEC_UNSUPPORTED', `Plugin codecs cannot write image sequences ("${o.format}").`, ['Use a container format such as mp4, mov or webm.'], { format: o.format, codec: `plugin:${custom.id}` });
    }
    checkCustomCodecArgs(custom);
  }
  const codec: Plan['codec'] = custom !== undefined ? `plugin:${custom.id}` : (o.codec ?? defaultCodec(o.format, alpha));
  if (custom === undefined && o.codec !== undefined && !allowed.includes(o.codec)) {
    throw encodeError(
      'OV_ENCODE_CODEC_UNSUPPORTED',
      `Codec "${o.codec}" is not supported in format "${o.format}".`,
      allowed.length > 0 ? [`Use one of: ${allowed.join(', ')}.`] : [`Omit the codec for format "${o.format}".`],
      { format: o.format, codec: o.codec },
    );
  }
  if (alpha && custom === undefined && !ALPHA_COMBINATIONS.includes(`${o.format}/${codec}`)) {
    throw encodeError('OV_ENCODE_ALPHA_UNSUPPORTED', `Format "${o.format}" with codec "${codec}" cannot store alpha.`, [
      'Use format "webm" with codec "vp9" (yuva420p).',
      'Use format "mov" with codec "prores-4444" (yuva444p10le).',
      'Use format "png-sequence" or "webp-sequence".',
      'Or set alpha: false and render over an opaque background.',
    ], { format: o.format, codec });
  }
  if (!Number.isInteger(o.width) || !Number.isInteger(o.height) || o.width < 1 || o.height < 1) {
    throw encodeError('OV_ENCODE_SIZE', `Invalid frame size ${String(o.width)}x${String(o.height)}.`, ['Use positive integer width and height.']);
  }
  if (['h264', 'h265', 'prores', 'prores-4444'].includes(codec) && (o.width % 2 !== 0 || o.height % 2 !== 0)) {
    throw encodeError('OV_ENCODE_SIZE', `Codec "${codec}" needs an even width and height, got ${String(o.width)}x${String(o.height)}.`, [
      `Use ${String(o.width + (o.width % 2))}x${String(o.height + (o.height % 2))}.`,
      'Or use codec "vp9" or a PNG sequence.',
    ]);
  }
  if (!(o.fps > 0) || !Number.isFinite(o.fps)) throw encodeError('OV_ENCODE_FPS', `Invalid frame rate ${String(o.fps)}.`, ['Use a frame rate above 0, e.g. 30.']);
  let audioCodec: AudioCodec | undefined;
  if (o.audioPath !== undefined) {
    const audioAllowed: Partial<Record<OutputFormat, readonly AudioCodec[]>> = { mp4: ['aac', 'opus'], mov: ['aac', 'pcm'], webm: ['opus'] };
    const list = audioAllowed[o.format];
    audioCodec = o.audioCodec ?? (o.format === 'webm' ? 'opus' : 'aac');
    if (list === undefined || !list.includes(audioCodec)) {
      throw encodeError(
        'OV_ENCODE_AUDIO_UNSUPPORTED',
        `Format "${o.format}" cannot carry audio codec "${audioCodec}".`,
        list === undefined ? ['Use format mp4, mov or webm for video with sound.', 'Or remove audioPath and write the WAV file separately.'] : [`Use audioCodec: ${list.map((c) => `"${c}"`).join(' or ')}.`],
        { format: o.format, audioCodec },
      );
    }
  }
  const quality = Math.min(100, Math.max(0, o.quality ?? 75));
  return {
    format: o.format,
    codec,
    ...(custom !== undefined ? { custom } : {}),
    alpha,
    quality,
    threads: Math.max(1, Math.floor(o.threads ?? 4)),
    colorSpace: o.colorSpace ?? 'srgb',
    // Standard `none` (Story 21.5): gleiche Bytes auf jeder Maschine; Hardware-Encoding nur als Opt-in.
    hardware: o.hardware ?? 'none',
    audioCodec,
    audioBitrate: o.audioBitrate ?? 192,
    sequenceExt: SEQUENCE_EXT[o.format],
  };
}

/** Wählt die Hardware-Familie: nur bei erfolgreicher Probe, sonst CPU (`undefined`). */
function pickHardware(plan: Plan, caps: FfmpegCapabilities): HardwareFamily | undefined {
  if (plan.hardware === 'none' || (plan.codec !== 'h264' && plan.codec !== 'h265')) return undefined;
  if (plan.hardware !== 'auto') return caps.hardwareEncoders[plan.hardware] ? plan.hardware : undefined;
  return (['nvenc', 'qsv', 'vaapi', 'videotoolbox'] as const).find((f) => caps.hardwareEncoders[f]);
}

function need(caps: FfmpegCapabilities, candidates: readonly string[], codec: string): string {
  const found = candidates.find((c) => caps.encoders.includes(c));
  if (found === undefined) {
    throw encodeError('OV_ENCODE_CODEC_UNAVAILABLE', `This FFmpeg build has no encoder for "${codec}" (looked for ${candidates.join(', ')}).`, [
      'Install an FFmpeg build with the encoder, e.g. a "full" static build.',
      'Or choose another codec.',
    ], { codec, ffmpegVersion: caps.version });
  }
  return found;
}

const TRC: Readonly<Record<ColorSpace, string>> = { srgb: 'iec61966-2-1', rec709: 'bt709', linear: 'linear' };

interface VideoArgs {
  readonly encoder: string;
  readonly args: readonly string[];
}

/** Baut die Video-Encoder-Argumente (nach den Eingaben). */
function videoArgs(plan: Plan, caps: FfmpegCapabilities, hw: HardwareFamily | undefined): VideoArgs {
  const q = plan.quality;
  const yuv = (pix: string, extra: readonly string[] = []) => [
    '-vf', `scale=out_color_matrix=bt709:out_range=tv,format=${pix}`,
    '-pix_fmt', pix,
    '-colorspace', 'bt709', '-color_primaries', 'bt709', '-color_trc', TRC[plan.colorSpace], '-color_range', 'tv',
    ...extra,
  ];
  const mp4Tag = plan.format === 'mp4' || plan.format === 'mov';
  if (plan.custom !== undefined) {
    const at = plan.custom.args.findIndex((a) => a === '-c:v' || a === '-codec:v' || a === '-vcodec');
    return { encoder: plan.custom.args[at + 1] ?? plan.custom.id, args: [...plan.custom.args] };
  }
  if (hw !== undefined && (plan.codec === 'h264' || plan.codec === 'h265')) {
    const encoder = need(caps, [`${plan.codec === 'h264' ? 'h264' : 'hevc'}_${hw}`], plan.codec);
    const crf = String(plan.codec === 'h264' ? Math.round(35 - 0.23 * q) : Math.round(38 - 0.24 * q));
    const tag = plan.codec === 'h265' && mp4Tag ? ['-tag:v', 'hvc1'] : [];
    switch (hw) {
      case 'nvenc':
        return { encoder, args: [...yuv('yuv420p'), '-c:v', encoder, '-rc', 'vbr', '-cq', crf, '-b:v', '0', ...tag] };
      case 'qsv':
        return { encoder, args: [...yuv('nv12'), '-c:v', encoder, '-global_quality', crf, ...tag] };
      case 'vaapi':
        return {
          encoder,
          args: ['-vf', 'scale=out_color_matrix=bt709:out_range=tv,format=nv12,hwupload', '-colorspace', 'bt709', '-color_primaries', 'bt709', '-color_trc', TRC[plan.colorSpace], '-c:v', encoder, '-qp', crf, ...tag],
        };
      case 'videotoolbox':
        return { encoder, args: [...yuv('nv12'), '-c:v', encoder, '-q:v', String(Math.round(q)), ...tag] };
    }
  }
  switch (plan.codec) {
    case 'h264':
      return { encoder: 'libx264', args: [...yuv('yuv420p'), '-c:v', need(caps, ['libx264'], 'h264'), '-crf', String(Math.round(35 - 0.23 * q)), '-preset', 'medium'] };
    case 'h265':
      return {
        encoder: 'libx265',
        args: [...yuv('yuv420p'), '-c:v', need(caps, ['libx265'], 'h265'), '-crf', String(Math.round(38 - 0.24 * q)), '-preset', 'medium', '-x265-params', `log-level=error:pools=${String(plan.threads)}:frame-threads=1`, ...(mp4Tag ? ['-tag:v', 'hvc1'] : [])],
      };
    case 'vp9':
      return {
        encoder: 'libvpx-vp9',
        args: [...yuv(plan.alpha ? 'yuva420p' : 'yuv420p'), '-c:v', need(caps, ['libvpx-vp9'], 'vp9'), '-crf', String(Math.round(55 - 0.4 * q)), '-b:v', '0', '-deadline', 'good', '-cpu-used', '4', '-row-mt', '1'],
      };
    case 'av1': {
      const encoder = need(caps, ['libsvtav1', 'libaom-av1'], 'av1');
      const crf = String(Math.round(55 - 0.35 * q));
      const tuning = encoder === 'libsvtav1' ? ['-preset', '8'] : ['-b:v', '0', '-cpu-used', '6', '-row-mt', '1'];
      return { encoder, args: [...yuv('yuv420p'), '-c:v', encoder, '-crf', crf, ...tuning] };
    }
    case 'prores':
      return { encoder: 'prores_ks', args: [...yuv('yuv422p10le'), '-c:v', need(caps, ['prores_ks'], 'prores'), '-profile:v', 'hq'] };
    case 'prores-4444':
      return {
        encoder: 'prores_ks',
        args: [...yuv(plan.alpha ? 'yuva444p10le' : 'yuv444p10le'), '-c:v', need(caps, ['prores_ks'], 'prores-4444'), '-profile:v', '4444', ...(plan.alpha ? ['-alpha_bits', '16'] : [])],
      };
    case 'ffv1':
      return { encoder: 'ffv1', args: ['-pix_fmt', 'bgr0', '-c:v', need(caps, ['ffv1'], 'ffv1'), '-level', '3', '-g', '1'] };
    case 'png':
      return { encoder: 'png', args: ['-pix_fmt', plan.alpha ? 'rgba' : 'rgb24', '-c:v', need(caps, ['png'], 'png')] };
    case 'gif':
      return {
        encoder: 'gif',
        args: ['-vf', 'split[a][b];[a]palettegen=reserve_transparent=0:stats_mode=full[p];[b][p]paletteuse=dither=bayer:bayer_scale=3', '-c:v', need(caps, ['gif'], 'gif'), '-loop', '0'],
      };
    case 'webp': {
      if (plan.format === 'webp') {
        const encoder = need(caps, ['libwebp_anim', 'libwebp'], 'webp');
        return { encoder, args: ['-pix_fmt', 'bgra', '-c:v', encoder, '-quality', String(Math.round(q)), '-lossless', '0', '-loop', '0'] };
      }
      return { encoder: 'libwebp', args: ['-pix_fmt', 'bgra', '-c:v', need(caps, ['libwebp'], 'webp'), '-quality', String(Math.round(q)), '-lossless', '0'] };
    }
    case 'jpeg':
      return { encoder: 'mjpeg', args: ['-pix_fmt', 'yuvj420p', '-c:v', need(caps, ['mjpeg'], 'jpeg'), '-q:v', String(Math.round(31 - 0.29 * q))] };
    default:
      // Plugin-Codecs sind oben behandelt; ohne ihre Argumente gibt es keinen Encoder.
      throw encodeError('OV_ENCODE_CODEC_UNSUPPORTED', `Codec "${plan.codec}" has no encoder arguments.`, ['Register the codec with a plugin (settings.plugins) or use a built-in codec.'], { codec: plan.codec });
  }
}

function audioEncoderOf(codec: AudioCodec, caps: FfmpegCapabilities): string {
  switch (codec) {
    case 'aac':
      return need(caps, ['aac'], 'aac');
    case 'opus':
      return need(caps, ['libopus', 'opus'], 'opus');
    case 'pcm':
      return need(caps, ['pcm_s24le', 'pcm_s16le'], 'pcm');
  }
}

/** Baut alle Argumente und liefert Encoder-Namen. */
function buildArgs(o: EncoderOptions, plan: Plan, caps: FfmpegCapabilities): { args: string[]; encoder: string; audioEncoder: string | undefined; hardware: HardwareFamily | undefined; target: string } {
  const hardware = pickHardware(plan, caps);
  const video = videoArgs(plan, caps, hardware);
  const rate = toRational(o.fps);
  const input = [
    '-hide_banner', '-loglevel', 'error', '-nostdin', '-y',
    ...(hardware === 'vaapi' ? ['-vaapi_device', '/dev/dri/renderD128'] : []),
    '-f', 'rawvideo', '-pix_fmt', 'rgba', '-s', `${String(o.width)}x${String(o.height)}`, '-framerate', `${String(rate.num)}/${String(rate.den)}`, '-i', 'pipe:0',
  ];
  let audioEncoder: string | undefined;
  const audio: string[] = [];
  if (o.audioPath !== undefined && plan.audioCodec !== undefined) {
    audioEncoder = audioEncoderOf(plan.audioCodec, caps);
    // Nur eine lokale WAV-Datei (Mix aus der Audio-Engine), keine Playlists oder Netzquellen (M3, Story 16.5).
    input.push('-protocol_whitelist', 'file', '-format_whitelist', 'wav,w64', '-i', o.audioPath);
    audio.push('-map', '0:v:0', '-map', '1:a:0', '-c:a', audioEncoder, ...(plan.audioCodec === 'pcm' ? [] : ['-b:a', `${String(plan.audioBitrate)}k`]), '-shortest');
  } else {
    audio.push('-map', '0:v:0');
  }
  const determinism = ['-threads', String(plan.threads), '-fflags', '+bitexact', '-flags:v', '+bitexact', '-flags:a', '+bitexact', '-map_metadata', '-1'];
  let target = o.output;
  let muxer: string[];
  if (plan.sequenceExt !== undefined) {
    target = join(o.output, `frame-%06d.${plan.sequenceExt}`);
    muxer = ['-f', 'image2', '-start_number', '0'];
  } else {
    muxer = ['-f', plan.format === 'mov' ? 'mov' : plan.format === 'webp' ? 'webp' : plan.format];
  }
  return { args: [...input, ...audio, ...video.args, ...determinism, ...muxer, target], encoder: video.encoder, audioEncoder, hardware, target };
}

/**
 * Erzeugt einen Encoder. Prüft Format, Codec, Alpha und Audio sofort; FFmpeg startet mit dem ersten Frame.
 * `hardware` ist standardmäßig `none` (CPU, bitgleich auf jeder Maschine). `auto` nutzt Hardware
 * nur nach erfolgreicher Probe, sonst CPU; `nvenc`/`vaapi`/`qsv`/`videotoolbox` verlangen die Familie.
 *
 * @example
 * ```ts
 * const enc = createEncoder({ output: 'out.mp4', format: 'mp4', codec: 'h264', width: 1920, height: 1080, fps: 30 });
 * for (const frame of frames) await enc.write(frame);
 * const result = await enc.finish();
 * ```
 */
export function createEncoder(options: EncoderOptions): Encoder {
  const plan = resolvePlan(options);
  const bins = locateFfmpeg(options);
  const timeoutMs = options.timeoutMs ?? 600_000;
  const frameBytes = options.width * options.height * 4;
  let child: ChildProcessByStdio<Writable, null, Readable> | undefined;
  let starting: Promise<void> | undefined;
  let built: ReturnType<typeof buildArgs> | undefined;
  let stderr = '';
  let stdinError = '';
  let exited: string | undefined;
  let exitPromise: Promise<string> | undefined;
  let spawnFailure: unknown;
  let frames = 0;
  let state: 'open' | 'finished' | 'aborted' = 'open';

  const failure = (): OpenVideoError =>
    spawnFailure !== undefined
      ? spawnError(bins.ffmpeg, spawnFailure)
      : // Die Meldung von FFmpeg zuerst; ein Schreibfehler auf stdin (EPIPE) ist nur die Folge davon.
        processError(bins.ffmpeg, built?.args ?? [], stderr.trim() !== '' ? stderr : stdinError, exited ?? 'stdin closed', ['Check details.lastStderr for the FFmpeg message.', 'Check the codec, size and audio options.']);

  const start = async (): Promise<void> => {
    const caps = await probeCapabilities({ ffmpegPath: bins.ffmpeg, ffprobePath: bins.ffprobe });
    built = buildArgs(options, plan, caps);
    try {
      mkdirSync(plan.sequenceExt !== undefined ? options.output : dirname(options.output), { recursive: true });
    } catch (error) {
      throw new OpenVideoError({
        code: 'OV_ENCODE_OUTPUT',
        errorClass: 'EncodeError',
        problem: `Cannot create the output directory for "${options.output}": ${error instanceof Error ? error.message : String(error)}`,
        details: { output: options.output },
        suggestions: ['Check the output path and its write permissions.'],
        cause: error,
      });
    }
    const proc = spawn(bins.ffmpeg, built.args, { stdio: ['pipe', 'ignore', 'pipe'], env: ffmpegEnv() });
    child = proc;
    proc.stderr.setEncoding('utf8');
    proc.stderr.on('data', (c: string) => { stderr = appendLimited(stderr, c); });
    proc.stdin.on('error', (error) => { stdinError = `stdin: ${error.message}`; });
    proc.on('error', (error) => { spawnFailure = error; });
    // Synchron vermerken, damit spätere `close`-Beobachter den Exit-Status schon sehen.
    proc.once('close', (code: number | null, signal: NodeJS.Signals | null) => {
      exited = code !== null ? `exit code ${String(code)}` : `signal ${signal ?? 'unknown'}`;
    });
    exitPromise = waitForExit(proc);
  };

  const ensureStarted = (): Promise<void> => {
    starting ??= start();
    return starting;
  };

  const withTimeout = async <T>(promise: Promise<T>, what: string): Promise<T> => {
    let timer: NodeJS.Timeout | undefined;
    const limit = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        child?.kill('SIGKILL');
        reject(timeoutError(bins.ffmpeg, built?.args ?? [what], stderr, timeoutMs));
      }, timeoutMs);
    });
    try {
      return await Promise.race([promise, limit]);
    } finally {
      clearTimeout(timer);
    }
  };

  const outputs = (): string[] => {
    if (plan.sequenceExt === undefined) return [options.output];
    const ext = plan.sequenceExt;
    return Array.from({ length: frames }, (_, i) => join(options.output, `frame-${String(i).padStart(6, '0')}.${ext}`));
  };

  const closed = (): OpenVideoError =>
    encodeError('OV_ENCODE_CLOSED', `The encoder is already ${state}.`, ['Create a new encoder with createEncoder().']);

  return {
    async write(image: RgbaImage): Promise<void> {
      if (state !== 'open') throw closed();
      if (image.width !== options.width || image.height !== options.height || image.data.length !== frameBytes) {
        throw encodeError('OV_ENCODE_SIZE', `Frame size ${String(image.width)}x${String(image.height)} does not match the encoder size ${String(options.width)}x${String(options.height)}.`, [
          'Render frames at the encoder size.',
          'Or create the encoder with the frame size.',
        ]);
      }
      await ensureStarted();
      const proc = child;
      if (proc === undefined || exited !== undefined || spawnFailure !== undefined) throw failure();
      const buf = Buffer.allocUnsafe(frameBytes);
      unpremultiplyInto(image, buf);
      if (!plan.alpha) for (let i = 3; i < buf.length; i += 4) buf[i] = 255;
      frames++;
      if (proc.stdin.write(buf)) return;
      const drained = new Promise<void>((resolve, reject) => {
        const onDrain = () => { proc.off('close', onClose); resolve(); };
        const onClose = () => { proc.stdin.off('drain', onDrain); reject(failure()); };
        proc.stdin.once('drain', onDrain);
        proc.once('close', onClose);
      });
      await withTimeout(drained, 'write');
    },

    async finish(): Promise<EncodeResult> {
      if (state !== 'open') throw closed();
      if (frames === 0) {
        throw encodeError('OV_ENCODE_EMPTY', 'No frames were written.', ['Write at least one frame before finish().', 'Call abort() to cancel an empty encode.']);
      }
      state = 'finished';
      const proc = child;
      if (proc === undefined || exitPromise === undefined || built === undefined) throw failure();
      proc.stdin.end();
      const desc = await withTimeout(exitPromise, 'finish');
      if (desc !== 'exit code 0' || spawnFailure !== undefined) throw failure();
      return {
        paths: outputs(),
        frames,
        duration: frames / options.fps,
        format: plan.format,
        codec: plan.codec,
        encoder: built.encoder,
        audioEncoder: built.audioEncoder,
        hardware: built.hardware,
        ffmpeg: bins.ffmpeg,
        args: built.args,
      };
    },

    async abort(): Promise<void> {
      if (state === 'aborted') return;
      state = 'aborted';
      if (starting !== undefined) {
        await starting.catch(() => undefined);
      }
      const proc = child;
      if (proc !== undefined && exited === undefined) {
        proc.kill('SIGKILL');
        await exitPromise;
      }
      for (const p of outputs()) rmSync(p, { force: true });
    },
  };
}

/** Optionen für {@link concatSegments}. */
export interface ConcatOptions extends FfmpegLocateOptions {
  readonly timeoutMs?: number;
}

/**
 * Fügt Segmente gleicher Kodierung ohne Neukodierung zusammen (concat-Demuxer, Stream Copy).
 * Für Chunk-Rendering: jedes Segment wurde mit denselben Encoder-Einstellungen erzeugt.
 *
 * @example
 * ```ts
 * await concatSegments(['part-0.mp4', 'part-1.mp4'], 'out.mp4');
 * ```
 */
export async function concatSegments(paths: readonly string[], outPath: string, options: ConcatOptions = {}): Promise<{ readonly path: string; readonly args: readonly string[] }> {
  if (paths.length === 0) throw encodeError('OV_ENCODE_EMPTY', 'concatSegments needs at least one segment.', ['Pass the paths of the rendered segments.']);
  const { ffmpeg } = locateFfmpeg(options);
  const dir = mkdtempSync(join(tmpdir(), 'openvideo-concat-'));
  try {
    const list = join(dir, 'list.txt');
    writeFileSync(list, paths.map((p) => `file '${resolve(p).replaceAll("'", "'\\''")}'`).join('\n') + '\n');
    mkdirSync(dirname(outPath), { recursive: true });
    const args = ['-hide_banner', '-loglevel', 'error', '-nostdin', '-y', '-f', 'concat', '-safe', '0', '-i', list, '-map', '0', '-c', 'copy', '-fflags', '+bitexact', '-map_metadata', '-1', outPath];
    await runProcess(ffmpeg, args, {
      timeoutMs: options.timeoutMs ?? 600_000,
      suggestions: ['Check that all segments exist and use the same codec, size, frame rate and audio settings.'],
    });
    return { path: outPath, args };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
