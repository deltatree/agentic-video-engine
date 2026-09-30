/**
 * Gemeinsame Schemas und Hilfen der Agent-Operationen (intern, nicht Teil der Paket-API).
 */
import { join, relative } from 'node:path';
import { mkdir, writeFile } from 'node:fs/promises';
import Type from 'typebox';
import {
  OUTPUT_FORMATS,
  OpenVideoError,
  contentHash,
  findComposition,
  isRecord,
  resolveMarkers,
  toFrames,
  type Diagnostic,
  type Registry,
} from '@agentic-video/core';
import type { RenderEnvironment } from '@agentic-video/render';
import { containsScripts, scriptsInScene, type SceneSample } from './guards.js';
import type { OperationContext } from './operation.js';
import { isSourceEntry, readProjectConfig, safeJoin } from './workspace.js';

// ---------------------------------------------------------------------------
// Gemeinsame Schemas
// ---------------------------------------------------------------------------

export const ProjectId = Type.String({ pattern: '^[a-z0-9][a-z0-9-]{0,62}$', description: 'Project id returned by project.create.', examples: ['launch-video'] });
export const CompositionId = Type.Optional(Type.String({ description: 'Composition id; default is the first composition.' }));
export const FrameRef = Type.Union([Type.Integer({ minimum: 0 }), Type.String({ description: 'Time value like "2s" or "marker:intro".' })], { description: 'Frame number or time value.' });
export const DiagnosticSchema = Type.Object(
  {
    code: Type.String(),
    severity: Type.String(),
    errorClass: Type.String(),
    problem: Type.String(),
    path: Type.Optional(Type.String()),
    nodeId: Type.Optional(Type.String()),
    frame: Type.Optional(Type.Number()),
    suggestions: Type.Immutable(Type.Array(Type.String())),
  },
  { additionalProperties: true },
);
export const Diagnostics = Type.Array(DiagnosticSchema);
export const DebugSchema = Type.Object(
  {
    showBounds: Type.Optional(Type.Boolean()),
    showAnchors: Type.Optional(Type.Boolean()),
    showSafeArea: Type.Optional(Type.Boolean()),
    showBaseline: Type.Optional(Type.Boolean()),
    showGrid: Type.Optional(Type.Boolean()),
    showNodeIds: Type.Optional(Type.Boolean()),
    showCameraFrustum: Type.Optional(Type.Boolean()),
    showLightHelpers: Type.Optional(Type.Boolean()),
  },
  { additionalProperties: false },
);
export const ImageResult = Type.Object(
  {
    file: Type.String(),
    url: Type.String(),
    mimeType: Type.Literal('image/png'),
    width: Type.Integer(),
    height: Type.Integer(),
    base64: Type.Optional(Type.String()),
  },
  { additionalProperties: true },
);
export const JobResult = Type.Object({ jobId: Type.String(), state: Type.String() }, { additionalProperties: true });
export const AnyObject = Type.Record(Type.String(), Type.Unknown());

// ---------------------------------------------------------------------------
// Hilfen
// ---------------------------------------------------------------------------

export interface Loaded {
  readonly dir: string;
  readonly entry: string;
  readonly project: Record<string, unknown>;
}

export async function loadProject(ctx: OperationContext, projectId: string): Promise<Loaded> {
  const dir = ctx.services.workspace.projectDir(projectId);
  const config = await readProjectConfig(dir);
  if (isSourceEntry(config.entry)) {
    const sources = ctx.services.sources;
    if (sources === undefined) {
      throw new OpenVideoError({ code: 'OV_SOURCE_UNAVAILABLE', errorClass: 'ProjectError', problem: 'This is a TSX project, but no TSX compiler is configured.', suggestions: ['Start the server with the compiler enabled (Docker required), or use a JSON project.'] });
    }
    const compiled = await sources.compile(dir, config.entry);
    const errors = compiled.diagnostics.filter((d) => d.severity === 'error');
    if (errors.length > 0 && errors[0] !== undefined) throw new OpenVideoError(errors[0]);
    await ctx.services.workspace.save(projectId, compiled.project);
    return { dir, entry: config.entry, project: compiled.project };
  }
  return { dir, entry: config.entry, project: await ctx.services.workspace.load(projectId) };
}

/** Leiht die Render-Umgebung eines geladenen Projekts aus. */
export function withEnv<T>(ctx: OperationContext, loaded: Loaded, fn: (env: RenderEnvironment) => Promise<T>): Promise<T> {
  return ctx.services.withEnvironment(loaded.dir, loaded.project, fn);
}

/**
 * Früher, freundlicher Hinweis auf Skripte (ADR 0008); die harte Grenze setzt der Browser.
 * Prüft die IR und die ausgewertete Szene an den gegebenen Frames.
 */
