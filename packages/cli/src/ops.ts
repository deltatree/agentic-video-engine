/**
 * CLI-Parität zur Agent API (ADR 0009, Story 19.2): `openvideo op <name>` ruft jede Operation
 * aus `OPERATIONS` mit denselben Diensten wie HTTP und MCP auf. Kurzbefehle (`patch`,
 * `contact-sheet`, `import`) bauen nur die Eingabe und nutzen dieselben Operationen.
 */
import { existsSync } from 'node:fs';
import { readFile, realpath } from 'node:fs/promises';
import { extname, join, relative, resolve } from 'node:path';
import { OPERATIONS, formatFromPath, invokeOperation, type AgentServices, type InvocationResult } from '@agentic-video/agent';
import { OpenVideoError, isRecord } from '@agentic-video/core';
import { singleProjectWorkspace } from './project.js';

/**
 * Liest `--input`: JSON-Text, `@datei.json` (relativ zu `cwd`) oder `-` für stdin-Text in `stdin`.
 *
 * @example
 * ```ts
 * await parseInputArg('{"frame": 0}', '/work'); // { frame: 0 }
 * await parseInputArg('@patches.json', '/work');
 * ```
 */
export async function parseInputArg(value: string | undefined, cwd: string): Promise<unknown> {
  if (value === undefined || value.trim() === '') return {};
  const text = value.startsWith('@') ? await readInputFile(resolve(cwd, value.slice(1))) : value;
  try {
    const parsed: unknown = JSON.parse(text);
    return parsed;
  } catch (error) {
    if (error instanceof SyntaxError) {
      throw new OpenVideoError({
        code: 'OV_CLI_INPUT',
        errorClass: 'UsageError',
        problem: `--input is not valid JSON (${error.message}).`,
        suggestions: [`Quote the JSON for the shell: --input '{"projectId":"demo"}'`, 'Or put it in a file and pass --input @input.json.'],
      });
    }
    throw error;
  }
}

async function readInputFile(file: string): Promise<string> {
  try {
    return await readFile(file, 'utf8');
  } catch (error) {
    if (error instanceof Error && 'code' in error) {
      throw new OpenVideoError({ code: 'OV_CLI_INPUT', errorClass: 'UsageError', problem: `The input file ${file} cannot be read.`, suggestions: ['Check the path after "@"; it is relative to the current directory.'] });
    }
    throw error;
  }
}

/** Liegt in `dir` ein Projekt (`openvideo.json` oder `project.json`)? */
export function isProjectDir(dir: string): boolean {
  return existsSync(join(dir, 'openvideo.json')) || existsSync(join(dir, 'project.json'));
}

/**
 * Erlaubte Projektwurzeln für `project.open`: die Ordner aus `--project` und `OPENVIDEO_PROJECT_ROOTS`
 * (kommagetrennt, relativ zu `cwd`).
 *
 * @example
 * ```ts
 * projectRootsOf(['/work/launch'], { OPENVIDEO_PROJECT_ROOTS: '/work' }, '/'); // ['/work/launch', '/work']
 * ```
 */
export function projectRootsOf(dirs: readonly string[], env: Readonly<Record<string, string | undefined>>, cwd: string): string[] {
  const fromEnv = (env['OPENVIDEO_PROJECT_ROOTS'] ?? '').split(',').map((r) => r.trim()).filter((r) => r !== '').map((r) => resolve(cwd, r));
  return [...new Set([...dirs, ...fromEnv])];
}

/** Workspace und geöffnetes Projekt eines CLI-Aufrufs. */
export interface ProjectContext {
  readonly workspaceDir: string;
  /** Echter Pfad des Projektordners, falls einer geöffnet ist. */
  readonly projectDir?: string;
  /** Wird nach dem Anlegen der Dienste gesetzt (Symlink im Workspace). */
  readonly link: (services: AgentServices) => Promise<string | undefined>;
}

/**
 * Bestimmt den Kontext für `op`, `serve --project` und `mcp --project`:
 * - `--project <dir>` ohne `--workspace`: Ein-Projekt-Workspace im Projekt (wie `dev`).
 * - `--project <dir>` mit `--workspace`: Das Projekt wird in diesen Workspace eingebunden.
 * - ohne `--project`: der Workspace (`--workspace`, `OPENVIDEO_WORKSPACE`, `.openvideo-workspace`).
 *
 * @example
 * ```ts
 * const ctx = await projectContext({ project: 'demo', cwd: '/work', env: process.env });
 * ```
 */
