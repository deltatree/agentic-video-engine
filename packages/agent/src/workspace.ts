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
import { mkdir, readFile, readdir, rename, stat, writeFile } from 'node:fs/promises';
import { isAbsolute, join, normalize, relative, resolve } from 'node:path';
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
}

const PROJECT_ID = /^[a-z0-9][a-z0-9-]{0,62}$/u;

/** Liest die Konfiguration eines Projektordners; ohne Datei gilt `project.json`. */
export async function readProjectConfig(dir: string): Promise<ProjectConfig> {
  const file = join(dir, 'openvideo.json');
  if (!existsSync(file)) return { name: dir.split('/').pop() ?? 'project', entry: 'project.json', outDir: 'out' };
  const raw: unknown = JSON.parse(await readFile(file, 'utf8'));
  if (!isRecord(raw) || typeof raw['entry'] !== 'string') {
    throw new OpenVideoError({ code: 'OV_PROJECT_CONFIG', errorClass: 'ProjectError', problem: 'openvideo.json needs an "entry" string.', suggestions: ['{ "name": "hello", "entry": "project.json", "outDir": "out" }'] });
  }
  return { name: typeof raw['name'] === 'string' ? raw['name'] : 'project', entry: raw['entry'], outDir: typeof raw['outDir'] === 'string' ? raw['outDir'] : 'out' };
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

  /** Prüft, ob ein Projekt existiert. */
  exists(id: string): boolean {
    return existsSync(join(this.projectDir(id), 'openvideo.json'));
  }

  /**
   * Legt ein Projekt an. `source` (TSX) macht es zu einem TSX-Projekt.
   */
  async create(name: string, project: Readonly<Record<string, unknown>>, options: { readonly id?: string; readonly source?: string } = {}): Promise<string> {
    const base = (options.id ?? name).toLowerCase().replace(/[^a-z0-9]+/gu, '-').replace(/^-+|-+$/gu, '').slice(0, 40) || 'project';
    let id = base;
    for (let i = 2; this.exists(id); i++) id = `${base}-${String(i)}`;
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

  /** Liest die IR eines Projekts (bei TSX-Projekten die zuletzt kompilierte IR). */
  async load(id: string): Promise<Record<string, unknown>> {
    const file = join(this.projectDir(id), 'project.json');
    if (!existsSync(file)) {
      throw new OpenVideoError({ code: 'OV_PROJECT_UNKNOWN', errorClass: 'ProjectError', problem: `Project "${id}" does not exist.`, suggestions: ['Use project.create first, or list projects with project.inspect.'] });
    }
    const raw: unknown = JSON.parse(await readFile(file, 'utf8'));
    if (!isRecord(raw)) throw new OpenVideoError({ code: 'OV_PROJECT_INVALID', errorClass: 'ProjectError', problem: `project.json of "${id}" is not an object.`, suggestions: [] });
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

  /** Listet alle Projekte. */
  async list(): Promise<ProjectSummary[]> {
    const dir = join(this.root, 'projects');
    if (!existsSync(dir)) return [];
    const out: ProjectSummary[] = [];
    for (const id of (await readdir(dir)).sort()) {
      if (!PROJECT_ID.test(id) || !this.exists(id)) continue;
      const cfg = await this.config(id);
      const s = await stat(join(this.projectDir(id), 'project.json'));
      out.push({ id, name: cfg.name, entry: cfg.entry, kind: cfg.entry.endsWith('.tsx') ? 'tsx' : 'json', updated: s.mtime.toISOString() });
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