export function assertRenderable(ctx: OperationContext, project: Readonly<Record<string, unknown>>, registry: Registry, samples: readonly SceneSample[]): void {
  if (ctx.services.isolation !== 'container') return;
  const scripted = [...new Set([...containsScripts(project), ...scriptsInScene(project, samples, registry)])];
  if (scripted.length > 0) {
    throw new OpenVideoError({
      code: 'OV_SANDBOX_REQUIRED',
      errorClass: 'SecurityError',
      problem: `HTML nodes with scripts (${scripted.join(', ')}) may only render inside a container worker.`,
      suggestions: ['Render through a container worker (`openvideo worker` / Docker).', 'Remove scripts from the HTML (CSS animations are fine).', 'For your own trusted project, use the CLI with --trusted.'],
    });
  }
}

/** Macht aus einer ID einen sicheren Dateinamen-Teil (nur `A-Za-z0-9_-`). */
export function fileSafe(text: string): string {
  const s = text.replace(/[^A-Za-z0-9_-]+/gu, '-').replace(/^-+|-+$/gu, '').slice(0, 64);
  return s === '' ? 'x' : s;
}

/** Kurzer, stabiler Hash für Dateinamen. */
export function shortHash(value: unknown): string {
  return contentHash(value).slice('sha256:'.length, 'sha256:'.length + 10);
}

/**
 * Prüft ein Ausgabeformat gegen {@link OUTPUT_FORMATS}; `plugin:<id>` nennt einen Exporter aus
 * einem Plugin (die Render-Umgebung prüft, ob er registriert ist).
 */
export function outputFormat(value: unknown): (typeof OUTPUT_FORMATS)[number] | `plugin:${string}` {
  const hit = OUTPUT_FORMATS.find((f) => f === value);
  if (hit !== undefined) return hit;
  if (typeof value === 'string' && /^plugin:[A-Za-z][A-Za-z0-9_.-]{0,63}$/u.test(value)) return `plugin:${value.slice('plugin:'.length)}`;
  throw new OpenVideoError({ code: 'OV_RENDER_PROFILE', errorClass: 'RenderError', problem: `Unknown output format "${String(value)}".`, suggestions: [`Use one of: ${OUTPUT_FORMATS.join(', ')}.`, 'Exporters from plugins are "plugin:<id>" (see plugins.list).'] });
}

export function rangeError(problem: string): OpenVideoError {
  return new OpenVideoError({ code: 'OV_RANGE_INVALID', errorClass: 'ApiError', problem, suggestions: ['Use frames between 0 and the composition duration (timeline.inspect shows it).'] });
}

export function frameOf(project: Readonly<Record<string, unknown>>, compositionId: string | undefined, frame: number | string): number {
  if (typeof frame === 'number') return frame;
  const comp = findComposition(project, compositionId);
  const fps = Number(comp['fps']);
  const markers = resolveMarkers(
    Array.isArray(comp['markers']) ? comp['markers'].filter(isRecord).map((m) => ({ id: String(m['id']), time: typeof m['time'] === 'number' ? m['time'] : String(m['time']) })) : [],
    fps,
  );
  return Math.round(toFrames(frame, { fps, markers }));
}

export async function imageOutput(ctx: OperationContext, projectId: string, name: string, png: Uint8Array, size: { width: number; height: number }, inline: boolean) {
  const dir = join(await ctx.services.workspace.outDir(projectId), 'frames');
  await mkdir(dir, { recursive: true });
  const file = safeJoin(dir, name);
  await writeFile(file, png);
  return {
    file,
    url: `/v1/files/${projectId}/${relative(ctx.services.workspace.projectDir(projectId), file)}`,
    mimeType: 'image/png' as const,
    width: size.width,
    height: size.height,
    ...(inline ? { base64: Buffer.from(png).toString('base64') } : {}),
  };
}

export function plainDiagnostics(list: readonly Diagnostic[]): Diagnostic[] {
  return list.map((d) => ({ ...d }));
}

/** Validierungsoptionen mit Plugin-Nodes und Komponenten des Registers. */
export function validateOptionsOf(registry: Registry): { extraNodeSchemas: ReturnType<Registry['extraNodeSchemas']>; components?: string[] } {
  const components = [...registry.components.keys()];
  return { extraNodeSchemas: registry.extraNodeSchemas(), ...(components.length > 0 ? { components } : {}) };
}

/** Schlüssel einer Diagnose für „nur neue Fehler“ (wie `applyPatches`). */
export function errorKey(d: Diagnostic): string {
  return `${d.code}|${d.path ?? ''}|${d.problem}`;
}

export function tsxProjectError(): OpenVideoError {
  return new OpenVideoError({ code: 'OV_PROJECT_TSX', errorClass: 'ProjectError', problem: 'TSX projects are edited in their source file.', suggestions: ['Edit the TSX entry file, or use composition.patch (AST write-back).'] });
}

