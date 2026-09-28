/**
 * Fähigkeiten der installierten FFmpeg-Version: Version, Lizenz, Encoder, Decoder,
 * Hardware-Beschleunigung (FR-60..FR-64) und die Lizenztabelle der Codecs.
 */
import { runProcess } from './process.js';
import { locateFfmpeg, type FfmpegLocateOptions } from './locate.js';

/** Hardware-Encoder-Familien. */
export const HARDWARE_FAMILIES = ['nvenc', 'vaapi', 'qsv', 'videotoolbox'] as const;
export type HardwareFamily = (typeof HARDWARE_FAMILIES)[number];

/**
 * Lizenz des FFmpeg-Builds, abgeleitet aus `--enable-gpl`, `--enable-version3` und `--enable-nonfree`.
 * `LGPL-3.0-or-later` ergänzt die Liste der Spezifikation für Builds mit nur `--enable-version3`.
 */
export type FfmpegLicense = 'LGPL-2.1-or-later' | 'LGPL-3.0-or-later' | 'GPL-2.0-or-later' | 'GPL-3.0-or-later' | 'nonfree';

/** Ergebnis von {@link probeCapabilities}. */
export interface FfmpegCapabilities {
  readonly ffmpeg: string;
  readonly ffprobe: string;
  readonly version: string;
  readonly configuration: string;
  readonly license: FfmpegLicense;
  readonly encoders: readonly string[];
  readonly decoders: readonly string[];
  readonly hwaccels: readonly string[];
  /** `true` nur, wenn ein Encoder der Familie existiert UND eine Probe-Kodierung von 1 Frame gelang. */
  readonly hardwareEncoders: Readonly<Record<HardwareFamily, boolean>>;
}

/** Optionen für {@link probeCapabilities}. */
export interface CapabilityOptions extends FfmpegLocateOptions {
  /** Timeout je Prozessaufruf in Millisekunden (Standard 20 000). */
  readonly timeoutMs?: number;
}

/** Lizenzeintrag eines Encoders für das Render-Manifest. */
export interface CodecLicense {
  /** SPDX-Kennung der Bibliothek. */
  readonly license: string;
  /** Bibliothek oder Projekt, das den Encoder stellt. */
  readonly library: string;
  /** Braucht der Encoder einen GPL-Build von FFmpeg? */
  readonly requiresGpl: boolean;
}

/**
 * Lizenzen der Encoder, die OpenVideo nutzt (für das Manifest).
 *
 * @example
 * ```ts
 * codecLicenses['libx264']?.license; // 'GPL-2.0-or-later'
 * ```
 */
export const codecLicenses: Readonly<Record<string, CodecLicense>> = {
  libx264: { license: 'GPL-2.0-or-later', library: 'x264', requiresGpl: true },
  libx265: { license: 'GPL-2.0-or-later', library: 'x265', requiresGpl: true },
  'libvpx-vp9': { license: 'BSD-3-Clause', library: 'libvpx', requiresGpl: false },
  'libaom-av1': { license: 'BSD-2-Clause', library: 'libaom', requiresGpl: false },
  libsvtav1: { license: 'BSD-3-Clause-Clear', library: 'SVT-AV1', requiresGpl: false },
  prores_ks: { license: 'LGPL-2.1-or-later', library: 'FFmpeg', requiresGpl: false },
  ffv1: { license: 'LGPL-2.1-or-later', library: 'FFmpeg', requiresGpl: false },
  png: { license: 'LGPL-2.1-or-later', library: 'FFmpeg', requiresGpl: false },
  gif: { license: 'LGPL-2.1-or-later', library: 'FFmpeg', requiresGpl: false },
  mjpeg: { license: 'LGPL-2.1-or-later', library: 'FFmpeg', requiresGpl: false },
  libwebp: { license: 'BSD-3-Clause', library: 'libwebp', requiresGpl: false },
  libwebp_anim: { license: 'BSD-3-Clause', library: 'libwebp', requiresGpl: false },
  aac: { license: 'LGPL-2.1-or-later', library: 'FFmpeg', requiresGpl: false },
  libopus: { license: 'BSD-3-Clause', library: 'libopus', requiresGpl: false },
  pcm_s16le: { license: 'LGPL-2.1-or-later', library: 'FFmpeg', requiresGpl: false },
  pcm_s24le: { license: 'LGPL-2.1-or-later', library: 'FFmpeg', requiresGpl: false },
  h264_nvenc: { license: 'LGPL-2.1-or-later', library: 'FFmpeg (NVIDIA driver required)', requiresGpl: false },
  hevc_nvenc: { license: 'LGPL-2.1-or-later', library: 'FFmpeg (NVIDIA driver required)', requiresGpl: false },
  h264_vaapi: { license: 'LGPL-2.1-or-later', library: 'FFmpeg (VA-API driver required)', requiresGpl: false },
  hevc_vaapi: { license: 'LGPL-2.1-or-later', library: 'FFmpeg (VA-API driver required)', requiresGpl: false },
  h264_qsv: { license: 'LGPL-2.1-or-later', library: 'FFmpeg (Intel oneVPL required)', requiresGpl: false },
  hevc_qsv: { license: 'LGPL-2.1-or-later', library: 'FFmpeg (Intel oneVPL required)', requiresGpl: false },
  h264_videotoolbox: { license: 'LGPL-2.1-or-later', library: 'FFmpeg (Apple VideoToolbox)', requiresGpl: false },
  hevc_videotoolbox: { license: 'LGPL-2.1-or-later', library: 'FFmpeg (Apple VideoToolbox)', requiresGpl: false },
};

