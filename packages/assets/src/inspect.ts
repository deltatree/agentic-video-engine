/**
 * Metadaten je Asset-Typ (FR-49): Maße, Dauer, Codec, Farbraum, Alpha, Lizenz-Hinweise.
 */
import { probeMedia } from '@agentic-video/ffmpeg';
import { parseFontInfo } from '@agentic-video/fonts';
import { OpenVideoError, isRecord } from '@agentic-video/core';
import { sniffFormat, type DetectedFormat } from './detect.js';

/**
 * Prüft, dass FFmpeg eine Datei lesen darf: Ihr Inhalt muss mit der Signatur eines
 * unterstützten Bild-, Video- oder Audio-Containers beginnen. So erreicht FFmpeg nie
 * Playlist- oder Listen-Demuxer (HLS, concat, SDP), die weitere Dateien oder Netzquellen öffnen.
 *
 * @example
 * ```ts
 * assertFfmpegInput('/p/assets/clip.mp4', bytes); // wirft OV_ASSET_UNSAFE_MEDIA bei einer Playlist
 * ```
 */
export function assertFfmpegInput(path: string, bytes: Uint8Array): void {
  const sniffed = sniffFormat(path, bytes);
  if (sniffed?.type === 'video' || sniffed?.type === 'audio' || sniffed?.type === 'image') return;
  throw new OpenVideoError({
    code: 'OV_ASSET_UNSAFE_MEDIA',
    errorClass: 'SecurityError',
    problem: `"${path}" is not a supported media file (no known container signature); FFmpeg will not open it.`,
    details: { path },
    suggestions: ['Import a real media file (MP4, MOV, WebM, MKV, WAV, FLAC, MP3, AAC, Ogg, GIF, WebP, AVIF).', 'Playlists (HLS .m3u8) and concat lists are not supported as assets.'],
  });
}

/** Ergebnis der Inspektion. */
export interface AssetMetadata {
  readonly metadata: Record<string, unknown>;
  readonly duration?: number;
  readonly dimensions?: { readonly width: number; readonly height: number };
  readonly codec?: string;
  readonly colorSpace?: string;
  readonly frameRate?: number;
  readonly hasAlpha?: boolean;
  /** Animiertes Bild (GIF, AVIF-Sequenz, animiertes WebP)? */
  readonly animated?: boolean;
}

function u32be(b: Uint8Array, o: number): number {
  return (((b[o] ?? 0) << 24) >>> 0) + ((b[o + 1] ?? 0) << 16) + ((b[o + 2] ?? 0) << 8) + (b[o + 3] ?? 0);
}

function u16le(b: Uint8Array, o: number): number {
  return (b[o] ?? 0) + ((b[o + 1] ?? 0) << 8);
}

function u24le(b: Uint8Array, o: number): number {
  return (b[o] ?? 0) + ((b[o + 1] ?? 0) << 8) + ((b[o + 2] ?? 0) << 16);
}

