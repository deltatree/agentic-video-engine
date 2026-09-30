/**
 * Projektordner und Workspace.
 *
 * Ein Projektordner hat dasselbe Format für CLI und Agent API:
 * ```text
 * <projekt>/
 *   openvideo.json   Konfiguration: { name, entry, outDir }
 *   project.json     IR (bei JSON-Projekten) oder
 *   src/video.tsx    TSX-Quelle (bei TSX-Projekten)
 *   assets/          Mediendateien
 *   out/             Renders, Frames, Manifeste
 * ```
 * Ein Workspace der Agent API legt Projekte unter `<workspace>/projects/<id>/` ab.
 */
import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { lstat, mkdir, readFile, readdir, readlink, realpath, rename, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { basename, isAbsolute, join, normalize, relative, resolve, sep } from 'node:path';
import { OpenVideoError, isRecord } from '@agentic-video/core';

/** Inhalt von `openvideo.json`. */
export interface ProjectConfig {
  readonly name: string;
  /** `project.json` oder eine TSX-Datei, relativ zum Projektordner. */
  readonly entry: string;
  readonly outDir: string;
}

/** Kurzinfo zu einem Projekt. */
export interface ProjectSummary {
  readonly id: string;
  readonly name: string;
  readonly entry: string;
  readonly kind: 'json' | 'tsx';
  readonly updated: string;
  /** Fehlercode, wenn das Projekt nicht lesbar ist (z. B. `OV_PROJECT_CONFIG`). */
  readonly error?: string;
}

const PROJECT_ID = /^[a-z0-9][a-z0-9-]{0,62}$/u;

/**
 * Ist `entry` eine TypeScript-Quelle (`.tsx` oder `.ts`)? CLI und Agent API nutzen dieselbe Regel.
 *
 * @example
 * ```ts
 * isSourceEntry('src/video.ts'); // true
 * isSourceEntry('project.json'); // false
 * ```
 */
export function isSourceEntry(entry: string): boolean {
  return entry.endsWith('.tsx') || entry.endsWith('.ts');
}

/** Liegt der relative Pfad sicher im Projektordner (nicht absolut, kein `..`)? */
function staysInside(path: string): boolean {
  if (path === '' || isAbsolute(path)) return false;
  const norm = normalize(path);
  return norm !== '..' && !norm.startsWith(`..${sep}`);
}

function configError(problem: string): OpenVideoError {
  return new OpenVideoError({ code: 'OV_PROJECT_CONFIG', errorClass: 'ProjectError', problem, suggestions: ['{ "name": "hello", "entry": "project.json", "outDir": "out" }'] });
}

/**
 * Liest die Konfiguration eines Projektordners; ohne Datei gilt `project.json`.
 *
 * @example
 * ```ts
 * const cfg = await readProjectConfig('/work/demo'); // { name, entry, outDir }
 * ```
 */
export async function readProjectConfig(dir: string): Promise<ProjectConfig> {
  const file = join(dir, 'openvideo.json');
  if (!existsSync(file)) return { name: dir.split('/').pop() ?? 'project', entry: 'project.json', outDir: 'out' };
  let raw: unknown;
  try {
    raw = JSON.parse(await readFile(file, 'utf8'));
  } catch (error) {
    if (error instanceof SyntaxError) throw configError('openvideo.json is not valid JSON.');
    throw error;
  }
  if (!isRecord(raw) || typeof raw['entry'] !== 'string') throw configError('openvideo.json needs an "entry" string.');
  const entry = raw['entry'];
  const outDir = typeof raw['outDir'] === 'string' ? raw['outDir'] : 'out';
  if (!staysInside(entry)) throw configError(`The entry "${entry}" must be a relative path inside the project.`);
  if (!staysInside(outDir)) throw configError(`The outDir "${outDir}" must be a relative path inside the project.`);
  return { name: typeof raw['name'] === 'string' ? raw['name'] : 'project', entry, outDir };
}

/** Schreibt eine Datei atomar. */
export async function writeAtomic(path: string, data: string | Uint8Array): Promise<void> {
  const tmp = `${path}.${randomUUID()}.tmp`;
  await writeFile(tmp, data);
  await rename(tmp, path);
}

/**
 * Stellt sicher, dass `path` innerhalb von `root` liegt (Schutz vor Pfad-Ausbrüchen).
 *
 * @example
 * ```ts
 * safeJoin('/ws/projects/a', 'assets/logo.svg');
 * ```
 */
export function safeJoin(root: string, path: string): string {
  const full = resolve(root, normalize(path));
  const rel = relative(root, full);
  if (rel.startsWith('..') || isAbsolute(rel)) {
    throw new OpenVideoError({ code: 'OV_PATH_OUTSIDE', errorClass: 'SecurityError', problem: `Path "${path}" leaves the project directory.`, suggestions: ['Use a path relative to the project root without "..".'] });
  }
  return full;
}

/**
 * Wie {@link safeJoin}, prüft aber zusätzlich den echten Pfad (Symlinks aufgelöst).
 * Die Datei muss existieren; sonst folgt `OV_FILE_NOT_FOUND` ohne Host-Pfad.
 *
 * @example
 * ```ts
 * const file = await safeRealPath('/ws/projects/a', 'out/frames/main-0.png');
 * ```
 */
export async function safeRealPath(root: string, path: string): Promise<string> {
  const notFound = new OpenVideoError({ code: 'OV_FILE_NOT_FOUND', errorClass: 'ApiError', problem: `File "${path}" does not exist in the project.`, suggestions: ['Use the url returned by the operation.'] });
  const full = safeJoin(root, path);
  let realRoot: string;
  let realFile: string;
  try {
    realRoot = await realpath(root);
    realFile = await realpath(full);
  } catch (error) {
    if (error instanceof Error && 'code' in error) throw notFound;
    throw error;
  }
  const rel = relative(realRoot, realFile);
  if (rel === '' || rel.startsWith('..') || isAbsolute(rel)) throw notFound;
  return realFile;
}

function hasCode(error: unknown, code: string): boolean {
  return error instanceof Error && 'code' in error && error.code === code;
}

/**
 * Verwaltet Projekte eines Workspaces.
 *
 * @example
 * ```ts
 * const ws = new Workspace('/var/lib/openvideo');
 * const id = await ws.create('Launch', project);
 * ```
 */
export class Workspace {
  constructor(readonly root: string) {}

  /** Ordner eines Projekts. */
  projectDir(id: string): string {
    if (!PROJECT_ID.test(id)) {
      throw new OpenVideoError({ code: 'OV_PROJECT_ID', errorClass: 'ProjectError', problem: `Invalid project id "${id}".`, suggestions: ['Use lowercase letters, digits and "-" (max. 63 characters).'] });
    }
    return join(this.root, 'projects', id);
  }

  /** Prüft, ob ein Projekt existiert (`openvideo.json` oder, bei geöffneten Ordnern, `project.json`). */
  exists(id: string): boolean {
    const dir = this.projectDir(id);
    return existsSync(join(dir, 'openvideo.json')) || existsSync(join(dir, 'project.json'));
  }

  /**
   * Bindet einen bestehenden Projektordner per Symlink als Projekt ein (`project.open`, Story 19.4).
   * Ist der Ordner schon eingebunden, kommt dieselbe ID zurück. Die ID folgt dem Ordnernamen
   * (bei Kollision mit `-2`, `-3` …). Die Prüfung erlaubter Wurzeln übernimmt der Aufrufer.
   *
   * @example
   * ```ts
   * const id = await ws.link('/work/launch'); // 'launch'
   * ```
   */
  async link(dir: string, preferredId?: string): Promise<string> {
    const base = (preferredId ?? basename(dir)).toLowerCase().replace(/[^a-z0-9]+/gu, '-').replace(/^-+/gu, '').slice(0, 58).replace(/-+$/gu, '') || 'project';
    await mkdir(join(this.root, 'projects'), { recursive: true });
    for (let i = 1; ; i++) {
      const id = i === 1 ? base : `${base}-${String(i)}`;
      const path = this.projectDir(id);
      let current: string | undefined;
      try {
        const info = await lstat(path);
        current = info.isSymbolicLink() ? await readlink(path) : '';
      } catch (error) {
        if (!hasCode(error, 'ENOENT')) throw error;
      }
      if (current === undefined) {
        try {
          await symlink(dir, path, 'dir');
          return id;
        } catch (error) {
          // Gleichzeitiger Aufruf hat die ID belegt: nächste versuchen.
          if (hasCode(error, 'EEXIST')) continue;
          throw error;
        }
      }
      if (current === dir) return id;
    }
  }

  /**
   * Legt ein Projekt an. `source` (TSX) macht es zu einem TSX-Projekt.
   * Die ID wird atomar reserviert (exklusives `mkdir`), damit gleichzeitige Aufrufe nie kollidieren.
   */
  async create(name: string, project: Readonly<Record<string, unknown>>, options: { readonly id?: string; readonly source?: string } = {}): Promise<string> {
    const base = (options.id ?? name).toLowerCase().replace(/[^a-z0-9]+/gu, '-').replace(/^-+|-+$/gu, '').slice(0, 40) || 'project';
    await mkdir(join(this.root, 'projects'), { recursive: true });
    let id = base;
    for (let i = 2; ; i++) {
      try {
        await mkdir(this.projectDir(id));
        break;
      } catch (error) {
        if (!hasCode(error, 'EEXIST')) throw error;
        id = `${base}-${String(i)}`;
      }
    }
    const dir = this.projectDir(id);
    await mkdir(join(dir, 'assets'), { recursive: true });
    await mkdir(join(dir, 'out'), { recursive: true });
    const entry = options.source !== undefined ? 'src/video.tsx' : 'project.json';
    if (options.source !== undefined) {
      await mkdir(join(dir, 'src'), { recursive: true });
      await writeAtomic(join(dir, entry), options.source);
    }
    await writeAtomic(join(dir, 'project.json'), `${JSON.stringify(project, null, 2)}\n`);
    await writeAtomic(join(dir, 'openvideo.json'), `${JSON.stringify({ name, entry, outDir: 'out' }, null, 2)}\n`);
    return id;
  }

  /** Entfernt ein Projekt (z. B. wenn `project.create` es wegen Fehlern verwirft). */
  async remove(id: string): Promise<void> {
    await rm(this.projectDir(id), { recursive: true, force: true });
  }

  /** Liest die IR eines Projekts (bei TSX-Projekten die zuletzt kompilierte IR). */
  async load(id: string): Promise<Record<string, unknown>> {
    const file = join(this.projectDir(id), 'project.json');
    if (!existsSync(file)) {
      throw new OpenVideoError({ code: 'OV_PROJECT_UNKNOWN', errorClass: 'ProjectError', problem: `Project "${id}" does not exist.`, suggestions: ['Use project.create first, or list projects with project.inspect.'] });
    }
    const invalid = (problem: string) => new OpenVideoError({ code: 'OV_PROJECT_INVALID', errorClass: 'ProjectError', problem, suggestions: ['Restore project.json, or replace it with project.update.'] });
    let raw: unknown;
    try {
      raw = JSON.parse(await readFile(file, 'utf8'));
    } catch (error) {
      if (error instanceof SyntaxError) throw invalid(`project.json of "${id}" is not valid JSON.`);
      throw error;
    }
    if (!isRecord(raw)) throw invalid(`project.json of "${id}" is not an object.`);
    return raw;
  }

  /** Speichert die IR eines Projekts. */
  async save(id: string, project: Readonly<Record<string, unknown>>): Promise<void> {
    await writeAtomic(join(this.projectDir(id), 'project.json'), `${JSON.stringify(project, null, 2)}\n`);
  }

  /** Konfiguration eines Projekts. */
  config(id: string): Promise<ProjectConfig> {
    return readProjectConfig(this.projectDir(id));
  }

  /** Listet alle Projekte; ein unlesbares Projekt erscheint mit `error`, statt die Liste abzubrechen. */
  async list(): Promise<ProjectSummary[]> {
    const dir = join(this.root, 'projects');
    if (!existsSync(dir)) return [];
    const out: ProjectSummary[] = [];
    for (const id of (await readdir(dir)).sort()) {
      if (!PROJECT_ID.test(id) || !this.exists(id)) continue;
      try {
        const cfg = await this.config(id);
        const s = await stat(join(this.projectDir(id), 'project.json'));
        out.push({ id, name: cfg.name, entry: cfg.entry, kind: isSourceEntry(cfg.entry) ? 'tsx' : 'json', updated: s.mtime.toISOString() });
      } catch (error) {
        const code = error instanceof OpenVideoError ? error.diagnostic.code : hasCode(error, 'ENOENT') ? 'OV_PROJECT_INVALID' : undefined;
        if (code === undefined) throw error;
        out.push({ id, name: id, entry: '', kind: 'json', updated: '', error: code });
      }
    }
    return out;
  }

  /** Ausgabeordner eines Projekts (wird angelegt). */
  async outDir(id: string): Promise<string> {
    const dir = join(this.projectDir(id), 'out');
    await mkdir(dir, { recursive: true });
    return dir;
  }
}