/**
 * Leitet die Lizenz eines Builds aus seiner Konfigurationszeile ab.
 *
 * @example
 * ```ts
 * licenseOf('--enable-gpl --enable-version3'); // 'GPL-3.0-or-later'
 * ```
 */
export function licenseOf(configuration: string): FfmpegLicense {
  const has = (flag: string) => configuration.split(/\s+/u).includes(flag);
  if (has('--enable-nonfree')) return 'nonfree';
  if (has('--enable-gpl')) return has('--enable-version3') ? 'GPL-3.0-or-later' : 'GPL-2.0-or-later';
  return has('--enable-version3') ? 'LGPL-3.0-or-later' : 'LGPL-2.1-or-later';
}

/** Liest die Namen aus `ffmpeg -encoders` bzw. `-decoders`. */
export function parseCodecList(text: string): string[] {
  const out: string[] = [];
  let started = false;
  for (const line of text.split(/\r?\n/u)) {
    if (!started) {
      if (/^\s*-{6}\s*$/u.test(line)) started = true;
      continue;
    }
    const m = /^\s[VAS][A-Z.]{5}\s+(\S+)/u.exec(line);
    if (m?.[1] !== undefined) out.push(m[1]);
  }
  return out;
}

function parseHwaccels(text: string): string[] {
  const lines = text.split(/\r?\n/u).map((l) => l.trim());
  const start = lines.findIndex((l) => l.startsWith('Hardware acceleration methods'));
  return start < 0 ? [] : lines.slice(start + 1).filter((l) => l.length > 0);
}

/** Argumente für die Probe-Kodierung eines Frames je Familie. */
function probeArgs(family: HardwareFamily, encoder: string): string[] {
  const input = ['-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'color=c=black:s=256x256:r=30:d=1'];
  const tail = ['-frames:v', '1', '-c:v', encoder, '-f', 'null', '-'];
  switch (family) {
    case 'vaapi':
      return ['-hide_banner', '-loglevel', 'error', '-vaapi_device', '/dev/dri/renderD128', ...input.slice(3), '-vf', 'format=nv12,hwupload', ...tail];
    case 'qsv':
      return [...input, '-vf', 'format=nv12', ...tail];
    default:
      return [...input, '-pix_fmt', family === 'videotoolbox' ? 'nv12' : 'yuv420p', ...tail];
  }
}

async function probeHardware(ffmpeg: string, family: HardwareFamily, encoders: readonly string[], timeoutMs: number): Promise<boolean> {
  const encoder = [`h264_${family}`, `hevc_${family}`].find((e) => encoders.includes(e));
  if (encoder === undefined) return false;
  try {
    await runProcess(ffmpeg, probeArgs(family, encoder), { timeoutMs });
    return true;
  } catch (error) {
    // Die Probe schlägt ohne passende Hardware fehl: das ist ein gültiges Ergebnis.
    if (error instanceof Error) return false;
    throw error;
  }
}

const cache = new Map<string, Promise<FfmpegCapabilities>>();

async function detect(ffmpeg: string, ffprobe: string, timeoutMs: number): Promise<FfmpegCapabilities> {
  const run = async (args: string[]) => (await runProcess(ffmpeg, args, { timeoutMs })).stdout.toString('utf8');
  const [versionText, encoderText, decoderText, hwText] = await Promise.all([
    run(['-hide_banner', '-version']),
    run(['-hide_banner', '-encoders']),
    run(['-hide_banner', '-decoders']),
    run(['-hide_banner', '-hwaccels']),
  ]);
  const version = /version\s+(\S+)/u.exec(versionText)?.[1] ?? 'unknown';
  const configuration = /configuration:\s*(.*)/u.exec(versionText)?.[1]?.trim() ?? '';
  const encoders = parseCodecList(encoderText);
  const results = await Promise.all(HARDWARE_FAMILIES.map((f) => probeHardware(ffmpeg, f, encoders, timeoutMs)));
  const hardwareEncoders = { nvenc: results[0] ?? false, vaapi: results[1] ?? false, qsv: results[2] ?? false, videotoolbox: results[3] ?? false };
  return {
    ffmpeg,
    ffprobe,
    version,
    configuration,
    license: licenseOf(configuration),
    encoders,
    decoders: parseCodecList(decoderText),
    hwaccels: parseHwaccels(hwText),
    hardwareEncoders,
  };
}

/**
 * Ermittelt Version, Lizenz, Encoder, Decoder und Hardware-Encoder der FFmpeg-Installation.
 * Das Ergebnis wird je FFmpeg-Pfad zwischengespeichert.
 *
 * @example
 * ```ts
 * const caps = await probeCapabilities();
 * if (caps.hardwareEncoders.nvenc) console.info('NVENC available');
 * ```
 */
export function probeCapabilities(options: CapabilityOptions = {}): Promise<FfmpegCapabilities> {
  const { ffmpeg, ffprobe } = locateFfmpeg(options);
  const key = `${ffmpeg}\u0000${ffprobe}`;
  let hit = cache.get(key);
  if (hit === undefined) {
    hit = detect(ffmpeg, ffprobe, options.timeoutMs ?? 20_000);
    cache.set(key, hit);
    // Fehlgeschlagene Ermittlungen werden nicht behalten, damit ein neuer Versuch möglich ist.
    hit.catch((error: unknown) => {
      cache.delete(key);
      return error;
    });
  }
  return hit;
}
