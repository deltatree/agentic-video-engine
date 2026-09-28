/**
 * Asset Pipeline (FR-48..FR-51): Import, Normalisierung, Content Addressable Storage, Auflösung.
 *
 * Ein identisches Asset (gleicher Inhalts-Hash) wird nie zweimal verarbeitet:
 * Metadaten und normalisierte Ableitungen liegen im Cache unter dem Hash.
 */
import { existsSync } from 'node:fs';
import { copyFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import { basename, extname, isAbsolute, join, normalize, relative, resolve } from 'node:path';
import { ASSET_TYPES, OpenVideoError, contentHash, isRecord, sha256Hex, type AssetRecord, type AssetResolver, type Diagnostic, type RgbaImage } from '@agentic-video/core';
import type { Cache } from '@agentic-video/cache';
import { VideoFrameReader, locateFfmpeg, runProcess } from '@agentic-video/ffmpeg';
import { detectFormat, type DetectedFormat } from './detect.js';
import { fetchAsset, type FetchOptions } from './fetcher.js';
import { inspectAsset, type AssetMetadata } from './inspect.js';

/** Zähler, wie oft wirklich verarbeitet wurde (für Tests und Metriken). */
export interface PipelineStats {
  inspected: number;
  normalized: number;
  fetched: number;
}

/** Optionen der Pipeline. */
export interface PipelineOptions {
  readonly cache: Cache;
  readonly fetch?: FetchOptions;
  /** Keine Netzwerkzugriffe; Remote-Assets nur aus dem Cache (FR-89). */
  readonly offline?: boolean;
  /** Absolute Pfade außerhalb des Projekts erlauben (nur CLI, vertrauenswürdig). */
  readonly allowOutsidePaths?: boolean;
  readonly stats?: PipelineStats;
}

function safeResolve(projectDir: string, path: string, allowOutside: boolean): string {
  const full = isAbsolute(path) ? normalize(path) : resolve(projectDir, normalize(path));
  const rel = relative(projectDir, full);
  if (!allowOutside && (rel.startsWith('..') || isAbsolute(rel))) {
    throw new OpenVideoError({ code: 'OV_PATH_OUTSIDE', errorClass: 'SecurityError', problem: `Asset path "${path}" is outside the project directory.`, suggestions: ['Copy the file into the project (e.g. assets/) and reference it relatively.'] });
  }
  return full;
}

function metadataFrom(raw: Record<string, unknown>): AssetMetadata {
  const meta = isRecord(raw['metadata']) ? raw['metadata'] : {};
  const dims = raw['dimensions'];
  return {
    metadata: meta,
    ...(typeof raw['duration'] === 'number' ? { duration: raw['duration'] } : {}),
    ...(isRecord(dims) && typeof dims['width'] === 'number' && typeof dims['height'] === 'number' ? { dimensions: { width: dims['width'], height: dims['height'] } } : {}),
    ...(typeof raw['codec'] === 'string' ? { codec: raw['codec'] } : {}),
    ...(typeof raw['colorSpace'] === 'string' ? { colorSpace: raw['colorSpace'] } : {}),
    ...(typeof raw['frameRate'] === 'number' ? { frameRate: raw['frameRate'] } : {}),
    ...(typeof raw['hasAlpha'] === 'boolean' ? { hasAlpha: raw['hasAlpha'] } : {}),
    ...(typeof raw['animated'] === 'boolean' ? { animated: raw['animated'] } : {}),
  };
}

async function cachedMetadata(path: string, bytes: Uint8Array, hash: string, detected: DetectedFormat, options: PipelineOptions): Promise<AssetMetadata> {
  const tier = options.cache.tier('asset');
  const key = `meta-${hash.replace('sha256:', '')}-${detected.format}`;
  const hit = await tier.get(key);
  if (hit !== undefined) {
    const parsed: unknown = JSON.parse(new TextDecoder().decode(hit));
    if (isRecord(parsed) && isRecord(parsed['metadata'])) return metadataFrom(parsed);
  }
  const meta = await inspectAsset(path, bytes, detected);
  if (options.stats !== undefined) options.stats.inspected++;
  await tier.put(key, new TextEncoder().encode(JSON.stringify(meta)));
  return meta;
}

/**
 * Normalisiert Formate, die Renderer nicht direkt lesen: AVIF → PNG; animierte Bilder
 * (GIF, AVIF-Sequenz, animiertes WebP) → verlustfreies Video (FFV1, RGBA) für frame-genauen Zugriff.
 * Ergebnis ist ein Dateipfad im Cache; identische Eingaben werden nie erneut verarbeitet.
 */
async function normalizedPath(path: string, hash: string, detected: DetectedFormat, meta: AssetMetadata, options: PipelineOptions, workDir: string): Promise<string> {
  let target: { ext: string; args: string[] } | undefined;
  if (detected.type === 'image' && meta.animated === true) target = { ext: '.mkv', args: ['-c:v', 'ffv1', '-level', '3', '-pix_fmt', 'bgra', '-fflags', '+bitexact', '-map_metadata', '-1'] };
  else if (detected.format === 'avif') target = { ext: '.png', args: ['-frames:v', '1', '-pix_fmt', 'rgba', '-fflags', '+bitexact'] };
  if (target === undefined) return path;
  const tier = options.cache.tier('asset');
  const key = `norm-${hash.replace('sha256:', '')}${target.ext.replace('.', '-')}`;
  const outFile = join(workDir, `${hash.replace('sha256:', '')}${target.ext}`);
  const cached = await tier.get(key);
  if (cached !== undefined) {
    if (!existsSync(outFile)) await writeFile(outFile, cached);
    return outFile;
  }
  const { ffmpeg } = locateFfmpeg();
  await runProcess(ffmpeg, ['-y', '-loglevel', 'error', '-i', path, ...target.args, outFile], { timeoutMs: 300_000 });
  if (options.stats !== undefined) options.stats.normalized++;
  await tier.put(key, new Uint8Array(await readFile(outFile)));
  return outFile;
}

/** Eingabe für {@link importAsset}. */
export interface ImportInput {
  readonly path?: string;
  readonly url?: string;
  readonly base64?: string;
  readonly fileName?: string;
  readonly id?: string;
  readonly type?: string;
}

/** Ergebnis eines Imports. */
export interface ImportResult {
  readonly id: string;
  readonly type: string;
  readonly src: string;
  readonly hash: string;
  readonly metadata: Readonly<Record<string, unknown>>;
  readonly diagnostics: readonly Diagnostic[];
}

function sanitize(name: string): string {
  const clean = basename(name).replace(/[^A-Za-z0-9._-]+/gu, '-').replace(/^-+/u, '');
  return clean === '' ? 'asset' : clean;
}

function idFrom(name: string): string {
  const base = basename(name, extname(name)).replace(/[^A-Za-z0-9_-]+/gu, '-').replace(/^[^A-Za-z]+/u, '');
  return base === '' ? 'asset' : base;
}

/**
 * Importiert eine Datei, URL oder base64-Daten in ein Projekt (Kopie nach `assets/`).
 *
 * @example
 * ```ts
 * const a = await importAsset('/work/demo', { path: '../logo.svg' }, { cache, allowOutsidePaths: true });
 * a.src; // 'assets/logo.svg'
 * ```
 */
export async function importAsset(projectDir: string, input: ImportInput, options: PipelineOptions): Promise<ImportResult> {
  let bytes: Uint8Array;
  let fileName: string;
  if (input.path !== undefined) {
    const full = safeResolve(projectDir, input.path, options.allowOutsidePaths === true);
    if (!existsSync(full)) throw new OpenVideoError({ code: 'OV_ASSET_MISSING', errorClass: 'AssetError', problem: `File "${input.path}" does not exist.`, suggestions: ['Check the path relative to the project root.'] });
    bytes = new Uint8Array(await readFile(full));
    fileName = input.fileName ?? basename(full);
  } else if (input.url !== undefined) {
    const r = await fetchAsset(input.url, options.fetch);
    if (options.stats !== undefined) options.stats.fetched++;
    bytes = r.bytes;
    fileName = input.fileName ?? (basename(new URL(r.finalUrl).pathname) || 'download');
  } else if (input.base64 !== undefined) {
    bytes = new Uint8Array(Buffer.from(input.base64, 'base64'));
    fileName = input.fileName ?? 'asset.bin';
  } else {
    throw new OpenVideoError({ code: 'OV_ASSET_INPUT', errorClass: 'AssetError', problem: 'Give "path", "url" or "base64".', suggestions: ['{ "path": "assets/logo.svg" }'] });
  }
  const detected = detectFormat(fileName, bytes);
  if (detected === undefined) {
    throw new OpenVideoError({ code: 'OV_ASSET_UNSUPPORTED', errorClass: 'AssetError', problem: `Cannot detect the format of "${fileName}".`, suggestions: ['Supported: PNG, JPEG, WebP, AVIF, SVG, GIF, MP4, WebM, MOV, WAV, FLAC, MP3, AAC, OGG, glTF, GLB, OBJ, fonts, Lottie JSON, SRT, VTT, ASS, CUBE, HDR, EXR.'] });
  }
  const hash = contentHash(bytes);
  const assetsDir = join(projectDir, 'assets');
  await mkdir(assetsDir, { recursive: true });
  let name = sanitize(fileName);
  let target = join(assetsDir, name);
  if (existsSync(target)) {
    const existing = new Uint8Array(await readFile(target));
    if (contentHash(existing) !== hash) {
      name = `${hash.slice(7, 15)}-${name}`;
      target = join(assetsDir, name);
    }
  }
  if (!existsSync(target)) await writeFile(target, bytes);
  const meta = await cachedMetadata(target, bytes, hash, detected, options);
  const workDir = join(projectDir, '.openvideo', 'assets');
  await mkdir(workDir, { recursive: true });
  await normalizedPath(target, hash, detected, meta, options, workDir);
  const diagnostics: Diagnostic[] = [];
  if (input.type !== undefined && input.type !== detected.type) {
    diagnostics.push({ code: 'OV_ASSET_TYPE', severity: 'warning', errorClass: 'AssetError', problem: `Requested type "${input.type}" but the file is ${detected.type} (${detected.format}).`, suggestions: [`Use type "${detected.type}".`] });
  }
  return {
    id: input.id ?? idFrom(fileName),
    type: detected.type,
    src: `assets/${name}`,
    hash,
    metadata: { ...meta.metadata, format: detected.format, mimeType: detected.mimeType, ...(meta.dimensions !== undefined ? { dimensions: meta.dimensions } : {}), ...(meta.duration !== undefined ? { duration: meta.duration } : {}) },
    diagnostics,
  };
}

/** Ein Resolver mit Aufräumfunktion. */
export interface ProjectAssets extends AssetResolver {
  close(): Promise<void>;
  readonly diagnostics: readonly Diagnostic[];
}

/**
 * Löst alle Assets eines Projects auf (vor dem Rendern, vor jeder Code-Ausführung).
 *
 * @example
 * ```ts
 * const assets = await resolveProjectAssets('/work/demo', project, { cache });
 * const frame = await assets.videoFrame('intro', 1.5);
 * ```
 */
export async function resolveProjectAssets(projectDir: string, project: Readonly<Record<string, unknown>>, options: PipelineOptions): Promise<ProjectAssets> {
  const records = new Map<string, AssetRecord>();
  const diagnostics: Diagnostic[] = [];
  const workDir = join(projectDir, '.openvideo', 'assets');
  await mkdir(workDir, { recursive: true });
  const list = Array.isArray(project['assets']) ? project['assets'].filter(isRecord) : [];
  for (const a of list) {
    const id = String(a['id']);
    const src = String(a['src']);
    try {
      let path: string;
      let bytes: Uint8Array;
      if (/^https?:\/\//u.test(src)) {
        const urlKey = `url-${sha256Hex(src)}`;
        const tier = options.cache.tier('asset');
        const known = await tier.get(urlKey);
        if (known !== undefined) bytes = known;
        else if (options.offline === true) {
          throw new OpenVideoError({ code: 'OV_ASSET_OFFLINE', errorClass: 'AssetError', problem: `Remote asset ${src} is not cached and the render is offline.`, suggestions: ['Render once online, or import the file into the project.'] });
        } else {
          bytes = (await fetchAsset(src, options.fetch)).bytes;
          if (options.stats !== undefined) options.stats.fetched++;
          await tier.put(urlKey, bytes);
        }
        const ext = extname(new URL(src).pathname) || '.bin';
        path = join(workDir, `${contentHash(bytes).slice(7)}${ext}`);
        if (!existsSync(path)) await writeFile(path, bytes);
      } else {
        path = safeResolve(projectDir, src, options.allowOutsidePaths === true);
        if (!existsSync(path)) {
          diagnostics.push({ code: 'OV_ASSET_MISSING', severity: 'error', errorClass: 'AssetError', problem: `Asset "${id}" file "${src}" does not exist.`, suggestions: ['Check the path relative to the project root.', 'Import the file with asset.import.'] });
          continue;
        }
        bytes = new Uint8Array(await readFile(path));
      }
      const hash = contentHash(bytes);
      if (typeof a['hash'] === 'string' && a['hash'] !== hash) {
        diagnostics.push({ code: 'OV_ASSET_HASH', severity: 'warning', errorClass: 'AssetError', problem: `Asset "${id}" changed since import (hash differs).`, details: { declared: a['hash'], actual: hash }, suggestions: ['Re-import the asset, or remove "hash" to accept the new content.'] });
      }
      const declaredType = ASSET_TYPES.find((t) => t === a['type']) ?? 'data';
      const detected: DetectedFormat = detectFormat(src, bytes) ?? { type: declaredType, format: extname(src).slice(1), mimeType: 'application/octet-stream' };
      const meta = await cachedMetadata(path, bytes, hash, detected, options);
      const normalized = await normalizedPath(path, hash, detected, meta, options, workDir);
      const license = isRecord(a['license']) ? Object.fromEntries(Object.entries(a['license']).map(([k, v]) => [k, String(v)])) : undefined;
      records.set(id, {
        id,
        type: String(a['type']),
        src,
        path: normalized,
        hash,
        metadata: { ...meta.metadata, originalPath: path, format: detected.format, ...(meta.animated === true ? { animated: true } : {}) },
        ...(meta.duration !== undefined ? { duration: meta.duration } : {}),
        ...(meta.dimensions !== undefined ? { dimensions: meta.dimensions } : {}),
        ...(meta.codec !== undefined ? { codec: meta.codec } : {}),
        ...(meta.colorSpace !== undefined ? { colorSpace: meta.colorSpace } : {}),
        ...(meta.frameRate !== undefined ? { frameRate: meta.frameRate } : {}),
        ...(meta.hasAlpha !== undefined ? { hasAlpha: meta.hasAlpha } : {}),
        ...(license !== undefined ? { licenseMetadata: license } : {}),
      });
    } catch (error) {
      if (error instanceof OpenVideoError) diagnostics.push({ ...error.diagnostic, problem: `Asset "${id}": ${error.diagnostic.problem}` });
      else throw error;
    }
  }
  const readers = new Map<string, Promise<VideoFrameReader>>();
  return {
    diagnostics,
    get: (id) => records.get(id),
    all: () => [...records.values()],
    async bytes(id) {
      const r = records.get(id);
      if (r === undefined) throw new OpenVideoError({ code: 'OV_ASSET_MISSING', errorClass: 'AssetError', problem: `Asset "${id}" is not available.`, suggestions: ['Declare it in project.assets.'] });
      return new Uint8Array(await readFile(r.path));
    },
    async videoFrame(id: string, seconds: number): Promise<RgbaImage> {
      const r = records.get(id);
      if (r === undefined) throw new OpenVideoError({ code: 'OV_ASSET_MISSING', errorClass: 'AssetError', problem: `Asset "${id}" is not available.`, suggestions: ['Declare it in project.assets.'] });
      let reader = readers.get(id);
      if (reader === undefined) {
        reader = VideoFrameReader.open(r.path);
        readers.set(id, reader);
      }
      return (await reader).frameAt(seconds);
    },
    async close() {
      for (const r of readers.values()) await (await r).close();
      readers.clear();
    },
  };
}

/** Kopiert eine Datei inhaltsadressiert in einen Ordner (für Exporte). */
export async function copyContentAddressed(path: string, dir: string): Promise<string> {
  const bytes = new Uint8Array(await readFile(path));
  const target = join(dir, `${contentHash(bytes).slice(7, 23)}${extname(path)}`);
  if (!existsSync(target)) {
    await mkdir(dir, { recursive: true });
    await copyFile(path, target);
  }
  return target;
}