/** Maße eines Rasterbilds aus dem Dateikopf (PNG, JPEG, WebP, GIF). */
export function imageDimensions(bytes: Uint8Array, format: string): { width: number; height: number; hasAlpha: boolean; animated: boolean } | undefined {
  if (format === 'png') {
    const colorType = bytes[25] ?? 0;
    let animated = false;
    for (let o = 8; o + 8 < bytes.length; ) {
      const len = u32be(bytes, o);
      const type = String.fromCharCode(bytes[o + 4] ?? 0, bytes[o + 5] ?? 0, bytes[o + 6] ?? 0, bytes[o + 7] ?? 0);
      if (type === 'acTL') animated = true;
      if (type === 'IDAT' || type === 'IEND') break;
      o += 12 + len;
    }
    return { width: u32be(bytes, 16), height: u32be(bytes, 20), hasAlpha: colorType === 4 || colorType === 6, animated };
  }
  if (format === 'gif') {
    let frames = 0;
    for (let i = 13; i < bytes.length; i++) if (bytes[i] === 0x2c) frames++;
    return { width: u16le(bytes, 6), height: u16le(bytes, 8), hasAlpha: true, animated: frames > 1 };
  }
  if (format === 'webp') {
    const chunk = String.fromCharCode(...bytes.subarray(12, 16));
    if (chunk === 'VP8X') return { width: u24le(bytes, 24) + 1, height: u24le(bytes, 27) + 1, hasAlpha: ((bytes[20] ?? 0) & 0x10) !== 0, animated: ((bytes[20] ?? 0) & 0x02) !== 0 };
    if (chunk === 'VP8L') {
      const b0 = bytes[21] ?? 0;
      const b1 = bytes[22] ?? 0;
      const b2 = bytes[23] ?? 0;
      const b3 = bytes[24] ?? 0;
      return { width: 1 + (((b1 & 0x3f) << 8) | b0), height: 1 + (((b3 & 0x0f) << 10) | (b2 << 2) | ((b1 & 0xc0) >> 6)), hasAlpha: true, animated: false };
    }
    if (chunk === 'VP8 ') return { width: u16le(bytes, 26) & 0x3fff, height: u16le(bytes, 28) & 0x3fff, hasAlpha: false, animated: false };
    return undefined;
  }
  if (format === 'jpeg') {
    let o = 2;
    while (o < bytes.length) {
      if (bytes[o] !== 0xff) return undefined;
      const marker = bytes[o + 1] ?? 0;
      const len = ((bytes[o + 2] ?? 0) << 8) + (bytes[o + 3] ?? 0);
      if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
        return { height: ((bytes[o + 5] ?? 0) << 8) + (bytes[o + 6] ?? 0), width: ((bytes[o + 7] ?? 0) << 8) + (bytes[o + 8] ?? 0), hasAlpha: false, animated: false };
      }
      o += 2 + len;
    }
  }
  return undefined;
}

function parseLength(v: string | undefined): number | undefined {
  if (v === undefined) return undefined;
  const n = Number.parseFloat(v);
  return Number.isFinite(n) ? n : undefined;
}

/** Maße eines SVG aus `width`/`height` oder `viewBox`. */
export function svgDimensions(text: string): { width: number; height: number } | undefined {
  const tag = /<svg\b[^>]*>/iu.exec(text)?.[0] ?? '';
  const attr = (name: string) => new RegExp(`\\s${name}\\s*=\\s*["']([^"']*)["']`, 'iu').exec(tag)?.[1];
  const w = parseLength(attr('width'));
  const h = parseLength(attr('height'));
  if (w !== undefined && h !== undefined) return { width: w, height: h };
  const vb = attr('viewBox')?.split(/[\s,]+/u).map(Number);
  if (vb?.length === 4 && vb.every((n) => Number.isFinite(n))) return { width: vb[2] ?? 0, height: vb[3] ?? 0 };
  return undefined;
}

/**
 * Untersucht eine Datei und liefert Metadaten.
 *
 * @example
 * ```ts
 * const meta = await inspectAsset('/p/assets/intro.mp4', bytes, detected);
 * meta.duration; // 12.5
 * ```
 */
