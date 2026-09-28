/**
 * Suche nach FFmpeg und ffprobe. FFmpeg wird nie gebündelt.
 *
 * Reihenfolge je Programm:
 * 1. Option (`ffmpegPath`, `ffprobePath`),
 * 2. Umgebungsvariable (`OPENVIDEO_FFMPEG`, `OPENVIDEO_FFPROBE`),
 * 3. nur ffprobe: dasselbe Verzeichnis wie das gefundene FFmpeg (gleiche Version),
 * 4. `PATH`.
 */
import { accessSync, constants, statSync } from 'node:fs';
import { delimiter, dirname, join } from 'node:path';
import { OpenVideoError } from '@agentic-video/core';
import { installHints } from './process.js';

/** Optionen für die Suche nach den Programmen. */
export interface FfmpegLocateOptions {
  /** Voller Pfad zu `ffmpeg`. Hat Vorrang vor `OPENVIDEO_FFMPEG` und `PATH`. */
  readonly ffmpegPath?: string;
  /** Voller Pfad zu `ffprobe`. Hat Vorrang vor `OPENVIDEO_FFPROBE` und `PATH`. */
  readonly ffprobePath?: string;
}

/** Gefundene Programme. */
export interface FfmpegBinaries {
  readonly ffmpeg: string;
  readonly ffprobe: string;
}

function isExecutable(path: string): boolean {
  try {
    if (!statSync(path).isFile()) return false;
    accessSync(path, process.platform === 'win32' ? constants.F_OK : constants.X_OK);
    return true;
  } catch (error) {
    if (error instanceof Error) return false;
    throw error;
  }
}

function searchPath(name: string): string | undefined {
  const exe = process.platform === 'win32' ? `${name}.exe` : name;
  for (const dir of (process.env['PATH'] ?? '').split(delimiter)) {
    if (dir === '') continue;
    const candidate = join(dir, exe);
    if (isExecutable(candidate)) return candidate;
  }
  return undefined;
}

function missing(name: string, via: string, path?: string): OpenVideoError {
  return new OpenVideoError({
    code: 'OV_FFMPEG_MISSING',
    errorClass: 'FfmpegError',
    problem: path === undefined ? `${name} was not found (${via}).` : `${name} was not found at "${path}" (${via}).`,
    details: { binary: name, via, ...(path !== undefined ? { path } : {}) },
    suggestions: installHints(),
  });
}

function explicit(name: string, path: string, via: string): string {
  if (!isExecutable(path)) throw missing(name, via, path);
  return path;
}

/**
 * Findet `ffmpeg` und `ffprobe`. Wirft `OV_FFMPEG_MISSING` mit Installationshinweis
 * für das aktuelle Betriebssystem, wenn ein Programm fehlt.
 *
 * @example
 * ```ts
 * const { ffmpeg, ffprobe } = locateFfmpeg();
 * locateFfmpeg({ ffmpegPath: '/opt/ffmpeg/bin/ffmpeg' });
 * ```
 */
export function locateFfmpeg(options: FfmpegLocateOptions = {}): FfmpegBinaries {
  const envFfmpeg = process.env['OPENVIDEO_FFMPEG'];
  const envFfprobe = process.env['OPENVIDEO_FFPROBE'];
  let ffmpeg: string;
  if (options.ffmpegPath !== undefined) ffmpeg = explicit('ffmpeg', options.ffmpegPath, 'option ffmpegPath');
  else if (envFfmpeg !== undefined && envFfmpeg !== '') ffmpeg = explicit('ffmpeg', envFfmpeg, 'OPENVIDEO_FFMPEG');
  else {
    const found = searchPath('ffmpeg');
    if (found === undefined) throw missing('ffmpeg', 'PATH');
    ffmpeg = found;
  }
  let ffprobe: string;
  if (options.ffprobePath !== undefined) ffprobe = explicit('ffprobe', options.ffprobePath, 'option ffprobePath');
  else if (envFfprobe !== undefined && envFfprobe !== '') ffprobe = explicit('ffprobe', envFfprobe, 'OPENVIDEO_FFPROBE');
  else {
    const sibling = join(dirname(ffmpeg), process.platform === 'win32' ? 'ffprobe.exe' : 'ffprobe');
    const found = isExecutable(sibling) ? sibling : searchPath('ffprobe');
    if (found === undefined) throw missing('ffprobe', 'PATH');
    ffprobe = found;
  }
  return { ffmpeg, ffprobe };
}
