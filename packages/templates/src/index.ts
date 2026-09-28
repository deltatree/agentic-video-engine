/**
 * @packageDocumentation
 * 15 Templates als lesbarer TSX-Quellcode (FR-81) und ein Katalog darüber.
 *
 * Jedes Template liegt in `templates/<name>/`:
 * - `src/video.tsx`: Quellcode mit SDK und Komponenten,
 * - `project.json`: daraus kompilierte IR (für Nutzer ohne Compiler),
 * - `template.json`: Titel, Beschreibung, Schlagworte,
 * - `README.md`: Anleitung zum Anpassen.
 *
 * @example
 * ```ts
 * import { createTemplateCatalog } from '@agentic-video/templates';
 * const catalog = createTemplateCatalog();
 * catalog.list().map((t) => t.name); // ['3d-product-showcase', 'architecture-diagram', …]
 * const { project, files } = await catalog.get('logo-reveal');
 * ```
 */
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { OpenVideoError, compositionDurationFrames, findComposition, isRecord } from '@agentic-video/core';

/**
 * Ein Template (lesbarer Quellcode, FR-81).
 * Strukturell gleich zu `TemplateInfo` aus `@agentic-video/agent` (ohne Import, Abhängigkeitsregel AD-14).
 */
export interface TemplateInfo {
  readonly name: string;
  readonly title: string;
  readonly description: string;
  readonly tags: readonly string[];
  /** Pfade der Quelldateien relativ zum Template. */
  readonly files: readonly string[];
  readonly width: number;
  readonly height: number;
  readonly fps: number;
  readonly durationSeconds: number;
}

/** Ein Template mit IR und Quelldateien. */
export interface TemplateContent {
  readonly info: TemplateInfo;
  readonly project: Readonly<Record<string, unknown>>;
  /** Inhalt jeder Quelldatei, Schlüssel wie in {@link TemplateInfo.files}. */
  readonly files: Readonly<Record<string, string>>;
}

/** Katalog aller Templates. Strukturell gleich zu `TemplateCatalog` aus `@agentic-video/agent`. */
export interface TemplateCatalog {
  list(): readonly TemplateInfo[];
  /** Quellcode und IR eines Templates. */
  get(name: string): Promise<TemplateContent>;
}

/** Optionen für {@link createTemplateCatalog}. */
export interface TemplateCatalogOptions {
  /** Ordner mit den Template-Ordnern. Standard: `templates/` dieses Pakets. */
  readonly dir?: string;
}

/** Ordner `templates/` dieses Pakets (neben `src/` und `dist/`). */
export const TEMPLATES_DIR: string = fileURLToPath(new URL('../templates/', import.meta.url));

/** Die kompilierte IR steht nicht in `files`, sondern in `project`. */
const PROJECT_FILE = 'project.json';

function templateError(code: string, problem: string, suggestions: readonly string[]): OpenVideoError {
  return new OpenVideoError({ code, errorClass: 'TemplateError', problem, suggestions });
}

function readJson(path: string): Record<string, unknown> {
  const value: unknown = JSON.parse(readFileSync(path, 'utf8'));
  if (!isRecord(value)) throw templateError('OV_TEMPLATE_INVALID', `${path} does not contain a JSON object.`, ['Run "npm run build:extra -w @agentic-video/templates" to rebuild project.json.']);
  return value;
}

function text(record: Readonly<Record<string, unknown>>, key: string, file: string): string {
  const value = record[key];
  if (typeof value !== 'string' || value === '') throw templateError('OV_TEMPLATE_INVALID', `${file} needs a non-empty string "${key}".`, [`Add "${key}" to ${file}.`]);
  return value;
}

/** Alle Dateien eines Templates außer `project.json` und versteckten Ordnern (z. B. `.openvideo/`), sortiert, mit `/` als Trenner. */
function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  const walk = (d: string): void => {
    for (const entry of readdirSync(d, { withFileTypes: true })) {
      const path = join(d, entry.name);
      if (entry.isDirectory()) {
        if (!entry.name.startsWith('.')) walk(path);
      }
      else if (entry.isFile()) out.push(relative(dir, path).split(sep).join('/'));
    }
  };
  walk(dir);
  return out.filter((f) => f !== PROJECT_FILE).sort();
}

function loadInfo(dir: string, name: string): TemplateInfo {
  const metaFile = join(dir, 'template.json');
  const meta = readJson(metaFile);
  const project = readJson(join(dir, PROJECT_FILE));
  const comp = findComposition(project);
  const fps = Number(comp['fps']);
  const tags = meta['tags'];
  return {
    name,
    title: text(meta, 'title', metaFile),
    description: text(meta, 'description', metaFile),
    tags: Array.isArray(tags) ? tags.filter((t): t is string => typeof t === 'string') : [],
    files: sourceFiles(dir),
    width: Number(comp['width']),
    height: Number(comp['height']),
    fps,
    durationSeconds: compositionDurationFrames(comp) / fps,
  };
}

/**
 * Erstellt den Katalog der mitgelieferten Templates. Liest `template.json` und
 * `project.json` jedes Ordners einmal beim Aufruf; `get` liest die Dateien bei Bedarf.
 *
 * @example
 * ```ts
 * const catalog = createTemplateCatalog();
 * const info = catalog.list().find((t) => t.name === 'social-video');
 * info?.height; // 1920
 * ```
 */
export function createTemplateCatalog(options: TemplateCatalogOptions = {}): TemplateCatalog {
  const dir = options.dir ?? TEMPLATES_DIR;
  if (!existsSync(dir)) throw templateError('OV_TEMPLATE_DIR', `Template folder ${dir} does not exist.`, ['Pass the folder that contains the template folders as options.dir.']);
  const names = readdirSync(dir, { withFileTypes: true })
    .filter((d) => d.isDirectory() && existsSync(join(dir, d.name, 'template.json')))
    .map((d) => d.name)
    .sort();
  const infos = new Map(names.map((name) => [name, loadInfo(join(dir, name), name)]));
  return {
    list: () => [...infos.values()],
    async get(name: string): Promise<TemplateContent> {
      const info = infos.get(name);
      if (info === undefined) {
        throw templateError('OV_TEMPLATE_UNKNOWN', `Template "${name}" does not exist.`, [`Use one of: ${names.join(', ')}.`, 'Call templates.list to see all templates.']);
      }
      const base = join(dir, name);
      const project = readJson(join(base, PROJECT_FILE));
      const files: Record<string, string> = {};
      for (const file of info.files) files[file] = await readFile(join(base, file), 'utf8');
      return { info, project, files };
    },
  };
}
