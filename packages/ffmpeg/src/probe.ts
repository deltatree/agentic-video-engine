/**
 * Inspektion von Mediendateien über ffprobe und Einzelbild-Export.
 */
import { OpenVideoError, isRecord, type RgbaImage } from '@agentic-video/core';
import { locateFfmpeg, type FfmpegLocateOptions } from './locate.js';
import { premultiplyInPlace } from './pixels.js';
import { runProcess } from './process.js';

/** Bruch mit Zahlenwert, z. B. 30000/1001 ≈ 29.97. */
export interface Rational {
  readonly num: number;
  readonly den: number;
  readonly value: number;
}

/** Ein Stream einer Mediendatei. Fehlende Angaben sind `undefined`. */
export interface StreamInfo {
  readonly index: number;
  readonly type: 'video' | 'audio' | 'subtitle' | 'data' | 'attachment' | 'unknown';
  readonly codec: string;
  readonly profile: string | undefined;
  readonly width: number | undefined;
  readonly height: number | undefined;
  readonly fps: Rational | undefined;
  /** Anzahl der Frames bzw. Pakete. */
  readonly frameCount: number | undefined;
  readonly pixFmt: string | undefined;
  readonly colorSpace: string | undefined;
  readonly colorTransfer: string | undefined;
  readonly colorPrimaries: string | undefined;
  readonly colorRange: string | undefined;
  /** Alpha über das Pixelformat oder die Matroska-Kennung `alpha_mode` (VP9). */
  readonly hasAlpha: boolean;
  readonly sampleRate: number | undefined;
  readonly channels: number | undefined;
  readonly channelLayout: string | undefined;
  readonly duration: number | undefined;
  readonly bitRate: number | undefined;
  readonly metadata: Readonly<Record<string, string>>;
}

/** Ergebnis von {@link probeMedia}. */
export interface MediaInfo {
  readonly path: string;
  /** Container laut ffprobe, z. B. `mov,mp4,m4a,3gp,3g2,mj2` oder `matroska,webm`. */
  readonly container: string;
  readonly duration: number | undefined;
  readonly bitRate: number | undefined;
  readonly streams: readonly StreamInfo[];
  /** Erster Video-Stream. */
  readonly video: StreamInfo | undefined;
  /** Erster Audio-Stream. */
  readonly audio: StreamInfo | undefined;
  readonly hasAlpha: boolean;
  readonly metadata: Readonly<Record<string, string>>;
}

/** Optionen für Inspektion und Einzelbilder. */
export interface ProbeOptions extends FfmpegLocateOptions {
  readonly timeoutMs?: number;
}

/**
 * Wandelt eine Bildrate in einen Bruch um. NTSC-Raten (29.97, 59.94, 23.976) werden exakt erkannt.
 *
 * @example
 * ```ts
 * toRational(29.97); // { num: 30000, den: 1001, value: 29.97002997 }
 * toRational(25); // { num: 25, den: 1, value: 25 }
 * ```
 */
export function toRational(fps: number): Rational {
  const ntsc = Math.round(fps * 1.001);
  if (Math.abs(fps - (ntsc * 1000) / 1001) < 1e-3 && Math.abs(fps - Math.round(fps)) > 1e-3) return { num: ntsc * 1000, den: 1001, value: (ntsc * 1000) / 1001 };
  if (Math.abs(fps - Math.round(fps)) < 1e-9) return { num: Math.round(fps), den: 1, value: Math.round(fps) };
  const num = Math.round(fps * 1000);
  return { num, den: 1000, value: num / 1000 };
}

/**
 * Liest einen Bruch wie `"30000/1001"`. Liefert `undefined` für `0/0` und ungültige Werte.
 *
 * @example
 * ```ts
 * parseRational('30/1')?.value; // 30
 * ```
 */
