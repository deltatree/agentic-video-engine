/**
 * Erkennung von Asset-Typ und Format aus Dateiname und Magic Bytes (FR-48).
 */
import { extname } from 'node:path';
import type { AssetType } from '@agentic-video/core';

/** Erkanntes Format. */
export interface DetectedFormat {
  readonly type: AssetType;
  /** Kurzname, z. B. `png`, `mp4`, `gltf`. */
  readonly format: string;
  readonly mimeType: string;
}

const BY_EXTENSION: Readonly<Record<string, DetectedFormat>> = {
  '.png': { type: 'image', format: 'png', mimeType: 'image/png' },
  '.jpg': { type: 'image', format: 'jpeg', mimeType: 'image/jpeg' },
  '.jpeg': { type: 'image', format: 'jpeg', mimeType: 'image/jpeg' },
  '.webp': { type: 'image', format: 'webp', mimeType: 'image/webp' },
  '.avif': { type: 'image', format: 'avif', mimeType: 'image/avif' },
  '.gif': { type: 'image', format: 'gif', mimeType: 'image/gif' },
  '.svg': { type: 'svg', format: 'svg', mimeType: 'image/svg+xml' },
  '.mp4': { type: 'video', format: 'mp4', mimeType: 'video/mp4' },
  '.m4v': { type: 'video', format: 'mp4', mimeType: 'video/mp4' },
  '.mov': { type: 'video', format: 'mov', mimeType: 'video/quicktime' },
  '.webm': { type: 'video', format: 'webm', mimeType: 'video/webm' },
  '.mkv': { type: 'video', format: 'mkv', mimeType: 'video/x-matroska' },
  '.wav': { type: 'audio', format: 'wav', mimeType: 'audio/wav' },
  '.flac': { type: 'audio', format: 'flac', mimeType: 'audio/flac' },
  '.mp3': { type: 'audio', format: 'mp3', mimeType: 'audio/mpeg' },
  '.aac': { type: 'audio', format: 'aac', mimeType: 'audio/aac' },
  '.m4a': { type: 'audio', format: 'm4a', mimeType: 'audio/mp4' },
  '.ogg': { type: 'audio', format: 'ogg', mimeType: 'audio/ogg' },
  '.opus': { type: 'audio', format: 'opus', mimeType: 'audio/ogg' },
  '.gltf': { type: 'model', format: 'gltf', mimeType: 'model/gltf+json' },
  '.glb': { type: 'model', format: 'glb', mimeType: 'model/gltf-binary' },
  '.obj': { type: 'model', format: 'obj', mimeType: 'model/obj' },
  '.ttf': { type: 'font', format: 'ttf', mimeType: 'font/ttf' },
  '.otf': { type: 'font', format: 'otf', mimeType: 'font/otf' },
  '.woff': { type: 'font', format: 'woff', mimeType: 'font/woff' },
  '.woff2': { type: 'font', format: 'woff2', mimeType: 'font/woff2' },
  '.srt': { type: 'subtitle', format: 'srt', mimeType: 'application/x-subrip' },
  '.vtt': { type: 'subtitle', format: 'vtt', mimeType: 'text/vtt' },
  '.ass': { type: 'subtitle', format: 'ass', mimeType: 'text/x-ssa' },
  '.ssa': { type: 'subtitle', format: 'ass', mimeType: 'text/x-ssa' },
  '.cube': { type: 'lut', format: 'cube', mimeType: 'text/plain' },
  '.hdr': { type: 'hdri', format: 'hdr', mimeType: 'image/vnd.radiance' },
  '.exr': { type: 'hdri', format: 'exr', mimeType: 'image/x-exr' },
  '.html': { type: 'html', format: 'html', mimeType: 'text/html' },
  '.htm': { type: 'html', format: 'html', mimeType: 'text/html' },
};

function startsWith(bytes: Uint8Array, signature: readonly number[], offset = 0): boolean {
  return signature.every((b, i) => bytes[offset + i] === b);
}

function ascii(bytes: Uint8Array, start: number, length: number): string {
  return String.fromCharCode(...bytes.subarray(start, start + length));
}

/** Prüft, ob JSON-Text eine Lottie-Animation ist (Felder `v`, `fr`, `ip`, `op`, `layers`). */
export function isLottieJson(text: string): boolean {
  try {
    const v: unknown = JSON.parse(text);
    return typeof v === 'object' && v !== null && 'fr' in v && 'ip' in v && 'op' in v && 'layers' in v;
  } catch (error) {
    if (error instanceof SyntaxError) return false;
    throw error;
  }
}

