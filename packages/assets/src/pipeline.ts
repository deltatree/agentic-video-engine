/**
 * Asset Pipeline (FR-48..FR-51): Import, Normalisierung, Content Addressable Storage, Auflösung.
 *
 * Ein identisches Asset (gleicher Inhalts-Hash) wird nie zweimal verarbeitet:
 * Metadaten und normalisierte Ableitungen liegen im Cache unter dem Hash.
 */
import { existsSync } from 'node:fs';
import { copyFile, link, mkdir, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { basename, extname, isAbsolute, join, normalize, relative, resolve } from 'node:path';
import { ASSET_TYPES, OpenVideoError, contentHash, isRecord, sha256Hex, type AssetLoaderDefinition, type AssetRecord, type AssetResolver, type Diagnostic, type RgbaImage } from '@agentic-video/core';
import type { Cache } from '@agentic-video/cache';
import { VideoFrameReader, locateFfmpeg, probeMedia, runProcess } from '@agentic-video/ffmpeg';
import { toSfnt } from '@agentic-video/fonts';
import { detectFormat, sniffFormat, type DetectedFormat } from './detect.js';
import { fetchAsset, type FetchOptions } from './fetcher.js';
import { assertFfmpegInput, inspectAsset, type AssetMetadata } from './inspect.js';

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
  /**
   * Asset Loader aus Plugins (Story 21.1): Für Dateien mit einer ihrer Endungen liefert der Loader
   * Typ und Metadaten; die eingebaute Erkennung, Untersuchung und Normalisierung entfallen.
   */
  readonly loaders?: readonly AssetLoaderDefinition[];
}

/** Loader für einen Dateinamen (Endung, klein geschrieben), falls einer passt. */
function loaderFor(fileName: string, loaders: readonly AssetLoaderDefinition[] | undefined): AssetLoaderDefinition | undefined {
  const ext = extname(fileName).slice(1).toLowerCase();
  if (ext === '' || loaders === undefined) return undefined;
  return loaders.find((l) => l.extensions.some((e) => e.toLowerCase().replace(/^\./u, '') === ext));
}

/** Ruft `inspect` eines Loaders und macht Fehler zu Diagnosen mit Loader-Namen. */
async function inspectWithLoader(loader: AssetLoaderDefinition, bytes: Uint8Array, fileName: string): Promise<Readonly<Record<string, unknown>>> {
  try {
    return await loader.inspect(bytes, fileName);
  } catch (error) {
    if (error instanceof OpenVideoError) throw error;
    throw new OpenVideoError({
      code: 'OV_ASSET_LOADER',
      errorClass: 'AssetError',
      problem: `Asset loader "${loader.id}" failed on "${fileName}": ${error instanceof Error ? error.message : String(error)}`,
      details: { loader: loader.id },
      cause: error,
      suggestions: ['Check that the file matches the format the plugin expects.', 'Remove the plugin from settings.plugins to use the built-in detection.'],
    });
  }
}

function outside(path: string): OpenVideoError {
  return new OpenVideoError({ code: 'OV_PATH_OUTSIDE', errorClass: 'SecurityError', problem: `Asset path "${path}" is outside the project directory.`, suggestions: ['Copy the file into the project (e.g. assets/) and reference it relatively.', 'Replace symbolic links that point outside the project with real files.'] });
}

function isInside(root: string, full: string): boolean {
  const rel = relative(root, full);
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
}

function isNotFound(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT';
}

/** Kanonischer Pfad (Symlinks aufgelöst); `undefined`, wenn die Datei fehlt. */
async function canonical(path: string): Promise<string | undefined> {
  try {
    return await realpath(path);
  } catch (error) {
    if (isNotFound(error)) return undefined;
    throw error;
  }
}

/**
 * Löst einen Asset-Pfad auf und prüft die Projektgrenze zweimal: lexikalisch (`..`) und
 * nach Auflösung aller Symlinks (`realpath`). Fehlende Dateien liefern den lexikalischen Pfad.
 */