export function parseRational(text: unknown): Rational | undefined {
  if (typeof text !== 'string') return undefined;
  const m = /^(\d+)\/(\d+)$/u.exec(text);
  if (m === null) return undefined;
  const num = Number(m[1]);
  const den = Number(m[2]);
  if (num === 0 || den === 0) return undefined;
  return { num, den, value: num / den };
}

function num(obj: Record<string, unknown>, key: string): number | undefined {
  const v = obj[key];
  const n = typeof v === 'number' ? v : typeof v === 'string' && v.trim() !== '' ? Number(v) : Number.NaN;
  return Number.isFinite(n) ? n : undefined;
}

function str(obj: Record<string, unknown>, key: string): string | undefined {
  const v = obj[key];
  return typeof v === 'string' && v !== '' ? v : undefined;
}

function tags(obj: Record<string, unknown>): Record<string, string> {
  const raw = obj['tags'];
  const out: Record<string, string> = {};
  if (!isRecord(raw)) return out;
  for (const [k, v] of Object.entries(raw)) if (typeof v === 'string' || typeof v === 'number') out[k] = String(v);
  return out;
}

/**
 * Prüft, ob ein Pixelformat einen Alphakanal hat.
 *
 * @example
 * ```ts
 * pixFmtHasAlpha('yuva444p10le'); // true
 * pixFmtHasAlpha('yuv420p'); // false
 * ```
 */
export function pixFmtHasAlpha(pixFmt: string | undefined): boolean {
  if (pixFmt === undefined) return false;
  return /^(yuva|gbrap|rgba|bgra|argb|abgr|ya8|ya16|rgba64|bgra64)/u.test(pixFmt);
}

const STREAM_TYPES = ['video', 'audio', 'subtitle', 'data', 'attachment'] as const;

function streamType(value: string | undefined): StreamInfo['type'] {
  return STREAM_TYPES.find((t) => t === value) ?? 'unknown';
}

function parseStream(raw: Record<string, unknown>): StreamInfo {
  const metadata = tags(raw);
  const pixFmt = str(raw, 'pix_fmt');
  const alphaMode = Object.entries(metadata).find(([k]) => k.toLowerCase() === 'alpha_mode')?.[1];
  const type = streamType(str(raw, 'codec_type'));
  const nbFrames = num(raw, 'nb_frames');
  const frameCount = nbFrames !== undefined && nbFrames > 0 ? nbFrames : num(raw, 'nb_read_packets');
  return {
    index: num(raw, 'index') ?? 0,
    type,
    codec: str(raw, 'codec_name') ?? 'unknown',
    profile: str(raw, 'profile'),
    width: num(raw, 'width'),
    height: num(raw, 'height'),
    fps: type === 'video' ? (parseRational(raw['avg_frame_rate']) ?? parseRational(raw['r_frame_rate'])) : undefined,
    frameCount,
    pixFmt,
    colorSpace: str(raw, 'color_space'),
    colorTransfer: str(raw, 'color_transfer'),
    colorPrimaries: str(raw, 'color_primaries'),
    colorRange: str(raw, 'color_range'),
    hasAlpha: pixFmtHasAlpha(pixFmt) || alphaMode === '1',
    sampleRate: num(raw, 'sample_rate'),
    channels: num(raw, 'channels'),
    channelLayout: str(raw, 'channel_layout'),
    duration: num(raw, 'duration'),
    bitRate: num(raw, 'bit_rate'),
    metadata,
  };
}

function invalid(path: string, problem: string): OpenVideoError {
  return new OpenVideoError({
    code: 'OV_FFMPEG_PROBE',
    errorClass: 'FfmpegError',
    problem,
    details: { path },
    suggestions: ['Check that the file is a complete, supported media file.', 'Re-encode the file with FFmpeg and import it again.'],
  });
}

/**
 * Liest Container, Streams, Codecs, Maße, Bildrate, Farbangaben, Alpha und Metadaten.
 *
 * @example
 * ```ts
 * const info = await probeMedia('clip.mp4');
 * info.video?.fps?.value; // 30
 * ```
 */