export async function inspectAsset(path: string, bytes: Uint8Array, detected: DetectedFormat): Promise<AssetMetadata> {
  const text = () => new TextDecoder().decode(bytes);
  switch (detected.type) {
    case 'image': {
      if (detected.format === 'avif') {
        assertFfmpegInput(path, bytes);
        const info = await probeMedia(path);
        return {
          metadata: { format: 'avif', container: info.container },
          ...(info.video?.width !== undefined && info.video.height !== undefined ? { dimensions: { width: info.video.width, height: info.video.height } } : {}),
          hasAlpha: info.hasAlpha,
          animated: (info.video?.frameCount ?? 1) > 1,
        };
      }
      const d = imageDimensions(bytes, detected.format);
      return { metadata: { format: detected.format }, ...(d !== undefined ? { dimensions: { width: d.width, height: d.height }, hasAlpha: d.hasAlpha, animated: d.animated } : {}) };
    }
    case 'svg': {
      const d = svgDimensions(text());
      return { metadata: { format: 'svg' }, ...(d !== undefined ? { dimensions: d } : {}), hasAlpha: true };
    }
    case 'video':
    case 'audio': {
      assertFfmpegInput(path, bytes);
      const info = await probeMedia(path);
      const v = info.video;
      const a = info.audio;
      return {
        metadata: {
          container: info.container,
          ...(a !== undefined ? { audio: { codec: a.codec, sampleRate: a.sampleRate, channels: a.channels } } : {}),
          ...(v !== undefined ? { pixelFormat: v.pixFmt, frameCount: v.frameCount, colorTransfer: v.colorTransfer, colorPrimaries: v.colorPrimaries } : {}),
          tags: info.metadata,
        },
        ...(info.duration !== undefined ? { duration: info.duration } : {}),
        ...(v?.width !== undefined && v.height !== undefined ? { dimensions: { width: v.width, height: v.height } } : {}),
        ...(v !== undefined ? { codec: v.codec } : a !== undefined ? { codec: a.codec } : {}),
        ...(v?.colorSpace !== undefined ? { colorSpace: v.colorSpace } : {}),
        ...(v?.fps !== undefined ? { frameRate: v.fps.value } : {}),
        hasAlpha: info.hasAlpha,
      };
    }
    case 'lottie': {
      const json: unknown = JSON.parse(text());
      if (!isRecord(json)) return { metadata: {} };
      const fr = Number(json['fr']);
      const ip = Number(json['ip']);
      const op = Number(json['op']);
      return { metadata: { version: json['v'], layers: Array.isArray(json['layers']) ? json['layers'].length : 0 }, dimensions: { width: Number(json['w']), height: Number(json['h']) }, frameRate: fr, duration: (op - ip) / fr, hasAlpha: true };
    }
    case 'model': {
      if (detected.format === 'obj') return { metadata: { vertices: (text().match(/^v\s/gmu) ?? []).length, faces: (text().match(/^f\s/gmu) ?? []).length } };
      let json: unknown;
      if (detected.format === 'glb') {
        const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
        const len = view.getUint32(12, true);
        json = JSON.parse(new TextDecoder().decode(bytes.subarray(20, 20 + len)));
      } else json = JSON.parse(text());
      if (!isRecord(json)) return { metadata: {} };
      const count = (k: string) => (Array.isArray(json[k]) ? json[k].length : 0);
      const animations = Array.isArray(json['animations']) ? json['animations'].filter(isRecord).map((a, i) => (typeof a['name'] === 'string' ? a['name'] : `animation-${String(i)}`)) : [];
      const asset = isRecord(json['asset']) ? json['asset'] : {};
      return { metadata: { gltfVersion: asset['version'], generator: asset['generator'], scenes: count('scenes'), meshes: count('meshes'), materials: count('materials'), animations, cameras: count('cameras'), extensionsUsed: json['extensionsUsed'] ?? [] } };
    }
    case 'font': {
      const info = parseFontInfo(bytes);
      return { metadata: { ...info } };
    }
    case 'subtitle': {
      const t = text();
      const cues = detected.format === 'ass' ? (t.match(/^Dialogue:/gmu) ?? []).length : (t.match(/-->/gu) ?? []).length;
      return { metadata: { format: detected.format, cues } };
    }
    case 'lut': {
      const size = /LUT_3D_SIZE\s+([0-9]+)/u.exec(text())?.[1] ?? /LUT_1D_SIZE\s+([0-9]+)/u.exec(text())?.[1];
      return { metadata: { size: size !== undefined ? Number(size) : undefined, kind: text().includes('LUT_3D_SIZE') ? '3d' : '1d' } };
    }
    default:
      return { metadata: { bytes: bytes.length } };
  }
}