/**
 * Erkennt Typ und Format. Magic Bytes haben Vorrang vor der Endung.
 *
 * @example
 * ```ts
 * detectFormat('logo.bin', bytes); // { type: 'image', format: 'png', mimeType: 'image/png' }
 * ```
 */
export function detectFormat(fileName: string, bytes: Uint8Array): DetectedFormat | undefined {
  if (startsWith(bytes, [0x89, 0x50, 0x4e, 0x47])) return BY_EXTENSION['.png'];
  if (startsWith(bytes, [0xff, 0xd8, 0xff])) return BY_EXTENSION['.jpg'];
  if (ascii(bytes, 0, 4) === 'RIFF' && ascii(bytes, 8, 4) === 'WEBP') return BY_EXTENSION['.webp'];
  if (ascii(bytes, 0, 4) === 'RIFF' && ascii(bytes, 8, 4) === 'WAVE') return BY_EXTENSION['.wav'];
  if (ascii(bytes, 0, 6) === 'GIF87a' || ascii(bytes, 0, 6) === 'GIF89a') return BY_EXTENSION['.gif'];
  if (ascii(bytes, 4, 4) === 'ftyp') {
    const brand = ascii(bytes, 8, 4);
    if (brand === 'avif' || brand === 'avis') return BY_EXTENSION['.avif'];
    if (brand === 'qt  ') return BY_EXTENSION['.mov'];
    if (brand === 'M4A ') return BY_EXTENSION['.m4a'];
    return BY_EXTENSION['.mp4'];
  }
  if (startsWith(bytes, [0x1a, 0x45, 0xdf, 0xa3])) return extname(fileName).toLowerCase() === '.mkv' ? BY_EXTENSION['.mkv'] : BY_EXTENSION['.webm'];
  if (ascii(bytes, 0, 4) === 'fLaC') return BY_EXTENSION['.flac'];
  if (ascii(bytes, 0, 4) === 'OggS') return extname(fileName).toLowerCase() === '.opus' ? BY_EXTENSION['.opus'] : BY_EXTENSION['.ogg'];
  if (ascii(bytes, 0, 3) === 'ID3' || startsWith(bytes, [0xff, 0xfb]) || startsWith(bytes, [0xff, 0xf3])) return BY_EXTENSION['.mp3'];
  if (startsWith(bytes, [0xff, 0xf1]) || startsWith(bytes, [0xff, 0xf9])) return BY_EXTENSION['.aac'];
  if (ascii(bytes, 0, 4) === 'glTF') return BY_EXTENSION['.glb'];
  if (startsWith(bytes, [0x00, 0x01, 0x00, 0x00]) || ascii(bytes, 0, 4) === 'true') return BY_EXTENSION['.ttf'];
  if (ascii(bytes, 0, 4) === 'OTTO') return BY_EXTENSION['.otf'];
  if (ascii(bytes, 0, 4) === 'wOFF') return BY_EXTENSION['.woff'];
  if (ascii(bytes, 0, 4) === 'wOF2') return BY_EXTENSION['.woff2'];
  if (ascii(bytes, 0, 10) === '#?RADIANCE' || ascii(bytes, 0, 6) === '#?RGBE') return BY_EXTENSION['.hdr'];
  if (startsWith(bytes, [0x76, 0x2f, 0x31, 0x01])) return BY_EXTENSION['.exr'];
  const ext = extname(fileName).toLowerCase();
  const head = new TextDecoder().decode(bytes.subarray(0, 512)).trimStart();
  if (ext === '.json' || head.startsWith('{')) {
    const text = new TextDecoder().decode(bytes);
    if (isLottieJson(text)) return { type: 'lottie', format: 'lottie', mimeType: 'application/json' };
    if (text.includes('"asset"') && text.includes('"version"') && ext === '.gltf') return BY_EXTENSION['.gltf'];
    if (ext === '.gltf') return BY_EXTENSION['.gltf'];
    return { type: 'data', format: 'json', mimeType: 'application/json' };
  }
  if (head.startsWith('<svg') || (head.startsWith('<?xml') && head.includes('<svg'))) return BY_EXTENSION['.svg'];
  return BY_EXTENSION[ext];
}