export async function probeMedia(path: string, options: ProbeOptions = {}): Promise<MediaInfo> {
  const { ffprobe } = locateFfmpeg(options);
  const args = ['-v', 'error', '-print_format', 'json', '-show_format', '-show_streams', '-count_packets', path];
  const { stdout } = await runProcess(ffprobe, args, {
    ...(options.timeoutMs !== undefined ? { timeoutMs: options.timeoutMs } : {}),
    suggestions: ['Check that the path exists and points to a media file.', 'Check that the file is not truncated or still being written.'],
  });
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout.toString('utf8'));
  } catch (error) {
    throw invalid(path, `ffprobe returned invalid JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (!isRecord(parsed)) throw invalid(path, 'ffprobe returned no result object.');
  const format = isRecord(parsed['format']) ? parsed['format'] : {};
  const rawStreams = Array.isArray(parsed['streams']) ? parsed['streams'] : [];
  const streams = rawStreams.filter(isRecord).map(parseStream);
  const video = streams.find((s) => s.type === 'video');
  const audio = streams.find((s) => s.type === 'audio');
  return {
    path,
    container: str(format, 'format_name') ?? 'unknown',
    duration: num(format, 'duration') ?? video?.duration ?? audio?.duration,
    bitRate: num(format, 'bit_rate'),
    streams,
    video,
    audio,
    hasAlpha: video?.hasAlpha ?? false,
    metadata: tags(format),
  };
}

/**
 * Decoder-Argumente vor `-i`: VP9 mit Alpha braucht libvpx, der native Decoder verwirft Alpha.
 */
export function decoderArgs(video: StreamInfo | undefined): string[] {
  return video?.codec === 'vp9' && video.hasAlpha ? ['-c:v', 'libvpx-vp9'] : [];
}

/** Optionen für {@link extractThumbnail}. */
export interface ThumbnailOptions extends ProbeOptions {
  /** Zielbreite in Pixeln; die Höhe folgt dem Seitenverhältnis. */
  readonly width?: number;
}

/**
 * Liest ein Einzelbild zur Zeit `seconds` als vormultipliziertes RGBA.
 *
 * @example
 * ```ts
 * const thumb = await extractThumbnail('clip.mp4', 1.5, { width: 320 });
 * ```
 */
export async function extractThumbnail(path: string, seconds: number, options: ThumbnailOptions = {}): Promise<RgbaImage> {
  const info = await probeMedia(path, options);
  const video = info.video;
  if (video?.width === undefined || video.height === undefined) throw invalid(path, 'The file has no video stream with known dimensions.');
  const width = Math.max(1, Math.round(options.width ?? video.width));
  const height = Math.max(1, Math.round((width * video.height) / video.width));
  const { ffmpeg } = locateFfmpeg(options);
  const args = [
    '-hide_banner', '-loglevel', 'error', '-nostdin',
    '-ss', String(Math.max(0, seconds)),
    ...decoderArgs(video),
    '-i', path,
    '-map', '0:v:0', '-frames:v', '1',
    '-vf', `scale=${String(width)}:${String(height)}:flags=bicubic,format=rgba`,
    '-f', 'rawvideo', '-pix_fmt', 'rgba', '-',
  ];
  const { stdout } = await runProcess(ffmpeg, args, options.timeoutMs !== undefined ? { timeoutMs: options.timeoutMs } : {});
  const size = width * height * 4;
  if (stdout.length < size) {
    throw new OpenVideoError({
      code: 'OV_FFMPEG_NO_FRAME',
      errorClass: 'FfmpegError',
      problem: `No video frame at ${String(seconds)} s in "${path}".`,
      details: { path, seconds, duration: info.duration ?? -1 },
      suggestions: ['Use a time inside the video duration.', 'Check the duration with probeMedia().'],
    });
  }
  const data = new Uint8Array(size);
  data.set(stdout.subarray(0, size));
  return { width, height, data: premultiplyInPlace(data) };
}