async function safeResolve(projectDir: string, path: string, allowOutside: boolean): Promise<string> {
  const full = isAbsolute(path) ? normalize(path) : resolve(projectDir, normalize(path));
  if (allowOutside) return full;
  if (!isInside(projectDir, full)) throw outside(path);
  const real = await canonical(full);
  if (real === undefined) return full;
  const root = (await canonical(projectDir)) ?? projectDir;
  if (!isInside(root, real)) throw outside(path);
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
    let parsed: unknown;
    try {
      parsed = JSON.parse(new TextDecoder().decode(hit));
    } catch (error) {
      // Ein kaputter Eintrag (z. B. abgebrochenes Schreiben) gilt als Fehltreffer und wird ersetzt.
      if (!(error instanceof SyntaxError)) throw error;
      parsed = undefined;
    }
    if (isRecord(parsed) && isRecord(parsed['metadata'])) return metadataFrom(parsed);
  }
  const meta = await inspectAsset(path, bytes, detected);
  if (options.stats !== undefined) options.stats.inspected++;
  await tier.put(key, new TextEncoder().encode(JSON.stringify(meta)));
  return meta;
}

/**
 * WOFF/WOFF2 → SFNT (Story 17.9): Renderer und Schrift-Loader bekommen eine TTF/OTF-Datei.
 * Sammlungen (TTC) bleiben unverändert; die Schrift wählt `project.fonts[].faceIndex`.
 */
async function normalizedFont(path: string, hash: string, options: PipelineOptions, workDir: string): Promise<string> {
  const sfnt = toSfnt(new Uint8Array(await readFile(path)));
  const ext = String.fromCharCode(...sfnt.subarray(0, 4)) === 'OTTO' ? '.otf' : '.ttf';
  const tier = options.cache.tier('asset');
  const key = `norm-${hash.replace('sha256:', '')}${ext.replace('.', '-')}`;
  const outFile = join(workDir, `${hash.replace('sha256:', '')}${ext}`);
  if ((await tier.get(key)) === undefined) {
    await tier.put(key, sfnt);
    if (options.stats !== undefined) options.stats.normalized++;
  }
  if (!existsSync(outFile)) await writeFile(outFile, sfnt);
  return outFile;
}

/**
 * Normalisiert Formate, die Renderer nicht direkt lesen: WOFF/WOFF2 → TTF/OTF; AVIF → PNG; animierte Bilder
 * (GIF, AVIF-Sequenz, animiertes WebP) → verlustfreies Video (FFV1, RGBA) für frame-genauen Zugriff.
 * Ergebnis ist ein Dateipfad im Cache; identische Eingaben werden nie erneut verarbeitet.
 */
async function normalizedPath(path: string, hash: string, detected: DetectedFormat, meta: AssetMetadata, options: PipelineOptions, workDir: string): Promise<string> {
  if (detected.type === 'font' && (detected.format === 'woff' || detected.format === 'woff2')) return normalizedFont(path, hash, options, workDir);
  let target: { ext: string; args: string[] } | undefined;
  if (detected.type === 'image' && meta.animated === true) target = { ext: '.mkv', args: ['-c:v', 'ffv1', '-level', '3', '-pix_fmt', 'bgra', '-fflags', '+bitexact', '-map_metadata', '-1'] };
  else if (detected.format === 'avif') target = { ext: '.png', args: ['-frames:v', '1', '-pix_fmt', 'rgba', '-fflags', '+bitexact'] };
  if (target === undefined) return path;
  assertFfmpegInput(path, await readFile(path));
  const tier = options.cache.tier('asset');
  const key = `norm-${hash.replace('sha256:', '')}${target.ext.replace('.', '-')}`;
  const outFile = join(workDir, `${hash.replace('sha256:', '')}${target.ext}`);
  const cached = await tier.get(key);
  if (cached !== undefined) {
    if (!existsSync(outFile)) await writeFile(outFile, cached);
    return outFile;
  }
  const { ffmpeg } = locateFfmpeg();
  await runProcess(ffmpeg, ['-y', '-loglevel', 'error', '-protocol_whitelist', 'file,pipe', '-i', path, ...target.args, outFile], { timeoutMs: 300_000 });
  if (options.stats !== undefined) options.stats.normalized++;
  await tier.put(key, new Uint8Array(await readFile(outFile)));
  return outFile;
}