export async function projectContext(options: { readonly project?: string | undefined; readonly workspace?: string | undefined; readonly cwd: string; readonly env: Readonly<Record<string, string | undefined>> }): Promise<ProjectContext> {
  const explicitWorkspace = options.workspace ?? options.env['OPENVIDEO_WORKSPACE'];
  if (options.project === undefined) {
    return { workspaceDir: resolve(options.cwd, explicitWorkspace ?? '.openvideo-workspace'), link: () => Promise.resolve(undefined) };
  }
  const given = resolve(options.cwd, options.project);
  if (!isProjectDir(given)) {
    throw new OpenVideoError({ code: 'OV_PROJECT_UNKNOWN', errorClass: 'ProjectError', problem: `No project found in ${given}.`, suggestions: ['Pass a folder with openvideo.json or project.json.', 'Create one with `openvideo create <name>`.'] });
  }
  const projectDir = await realpath(given);
  if (explicitWorkspace === undefined) {
    const single = await singleProjectWorkspace(projectDir);
    return { workspaceDir: single.workspaceDir, projectDir, link: () => Promise.resolve(single.projectId) };
  }
  return { workspaceDir: resolve(options.cwd, explicitWorkspace), projectDir, link: (services) => services.workspace.link(projectDir) };
}

/** Hat das Eingabeschema der Operation ein Feld `key`? */
function hasField(name: string, key: string): boolean {
  const op = OPERATIONS.get(name);
  const props = op !== undefined && isRecord(op.input) ? op.input['properties'] : undefined;
  return isRecord(props) && key in props;
}

/**
 * Ergänzt die Eingabe um den Projektkontext: `projectId` des geöffneten Projekts und
 * `inline: false` (die CLI schreibt Bilder als Dateien, nicht als Base64 in die Ausgabe).
 *
 * @example
 * ```ts
 * withDefaults('frame.render', { frame: 0 }, 'demo'); // { projectId: 'demo', inline: false, frame: 0 }
 * ```
 */
export function withDefaults(name: string, input: unknown, projectId: string | undefined): unknown {
  if (!isRecord(input)) return input;
  return {
    ...(projectId !== undefined && hasField(name, 'projectId') && input['projectId'] === undefined ? { projectId } : {}),
    ...(hasField(name, 'inline') && input['inline'] === undefined ? { inline: false } : {}),
    ...input,
  };
}

/**
 * Ruft eine Operation wie HTTP und MCP auf. Job-Operationen warten auf das Ende des Jobs,
 * damit der Prozess nicht vor dem Render endet.
 *
 * @example
 * ```ts
 * const r = await runOperation(services, 'composition.validate', { projectId: 'demo' });
 * ```
 */
export async function runOperation(services: AgentServices, name: string, input: unknown): Promise<InvocationResult> {
  const r = await invokeOperation(OPERATIONS, name, input, { services, via: 'cli' });
  if (!r.ok || OPERATIONS.get(name)?.job !== true || !isRecord(r.result) || typeof r.result['jobId'] !== 'string') return r;
  const info = await services.jobs.wait(r.result['jobId']);
  if (info.state === 'failed' && info.error !== undefined) return { ok: false, error: info.error };
  return { ok: true, result: { ...info } };
}

/**
 * Ist das Ergebnis ein fachlicher Fehlschlag (`ok: false` oder Fehlerdiagnosen)? Bestimmt den Exit-Code 1.
 *
 * @example
 * ```ts
 * resultFailed({ ok: false, diagnostics: [] }); // true
 * ```
 */
export function resultFailed(result: unknown): boolean {
  if (!isRecord(result)) return false;
  if (result['ok'] === false || result['state'] === 'failed' || result['state'] === 'cancelled') return true;
  const diagnostics = result['diagnostics'];
  return Array.isArray(diagnostics) && diagnostics.some((d) => isRecord(d) && d['severity'] === 'error');
}

/**
 * Eingabe für `openvideo import <datei>`: Dateien im Projekt über `path`, andere als Inhalt
 * (Text, JSON oder Base64 für Binärdateien wie `.glb`).
 *
 * @example
 * ```ts
 * await importInput('/work/logo.svg', '/work/demo', {}); // { format: 'svg', content: '<svg…' }
 * ```
 */
export async function importInput(file: string, projectDir: string, options: { readonly format?: string | undefined; readonly idPrefix?: string | undefined }): Promise<Record<string, unknown>> {
  const format = options.format ?? formatFromPath(file);
  if (format === undefined) {
    throw new OpenVideoError({ code: 'OV_IMPORT_FORMAT', errorClass: 'ImportError', problem: `The format of ${file} is unknown.`, suggestions: ['Pass --format svg|lottie|gltf|html|anime|motion-canvas.'] });
  }
  const base = { format, ...(options.idPrefix !== undefined ? { idPrefix: options.idPrefix } : {}) };
  const rel = relative(projectDir, file);
  if (!rel.startsWith('..') && !rel.startsWith('/') && existsSync(file)) return { ...base, path: rel };
  const bytes = await readFile(file);
  if (extname(file).toLowerCase() === '.glb') return { ...base, base64: bytes.toString('base64') };
  const text = bytes.toString('utf8');
  if (format === 'anime' || format === 'motion-canvas' || format === 'lottie') {
    const parsed: unknown = JSON.parse(text);
    return { ...base, content: parsed };
  }
  return { ...base, content: text };
}