/**
 * Animierte Bilder bekommen Dauer und Bildrate aus dem normalisierten Video, damit `image`-Nodes
 * sie frame-genau und in einer Schleife abspielen können (Story 17.4).
 */
async function withAnimationTiming(meta: AssetMetadata, detected: DetectedFormat, normalized: string): Promise<AssetMetadata> {
  if (detected.type !== 'image' || meta.animated !== true || meta.duration !== undefined) return meta;
  const info = await probeMedia(normalized);
  const fps = info.video?.fps?.value;
  return { ...meta, ...(info.duration !== undefined ? { duration: info.duration } : {}), ...(fps !== undefined ? { frameRate: fps } : {}) };
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

/**
 * Leitet eine gültige Asset-ID aus dem Dateinamen ab. Namen ohne führenden Buchstaben
 * bekommen das Präfix `asset-` (aus `123.png` wird `asset-123`); Namen ohne verwertbare
 * Zeichen bekommen den Inhalts-Hash (`asset-<hash>`), damit verschiedene Dateien nicht
 * dieselbe ID tragen.
 */
function idFrom(name: string, hash: string): string {
  const base = basename(name, extname(name)).replace(/[^A-Za-z0-9_-]+/gu, '-').replace(/^-+|-+$/gu, '');
  if (!/[A-Za-z0-9]/u.test(base)) return `asset-${hash.slice(7, 15)}`;
  return /^[A-Za-z]/u.test(base) ? base : `asset-${base}`;
}

/**
 * Legt `bytes` unter `target` an, ohne eine vorhandene Datei zu überschreiben: erst eine
 * temporäre Datei, dann ein harter Link (atomar, scheitert bei vorhandenem Ziel, folgt keinem Symlink).
 * Liefert `false`, wenn das Ziel schon existiert.
 */
async function createExclusive(target: string, bytes: Uint8Array): Promise<boolean> {
  const tmp = `${target}.${randomUUID()}.tmp`;
  await writeFile(tmp, bytes, { flag: 'wx' });
  try {
    await link(tmp, target);
    return true;
  } catch (error) {
    if (typeof error === 'object' && error !== null && 'code' in error && error.code === 'EEXIST') return false;
    throw error;
  } finally {
    await rm(tmp, { force: true });
  }
}

/** Liest den Hash einer vorhandenen Datei; `undefined`, wenn sie fehlt. */
async function hashOf(path: string): Promise<string | undefined> {
  try {
    return contentHash(new Uint8Array(await readFile(path)));
  } catch (error) {
    if (isNotFound(error)) return undefined;
    throw error;
  }
}

/**
 * Legt eine Datei in `assets/` ab. Gleicher Name mit anderem Inhalt bekommt ein Hash-Präfix;
 * gleichzeitige Importe überschreiben sich nie.
 */
async function storeInAssets(projectDir: string, fileName: string, bytes: Uint8Array, hash: string): Promise<string> {
  const assetsDir = join(projectDir, 'assets');
  await mkdir(assetsDir, { recursive: true });
  const root = (await canonical(projectDir)) ?? projectDir;
  const realAssets = (await canonical(assetsDir)) ?? assetsDir;
  if (realAssets !== join(root, 'assets')) throw outside('assets/');
  const plain = sanitize(fileName);
  for (const name of [plain, `${hash.slice(7, 15)}-${plain}`, `${hash.slice(7)}-${plain}`]) {
    const target = join(realAssets, name);
    if (await createExclusive(target, bytes)) return name;
    if ((await hashOf(target)) === hash) return name;
  }
  throw new OpenVideoError({ code: 'OV_ASSET_NAME_CONFLICT', errorClass: 'AssetError', problem: `Could not store "${plain}" in assets/: every candidate name holds different content.`, suggestions: ['Rename the file and import it again.'] });
}

/** Lädt eine URL über den Cache; offline nur aus dem Cache (FR-89). */
async function remoteBytes(src: string, options: PipelineOptions): Promise<{ readonly bytes: Uint8Array; readonly finalUrl: string }> {
  const tier = options.cache.tier('asset');
  const urlKey = `url-${sha256Hex(src)}`;
  const known = await tier.get(urlKey);
  if (known !== undefined) return { bytes: known, finalUrl: src };
  if (options.offline === true) {
    throw new OpenVideoError({ code: 'OV_ASSET_OFFLINE', errorClass: 'AssetError', problem: `Remote asset ${src} is not cached and the render is offline.`, suggestions: ['Render once online, or import the file into the project.'] });
  }
  const r = await fetchAsset(src, options.fetch);
  if (options.stats !== undefined) options.stats.fetched++;
  await tier.put(urlKey, r.bytes);
  return { bytes: r.bytes, finalUrl: r.finalUrl };
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
    const full = await safeResolve(projectDir, input.path, options.allowOutsidePaths === true);
    if (!existsSync(full)) throw new OpenVideoError({ code: 'OV_ASSET_MISSING', errorClass: 'AssetError', problem: `File "${input.path}" does not exist.`, suggestions: ['Check the path relative to the project root.'] });
    bytes = new Uint8Array(await readFile(full));
    fileName = input.fileName ?? basename(full);
  } else if (input.url !== undefined) {
    const r = await remoteBytes(input.url, options);
    bytes = r.bytes;
    fileName = input.fileName ?? (basename(new URL(r.finalUrl).pathname) || 'download');
  } else if (input.base64 !== undefined) {
    bytes = new Uint8Array(Buffer.from(input.base64, 'base64'));
    fileName = input.fileName ?? 'asset.bin';
  } else {
    throw new OpenVideoError({ code: 'OV_ASSET_INPUT', errorClass: 'AssetError', problem: 'Give "path", "url" or "base64".', suggestions: ['{ "path": "assets/logo.svg" }'] });
  }
  const loader = loaderFor(fileName, options.loaders);
  if (loader !== undefined) {
    const hash = contentHash(bytes);
    const name = await storeInAssets(projectDir, fileName, bytes, hash);
    const metadata = await inspectWithLoader(loader, bytes, fileName);
    return { id: input.id ?? idFrom(fileName, hash), type: loader.type, src: `assets/${name}`, hash, metadata: { ...metadata, loader: loader.id }, diagnostics: [] };
  }
  const detected = detectFormat(fileName, bytes);
  if (detected === undefined) {
    throw new OpenVideoError({ code: 'OV_ASSET_UNSUPPORTED', errorClass: 'AssetError', problem: `Cannot detect the format of "${fileName}".`, suggestions: ['Supported: PNG, JPEG, WebP, AVIF, SVG, GIF, MP4, WebM, MOV, WAV, FLAC, MP3, AAC, OGG, glTF, GLB, OBJ, fonts, Lottie JSON, SRT, VTT, ASS, CUBE, HDR, EXR.'] });
  }
  const hash = contentHash(bytes);
  const name = await storeInAssets(projectDir, fileName, bytes, hash);
  const target = join(projectDir, 'assets', name);
  const meta = await cachedMetadata(target, bytes, hash, detected, options);
  const workDir = join(projectDir, '.openvideo', 'assets');
  await mkdir(workDir, { recursive: true });
  await normalizedPath(target, hash, detected, meta, options, workDir);
  const diagnostics: Diagnostic[] = [];
  if (input.type !== undefined && input.type !== detected.type) {
    diagnostics.push({ code: 'OV_ASSET_TYPE', severity: 'warning', errorClass: 'AssetError', problem: `Requested type "${input.type}" but the file is ${detected.type} (${detected.format}).`, suggestions: [`Use type "${detected.type}".`] });
  }
  return {
    id: input.id ?? idFrom(fileName, hash),
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
  const seen = new Set<string>();
  const ffmpegSafe = new Set<string>();
  for (const [index, a] of list.entries()) {
    const rawId = a['id'];
    if (typeof rawId !== 'string' || rawId === '') {
      diagnostics.push({ code: 'OV_ASSET_ID_MISSING', severity: 'error', errorClass: 'AssetError', problem: `Asset #${String(index)} (src "${String(a['src'])}") has no id.`, suggestions: ['Give every entry in project.assets a unique "id".'] });
      continue;
    }
    const id = rawId;
    if (seen.has(id)) {
      diagnostics.push({ code: 'OV_ASSET_DUPLICATE_ID', severity: 'error', errorClass: 'AssetError', problem: `Asset id "${id}" is declared more than once; only the first entry is used.`, suggestions: [`Rename or remove the duplicate "${id}" entry in project.assets.`] });
      continue;
    }
    seen.add(id);
    const src = String(a['src']);
    try {
      let path: string;
      let bytes: Uint8Array;
      if (/^https?:\/\//u.test(src)) {
        bytes = (await remoteBytes(src, options)).bytes;
        const ext = extname(new URL(src).pathname) || '.bin';
        path = join(workDir, `${contentHash(bytes).slice(7)}${ext}`);
        if (!existsSync(path)) await writeFile(path, bytes);
      } else {
        path = await safeResolve(projectDir, src, options.allowOutsidePaths === true);
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
      const loader = loaderFor(src, options.loaders);
      if (loader !== undefined) {
        const metadata = await inspectWithLoader(loader, bytes, basename(src));
        const license = isRecord(a['license']) ? Object.fromEntries(Object.entries(a['license']).map(([k, v]) => [k, String(v)])) : undefined;
        records.set(id, { id, type: typeof a['type'] === 'string' ? a['type'] : loader.type, src, path, hash, metadata: { ...metadata, loader: loader.id, originalPath: path }, ...(license !== undefined ? { licenseMetadata: license } : {}) });
        continue;
      }
      const declaredType = ASSET_TYPES.find((t) => t === a['type']) ?? 'data';
      const detected: DetectedFormat = detectFormat(src, bytes) ?? { type: declaredType, format: extname(src).slice(1), mimeType: 'application/octet-stream' };
      const rawMeta = await cachedMetadata(path, bytes, hash, detected, options);
      const normalized = await normalizedPath(path, hash, detected, rawMeta, options, workDir);
      const meta = await withAnimationTiming(rawMeta, detected, normalized);
      if (normalized !== path || sniffFormat(src, bytes) !== undefined) ffmpegSafe.add(id);
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
      if (!ffmpegSafe.has(id)) assertFfmpegInput(r.path, new Uint8Array(await readFile(r.path)));
      let reader = readers.get(id);
      if (reader === undefined) {
        const opening = VideoFrameReader.open(r.path);
        reader = opening;
        readers.set(id, opening);
        // Ein gescheitertes Öffnen bleibt nicht im Cache; der nächste Aufruf versucht es neu.
        void opening.catch(() => {
          if (readers.get(id) === opening) readers.delete(id);
        });
      }
      return (await reader).frameAt(seconds);
    },
    async close() {
      const pending = [...readers.values()];
      readers.clear();
      // Gescheiterte Öffnungen wurden dem Aufrufer schon gemeldet; alle offenen Leser werden geschlossen.
      const opened = await Promise.allSettled(pending);
      const closed = await Promise.allSettled(opened.flatMap((o) => (o.status === 'fulfilled' ? [o.value.close()] : [])));
      for (const c of closed) {
        if (c.status === 'rejected') {
          const reason: unknown = c.reason;
          if (reason instanceof Error) throw reason;
          throw new OpenVideoError({
            code: 'OV_ASSET_VIDEO_CLOSE',
            errorClass: 'AssetError',
            problem: `A video frame reader could not be closed: ${String(reason)}.`,
            suggestions: ['Check that the FFmpeg process was not killed externally.', 'Run `openvideo doctor` to check FFmpeg.'],
          });
        }
      }
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
