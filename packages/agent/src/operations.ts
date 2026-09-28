/**
 * Die Operationen der Agent API (FR-21, Auftrag A5).
 */
import { join, relative } from 'node:path';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import Type from 'typebox';
import {
  OUTPUT_FORMATS,
  OpenVideoError,
  SCHEMA_VERSION,
  analyzeScene,
  applyPatches,
  compositionDurationFrames,
  computeBounds,
  contentHash,
  evaluateScene,
  findComposition,
  formatDiagnostic,
  isRecord,
  resolveMarkers,
  toFrames,
  validateProject,
  type Diagnostic,
  type Patch,
  type Registry,
} from '@agentic-video/core';
import { checkProject, describeScene, inspectTimeline, profileById, renderFrame, renderVideo, sceneTree, type OutputProfile, type RenderEnvironment } from '@agentic-video/render';
import { assertFps, assertFrameCount, assertImageSize, containsScripts, sampleFrames, scriptsInScene, type SceneSample } from './guards.js';
import { defineOperation, type OperationContext, type OperationDefinition } from './operation.js';
import { isSourceEntry, readProjectConfig, safeJoin, safeRealPath, writeAtomic } from './workspace.js';

// ---------------------------------------------------------------------------
// Gemeinsame Schemas
// ---------------------------------------------------------------------------

const ProjectId = Type.String({ pattern: '^[a-z0-9][a-z0-9-]{0,62}$', description: 'Project id returned by project.create.', examples: ['launch-video'] });
const CompositionId = Type.Optional(Type.String({ description: 'Composition id; default is the first composition.' }));
const FrameRef = Type.Union([Type.Integer({ minimum: 0 }), Type.String({ description: 'Time value like "2s" or "marker:intro".' })], { description: 'Frame number or time value.' });
const DiagnosticSchema = Type.Object(
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
const Diagnostics = Type.Array(DiagnosticSchema);
const DebugSchema = Type.Object(
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
const ImageResult = Type.Object(
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
const JobResult = Type.Object({ jobId: Type.String(), state: Type.String() }, { additionalProperties: true });
const AnyObject = Type.Record(Type.String(), Type.Unknown());

// ---------------------------------------------------------------------------
// Hilfen
// ---------------------------------------------------------------------------

interface Loaded {
  readonly dir: string;
  readonly entry: string;
  readonly project: Record<string, unknown>;
}

async function loadProject(ctx: OperationContext, projectId: string): Promise<Loaded> {
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
function withEnv<T>(ctx: OperationContext, loaded: Loaded, fn: (env: RenderEnvironment) => Promise<T>): Promise<T> {
  return ctx.services.withEnvironment(loaded.dir, loaded.project, fn);
}

/**
 * Früher, freundlicher Hinweis auf Skripte (ADR 0008); die harte Grenze setzt der Browser.
 * Prüft die IR und die ausgewertete Szene an den gegebenen Frames.
 */
function assertRenderable(ctx: OperationContext, project: Readonly<Record<string, unknown>>, registry: Registry, samples: readonly SceneSample[]): void {
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
function fileSafe(text: string): string {
  const s = text.replace(/[^A-Za-z0-9_-]+/gu, '-').replace(/^-+|-+$/gu, '').slice(0, 64);
  return s === '' ? 'x' : s;
}

/** Kurzer, stabiler Hash für Dateinamen. */
function shortHash(value: unknown): string {
  return contentHash(value).slice('sha256:'.length, 'sha256:'.length + 10);
}

/** Prüft ein Ausgabeformat gegen {@link OUTPUT_FORMATS}. */
function outputFormat(value: unknown): (typeof OUTPUT_FORMATS)[number] {
  const hit = OUTPUT_FORMATS.find((f) => f === value);
  if (hit === undefined) {
    throw new OpenVideoError({ code: 'OV_RENDER_PROFILE', errorClass: 'RenderError', problem: `Unknown output format "${String(value)}".`, suggestions: [`Use one of: ${OUTPUT_FORMATS.join(', ')}.`] });
  }
  return hit;
}

function rangeError(problem: string): OpenVideoError {
  return new OpenVideoError({ code: 'OV_RANGE_INVALID', errorClass: 'ApiError', problem, suggestions: ['Use frames between 0 and the composition duration (timeline.inspect shows it).'] });
}

function frameOf(project: Readonly<Record<string, unknown>>, compositionId: string | undefined, frame: number | string): number {
  if (typeof frame === 'number') return frame;
  const comp = findComposition(project, compositionId);
  const fps = Number(comp['fps']);
  const markers = resolveMarkers(
    Array.isArray(comp['markers']) ? comp['markers'].filter(isRecord).map((m) => ({ id: String(m['id']), time: typeof m['time'] === 'number' ? m['time'] : String(m['time']) })) : [],
    fps,
  );
  return Math.round(toFrames(frame, { fps, markers }));
}

async function imageOutput(ctx: OperationContext, projectId: string, name: string, png: Uint8Array, size: { width: number; height: number }, inline: boolean) {
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

function plainDiagnostics(list: readonly Diagnostic[]): Diagnostic[] {
  return list.map((d) => ({ ...d }));
}

/** Validierungsoptionen mit Plugin-Nodes und Komponenten des Registers. */
function validateOptionsOf(registry: Registry): { extraNodeSchemas: ReturnType<Registry['extraNodeSchemas']>; components?: string[] } {
  const components = [...registry.components.keys()];
  return { extraNodeSchemas: registry.extraNodeSchemas(), ...(components.length > 0 ? { components } : {}) };
}

/** Schlüssel einer Diagnose für „nur neue Fehler“ (wie `applyPatches`). */
function errorKey(d: Diagnostic): string {
  return `${d.code}|${d.path ?? ''}|${d.problem}`;
}

function tsxProjectError(): OpenVideoError {
  return new OpenVideoError({ code: 'OV_PROJECT_TSX', errorClass: 'ProjectError', problem: 'TSX projects are edited in their source file.', suggestions: ['Edit the TSX entry file, or use composition.patch (AST write-back).'] });
}

// ---------------------------------------------------------------------------
// Operationen
// ---------------------------------------------------------------------------

const projectCreate = defineOperation({
  name: 'project.create',
  summary: 'Create a project from a template, a JSON project, TSX source, or an empty composition.',
  input: Type.Object(
    {
      name: Type.String({ minLength: 1 }),
      template: Type.Optional(Type.String()),
      project: Type.Optional(AnyObject),
      source: Type.Optional(Type.String({ description: 'TSX source (runs in the sandbox).' })),
      width: Type.Optional(Type.Integer({ minimum: 1 })),
      height: Type.Optional(Type.Integer({ minimum: 1 })),
      fps: Type.Optional(Type.Number({ exclusiveMinimum: 0 })),
      duration: Type.Optional(Type.Union([Type.Number(), Type.String()])),
    },
    { additionalProperties: false },
  ),
  output: Type.Object({ projectId: Type.String(), compositions: Type.Array(Type.String()), diagnostics: Diagnostics }),
  example: { input: { name: 'Launch video', template: 'product-launch' } },
  async handler(input, ctx) {
    let project: Record<string, unknown>;
    if (input.project !== undefined) project = { ...input.project };
    else if (input.template !== undefined) {
      const catalog = ctx.services.templates;
      if (catalog === undefined) throw new OpenVideoError({ code: 'OV_TEMPLATES_UNAVAILABLE', errorClass: 'ApiError', problem: 'No template catalog is configured.', suggestions: [] });
      project = { ...(await catalog.get(input.template)).project };
    } else {
      project = {
        schemaVersion: SCHEMA_VERSION,
        metadata: { title: input.name },
        compositions: [{ id: 'main', width: input.width ?? 1920, height: input.height ?? 1080, fps: input.fps ?? 30, duration: input.duration ?? '10s', background: '#0B0D12', nodes: [] }],
      };
    }
    const id = await ctx.services.workspace.create(input.name, project, input.source !== undefined ? { source: input.source } : {});
    try {
      const loaded = await loadProject(ctx, id);
      return await withEnv(ctx, loaded, (env) => {
        // Ein Projekt mit Schema- oder Referenzfehlern wird nicht angelegt (B4).
        const errors = validateProject(loaded.project, validateOptionsOf(env.registry)).diagnostics.filter((d) => d.severity === 'error');
        const first = errors[0];
        if (first !== undefined) {
          throw new OpenVideoError({
            code: 'OV_PROJECT_INVALID',
            errorClass: 'ProjectError',
            problem: `The project was not created: ${String(errors.length)} validation error(s). First: ${first.problem}`,
            ...(first.path !== undefined ? { path: first.path } : {}),
            suggestions: ['Fix the errors and call project.create again.', ...errors.slice(0, 5).map((d) => `${d.path ?? '(project)'}: ${d.problem}`)],
          });
        }
        const diagnostics = checkProject(env, loaded.project);
        const comps = Array.isArray(loaded.project['compositions']) ? loaded.project['compositions'].filter(isRecord).map((c) => String(c['id'])) : [];
        return Promise.resolve({ projectId: id, compositions: comps, diagnostics: plainDiagnostics(diagnostics) });
      });
    } catch (error) {
      await ctx.services.workspace.remove(id);
      throw error;
    }
  },
});

const projectInspect = defineOperation({
  name: 'project.inspect',
  summary: 'List projects, or summarize one project (compositions, assets, fonts, profiles).',
  input: Type.Object({ projectId: Type.Optional(ProjectId) }, { additionalProperties: false }),
  output: AnyObject,
  example: { input: { projectId: 'launch-video' } },
  async handler(input, ctx) {
    if (input.projectId === undefined) return { projects: await ctx.services.workspace.list() };
    const loaded = await loadProject(ctx, input.projectId);
    const p = loaded.project;
    const comps = Array.isArray(p['compositions']) ? p['compositions'].filter(isRecord) : [];
    return {
      projectId: input.projectId,
      entry: loaded.entry,
      kind: isSourceEntry(loaded.entry) ? 'tsx' : 'json',
      schemaVersion: p['schemaVersion'],
      metadata: p['metadata'] ?? {},
      compositions: comps.map((c) => ({ id: c['id'], width: c['width'], height: c['height'], fps: c['fps'], durationFrames: compositionDurationFrames(c), nodes: Array.isArray(c['nodes']) ? c['nodes'].length : 0, tracks: Array.isArray(c['tracks']) ? c['tracks'].length : 0 })),
      assets: p['assets'] ?? [],
      fonts: p['fonts'] ?? [],
      renderProfiles: p['renderProfiles'] ?? [],
    };
  },
});

const projectUpdate = defineOperation({
  name: 'project.update',
  summary: 'Replace the whole IR of a JSON project after validation (used by code editors).',
  input: Type.Object({ projectId: ProjectId, project: AnyObject }, { additionalProperties: false }),
  output: Type.Object({ ok: Type.Boolean(), diagnostics: Diagnostics }),
  example: { input: { projectId: 'launch-video', project: { schemaVersion: '1.0.0', compositions: [] } } },
  async handler(input, ctx) {
    const cfg = await ctx.services.workspace.config(input.projectId);
    if (isSourceEntry(cfg.entry)) throw tsxProjectError();
    const diagnostics = await ctx.services.withEnvironment(ctx.services.workspace.projectDir(input.projectId), input.project, (env) => Promise.resolve(checkProject(env, input.project)));
    if (diagnostics.some((d) => d.severity === 'error')) return { ok: false, diagnostics: plainDiagnostics(diagnostics) };
    await ctx.services.workspace.save(input.projectId, input.project);
    return { ok: true, diagnostics: plainDiagnostics(diagnostics) };
  },
});

const compositionCreate = defineOperation({
  name: 'composition.create',
  summary: 'Add a composition to a project.',
  input: Type.Object({ projectId: ProjectId, composition: AnyObject }, { additionalProperties: false }),
  output: Type.Object({ ok: Type.Boolean(), compositionId: Type.String(), diagnostics: Diagnostics }),
  example: { input: { projectId: 'launch-video', composition: { id: 'outro', width: 1920, height: 1080, fps: 30, duration: '4s', nodes: [] } } },
  async handler(input, ctx) {
    const loaded = await loadProject(ctx, input.projectId);
    if (isSourceEntry(loaded.entry)) throw tsxProjectError();
    const compositionId = String(input.composition['id']);
    const existing: unknown = loaded.project['compositions'];
    const comps: unknown[] = Array.isArray(existing) ? Array.from<unknown>(existing) : [];
    if (comps.some((c) => isRecord(c) && c['id'] === input.composition['id'])) {
      return {
        ok: false,
        compositionId,
        diagnostics: [{ code: 'OV_COMPOSITION_EXISTS', severity: 'error', errorClass: 'ProjectError', problem: `A composition with id "${compositionId}" already exists.`, suggestions: ['Choose another id, or change the existing composition with composition.patch.'] }],
      };
    }
    const next: Record<string, unknown> = { ...loaded.project, compositions: [...comps, { ...input.composition }] };
    return withEnv(ctx, loaded, async (env) => {
      const options = validateOptionsOf(env.registry);
      const before = new Set(validateProject(loaded.project, options).diagnostics.filter((d) => d.severity === 'error').map(errorKey));
      const after = validateProject(next, options).diagnostics;
      const introduced = after.filter((d) => d.severity === 'error' && !before.has(errorKey(d)));
      if (introduced.length > 0) return { ok: false, compositionId, diagnostics: plainDiagnostics(introduced) };
      await ctx.services.workspace.save(input.projectId, next);
      return { ok: true, compositionId, diagnostics: plainDiagnostics(after) };
    });
  },
});

const compositionGet = defineOperation({
  name: 'composition.get',
  summary: 'Return the IR of a composition.',
  input: Type.Object({ projectId: ProjectId, compositionId: CompositionId }, { additionalProperties: false }),
  output: AnyObject,
  example: { input: { projectId: 'launch-video', compositionId: 'main' } },
  async handler(input, ctx) {
    const loaded = await loadProject(ctx, input.projectId);
    return findComposition(loaded.project, input.compositionId);
  },
});

const compositionValidate = defineOperation({
  name: 'composition.validate',
  summary: 'Validate schema, references, fonts, assets and backend capabilities before rendering.',
  input: Type.Object({ projectId: ProjectId, compositionId: CompositionId }, { additionalProperties: false }),
  output: Type.Object({ ok: Type.Boolean(), diagnostics: Diagnostics, text: Type.String() }),
  example: { input: { projectId: 'launch-video' } },
  async handler(input, ctx) {
    const loaded = await loadProject(ctx, input.projectId);
    const checked = await withEnv(ctx, loaded, (env) => Promise.resolve(checkProject(env, loaded.project)));
    const all = checked.filter((d) => input.compositionId === undefined || d.compositionId === undefined || d.compositionId === input.compositionId || d.path?.startsWith(`composition.${input.compositionId}`) === true);
    return { ok: all.every((d) => d.severity !== 'error'), diagnostics: plainDiagnostics(all), text: all.map(formatDiagnostic).join('\n\n') };
  },
});

const PatchSchema = Type.Record(Type.String(), Type.Unknown(), {
  description:
    'A patch object with "op": setProperty | addNode | removeNode | moveNode | addKeyframe | removeKeyframe | replaceAsset | addAsset | removeAsset | setCompositionProperty | setProjectProperty. setProperty/setCompositionProperty/setProjectProperty accept "keepNull": true to store null instead of deleting the property.',
});

function asPatches(list: readonly Readonly<Record<string, unknown>>[]): Patch[] {
  const out: Patch[] = [];
  for (const p of list) {
    const r = applyPatchesShapeCheck(p);
    out.push(r);
  }
  return out;
}

function applyPatchesShapeCheck(p: Readonly<Record<string, unknown>>): Patch {
  const str = (k: string): string => {
    const v = p[k];
    if (typeof v !== 'string') throw new OpenVideoError({ code: 'OV_PATCH_INVALID', errorClass: 'PatchError', problem: `Patch ${String(p['op'])} needs "${k}" as string.`, suggestions: [] });
    return v;
  };
  const optStr = (k: string): string | undefined => (typeof p[k] === 'string' ? p[k] : undefined);
  const comp = optStr('compositionId');
  const withComp = comp !== undefined ? { compositionId: comp } : {};
  const time = (k: string): number | string => {
    const v = p[k];
    if (typeof v === 'number' || typeof v === 'string') return v;
    throw new OpenVideoError({ code: 'OV_PATCH_INVALID', errorClass: 'PatchError', problem: `Patch ${String(p['op'])} needs "${k}" as time value.`, suggestions: [] });
  };
  const obj = (k: string): Readonly<Record<string, unknown>> => {
    const v = p[k];
    if (!isRecord(v)) throw new OpenVideoError({ code: 'OV_PATCH_INVALID', errorClass: 'PatchError', problem: `Patch ${String(p['op'])} needs "${k}" as object.`, suggestions: [] });
    return v;
  };
  const rawIndex = p['index'];
  if (rawIndex !== undefined && (typeof rawIndex !== 'number' || !Number.isInteger(rawIndex) || rawIndex < 0)) {
    throw new OpenVideoError({ code: 'OV_PATCH_INVALID', errorClass: 'PatchError', problem: `Patch ${String(p['op'])} needs "index" as a non-negative integer.`, suggestions: ['Leave out "index" to append, or use 0 for the first position.'] });
  }
  const index = typeof rawIndex === 'number' ? { index: rawIndex } : {};
  const rawKeepNull = p['keepNull'];
  if (rawKeepNull !== undefined && typeof rawKeepNull !== 'boolean') {
    throw new OpenVideoError({ code: 'OV_PATCH_INVALID', errorClass: 'PatchError', problem: `Patch ${String(p['op'])} needs "keepNull" as boolean.`, suggestions: ['Use "keepNull": true to store null instead of deleting the property.'] });
  }
  const keepNull = rawKeepNull === true ? { keepNull: true } : {};
  switch (p['op']) {
    case 'setProperty':
      return { op: 'setProperty', nodeId: str('nodeId'), property: str('property'), value: p['value'], ...keepNull, ...withComp };
    case 'addNode':
      return { op: 'addNode', parentId: typeof p['parentId'] === 'string' ? p['parentId'] : null, node: obj('node'), ...index, ...withComp };
    case 'removeNode':
      return { op: 'removeNode', nodeId: str('nodeId'), ...withComp };
    case 'moveNode':
      return { op: 'moveNode', nodeId: str('nodeId'), parentId: typeof p['parentId'] === 'string' ? p['parentId'] : null, ...index, ...withComp };
    case 'addKeyframe': {
      const k = obj('keyframe');
      const t = k['t'];
      if (typeof t !== 'number' && typeof t !== 'string') throw new OpenVideoError({ code: 'OV_PATCH_INVALID', errorClass: 'PatchError', problem: 'keyframe.t must be a time value.', suggestions: ['keyframe: { t: "1s", v: 100 }'] });
      return { op: 'addKeyframe', nodeId: str('nodeId'), property: str('property'), keyframe: { t, v: k['v'], ...(typeof k['ease'] === 'string' ? { ease: k['ease'] } : {}) }, ...withComp };
    }
    case 'removeKeyframe':
      return { op: 'removeKeyframe', nodeId: str('nodeId'), property: str('property'), t: time('t'), ...withComp };
    case 'replaceAsset':
      return { op: 'replaceAsset', assetId: str('assetId'), src: str('src'), ...(optStr('type') !== undefined ? { type: str('type') } : {}), ...(optStr('hash') !== undefined ? { hash: str('hash') } : {}) };
    case 'addAsset':
      return { op: 'addAsset', asset: obj('asset') };
    case 'removeAsset':
      return { op: 'removeAsset', assetId: str('assetId') };
    case 'setCompositionProperty':
      return { op: 'setCompositionProperty', compositionId: str('compositionId'), property: str('property'), value: p['value'], ...keepNull };
    case 'setProjectProperty':
      return { op: 'setProjectProperty', property: str('property'), value: p['value'], ...keepNull };
    default:
      throw new OpenVideoError({ code: 'OV_PATCH_INVALID', errorClass: 'PatchError', problem: `Unknown patch op "${String(p['op'])}".`, suggestions: ['Use setProperty, addNode, removeNode, moveNode, addKeyframe, removeKeyframe, replaceAsset.'] });
  }
}

const compositionPatch = defineOperation({
  name: 'composition.patch',
  summary: 'Apply semantic patches atomically; TSX projects are updated through AST edits.',
  input: Type.Object({ projectId: ProjectId, patches: Type.Array(PatchSchema, { minItems: 1 }), dryRun: Type.Optional(Type.Boolean()) }, { additionalProperties: false }),
  output: Type.Object({ ok: Type.Boolean(), diagnostics: Diagnostics, inverse: Type.Array(AnyObject), sourceUpdated: Type.Boolean() }),
  example: { input: { projectId: 'launch-video', patches: [{ op: 'setProperty', nodeId: 'headline', property: 'fontSize', value: 82 }, { op: 'setProperty', nodeId: 'headline', property: 'y', value: 720 }] } },
  async handler(input, ctx) {
    const loaded = await loadProject(ctx, input.projectId);
    const patches = asPatches(input.patches);
    return withEnv(ctx, loaded, async (env) => {
      const result = applyPatches(loaded.project, patches, { validateOptions: validateOptionsOf(env.registry) });
      const inverse = result.inverse.map((p) => ({ ...p }));
      if (!result.ok || input.dryRun === true) return { ok: result.ok, diagnostics: plainDiagnostics(result.diagnostics), inverse, sourceUpdated: false };
      if (isSourceEntry(loaded.entry)) {
        const sources = ctx.services.sources;
        if (sources === undefined) throw new OpenVideoError({ code: 'OV_SOURCE_UNAVAILABLE', errorClass: 'ProjectError', problem: 'TSX write-back is not configured.', suggestions: [] });
        // Atomar (B10): Quelle sichern, zurückschreiben, neu kompilieren; bei Fehlern die alte Quelle wiederherstellen.
        const file = safeJoin(loaded.dir, loaded.entry);
        const original = await readFile(file, 'utf8');
        const restore = async (): Promise<void> => {
          if ((await readFile(file, 'utf8')) !== original) await writeAtomic(file, original);
        };
        let back: Awaited<ReturnType<typeof sources.writeBack>>;
        let recompiled: Loaded;
        try {
          back = await sources.writeBack(loaded.dir, loaded.entry, patches);
          if (back.diagnostics.some((d) => d.severity === 'error')) {
            await restore();
            return { ok: false, diagnostics: plainDiagnostics(back.diagnostics), inverse: [], sourceUpdated: false };
          }
          recompiled = await loadProject(ctx, input.projectId);
        } catch (error) {
          await restore();
          if (!(error instanceof OpenVideoError)) throw error;
          return { ok: false, diagnostics: plainDiagnostics([error.diagnostic]), inverse: [], sourceUpdated: false };
        }
        return { ok: true, diagnostics: plainDiagnostics([...back.diagnostics, ...checkProject(env, recompiled.project).filter((d) => d.severity !== 'info')]), inverse, sourceUpdated: true };
      }
      await ctx.services.workspace.save(input.projectId, result.project);
      return { ok: true, diagnostics: plainDiagnostics(result.diagnostics), inverse, sourceUpdated: false };
    });
  },
});

const assetImport = defineOperation({
  name: 'asset.import',
  summary: 'Import a file, URL or base64 data into the project (content-addressed, normalized).',
  input: Type.Object(
    { projectId: ProjectId, path: Type.Optional(Type.String()), url: Type.Optional(Type.String()), base64: Type.Optional(Type.String()), fileName: Type.Optional(Type.String()), id: Type.Optional(Type.String()), type: Type.Optional(Type.String()) },
    { additionalProperties: false },
  ),
  output: Type.Object({ asset: AnyObject, diagnostics: Diagnostics }),
  example: { input: { projectId: 'launch-video', path: 'assets/logo.svg', id: 'logo' } },
  async handler(input, ctx) {
    const service = ctx.services.assets;
    if (service === undefined) throw new OpenVideoError({ code: 'OV_ASSETS_UNAVAILABLE', errorClass: 'ApiError', problem: 'No asset service is configured.', suggestions: [] });
    const loaded = await loadProject(ctx, input.projectId);
    const imported = await service.import(loaded.dir, input);
    const declared = Array.isArray(loaded.project['assets']) ? loaded.project['assets'].filter(isRecord) : [];
    const exists = declared.some((a) => a['id'] === imported.id);
    const sameFile = declared.filter((a) => a['id'] !== imported.id && a['src'] === imported.src).map((a) => String(a['id']));
    // Ersetzen ist erlaubt, aber nie still (A7): Der Agent sieht eine Warnung.
    const warnings: Diagnostic[] = [
      ...(exists ? [{ code: 'OV_ASSET_REPLACED', severity: 'warning' as const, errorClass: 'AssetError', problem: `Asset "${imported.id}" already existed and was replaced.`, suggestions: ['Pass another "id" to keep both assets.'] }] : []),
      ...(sameFile.length > 0
        ? [{ code: 'OV_ASSET_REPLACED', severity: 'warning' as const, errorClass: 'AssetError', problem: `The file ${imported.src} is also used by asset(s) ${sameFile.join(', ')}; they now show the new content.`, suggestions: ['Pass another "fileName" to keep the old file.'] }]
        : []),
    ];
    const patch: Patch = exists ? { op: 'replaceAsset', assetId: imported.id, src: imported.src, type: imported.type, hash: imported.hash } : { op: 'addAsset', asset: { id: imported.id, type: imported.type, src: imported.src, hash: imported.hash } };
    const result = applyPatches(loaded.project, [patch]);
    if (!result.ok) return { asset: { ...imported }, diagnostics: plainDiagnostics(result.diagnostics) };
    await ctx.services.workspace.save(input.projectId, result.project);
    return { asset: { id: imported.id, type: imported.type, src: imported.src, hash: imported.hash, metadata: imported.metadata }, diagnostics: plainDiagnostics([...imported.diagnostics, ...warnings]) };
  },
});

const assetInspect = defineOperation({
  name: 'asset.inspect',
  summary: 'Return metadata of an asset (dimensions, duration, codec, color space, license).',
  input: Type.Object({ projectId: ProjectId, assetId: Type.String() }, { additionalProperties: false }),
  output: AnyObject,
  example: { input: { projectId: 'launch-video', assetId: 'logo' } },
  async handler(input, ctx) {
    const service = ctx.services.assets;
    if (service === undefined) throw new OpenVideoError({ code: 'OV_ASSETS_UNAVAILABLE', errorClass: 'ApiError', problem: 'No asset service is configured.', suggestions: [] });
    const loaded = await loadProject(ctx, input.projectId);
    return { ...(await service.inspect(loaded.dir, loaded.project, input.assetId)) };
  },
});

const frameRender = defineOperation({
  name: 'frame.render',
  summary: 'Render one frame to PNG; returns the image, diagnostics and the frame cache key.',
  input: Type.Object({ projectId: ProjectId, compositionId: CompositionId, frame: FrameRef, scale: Type.Optional(Type.Number({ exclusiveMinimum: 0, maximum: 4 })), debug: Type.Optional(DebugSchema), inline: Type.Optional(Type.Boolean()) }, { additionalProperties: false }),
  output: Type.Object({ image: ImageResult, key: Type.String(), cached: Type.Boolean(), diagnostics: Diagnostics }),
  example: { input: { projectId: 'launch-video', frame: '2s', scale: 0.5, debug: { showBounds: true } } },
  async handler(input, ctx) {
    const loaded = await loadProject(ctx, input.projectId);
    const comp = findComposition(loaded.project, input.compositionId);
    const scale = input.scale ?? 1;
    assertImageSize(Number(comp['width']) * scale, Number(comp['height']) * scale, 'frame.render');
    const frame = frameOf(loaded.project, input.compositionId, input.frame);
    return withEnv(ctx, loaded, async (env) => {
      assertRenderable(ctx, loaded.project, env.registry, [{ compositionId: input.compositionId, frame }]);
      const r = await renderFrame(env, loaded.project, { ...(input.compositionId !== undefined ? { compositionId: input.compositionId } : {}), frame, scale, ...(input.debug !== undefined ? { debug: input.debug } : {}) });
      // Der Name kommt aus geprüften Teilen; Varianten (scale, debug) bekommen einen eigenen Hash (B4, B16).
      const variant = input.scale !== undefined || input.debug !== undefined ? `-${shortHash({ scale: input.scale, debug: input.debug })}` : '';
      const image = await imageOutput(ctx, input.projectId, `${fileSafe(r.scene.compositionId)}-${String(frame)}${variant}.png`, ctx.services.encodePng(r.image), r.image, input.inline !== false);
      return { image, key: r.key, cached: r.cached, diagnostics: plainDiagnostics(r.diagnostics) };
    });
  },
});

const frameInspect = defineOperation({
  name: 'frame.inspect',
  summary: 'Scene tree with bounds, text layout and diagnostics for one frame (no pixels).',
  input: Type.Object({ projectId: ProjectId, compositionId: CompositionId, frame: FrameRef }, { additionalProperties: false }),
  output: Type.Object({ frame: Type.Number(), tree: Type.Array(AnyObject), diagnostics: Diagnostics, description: Type.String() }),
  example: { input: { projectId: 'launch-video', frame: 90 } },
  async handler(input, ctx) {
    const loaded = await loadProject(ctx, input.projectId);
    const frame = frameOf(loaded.project, input.compositionId, input.frame);
    return withEnv(ctx, loaded, (env) => {
      const scene = evaluateScene(loaded.project, input.compositionId, frame, { registry: env.registry });
      const bounds = computeBounds(scene, env.measurer);
      return Promise.resolve({ frame, tree: sceneTree(scene, bounds).map((n) => ({ ...n })), diagnostics: plainDiagnostics([...scene.diagnostics, ...analyzeScene(scene, bounds)]), description: describeScene(scene, bounds) });
    });
  },
});

/** Frames eines Kontaktbogens: im Bereich der Composition und ohne Doppelte (B11). */
function previewFrames(input: { projectId: string; compositionId?: string | undefined; frames?: readonly (number | string)[] | undefined; count?: number | undefined }, project: Readonly<Record<string, unknown>>): number[] {
  const comp = findComposition(project, input.compositionId);
  const total = compositionDurationFrames(comp);
  if (input.frames !== undefined) {
    const frames = input.frames.map((f) => frameOf(project, input.compositionId, f));
    const outside = frames.find((f) => f < 0 || f >= total);
    if (outside !== undefined) throw rangeError(`Frame ${String(outside)} is outside the composition (0–${String(total - 1)}).`);
    return [...new Set(frames)];
  }
  const count = Math.max(1, Math.min(64, input.count ?? 8));
  return sampleFrames(0, total, count);
}

const previewContactSheet = defineOperation({
  name: 'preview.contactSheet',
  summary: 'Render several frames into one labeled contact sheet image.',
  input: Type.Object(
    { projectId: ProjectId, compositionId: CompositionId, frames: Type.Optional(Type.Array(FrameRef, { minItems: 1, maxItems: 64 })), count: Type.Optional(Type.Integer({ minimum: 1, maximum: 64 })), columns: Type.Optional(Type.Integer({ minimum: 1, maximum: 8 })), cellWidth: Type.Optional(Type.Integer({ minimum: 64, maximum: 1920 })), inline: Type.Optional(Type.Boolean()) },
    { additionalProperties: false },
  ),
  output: Type.Object({ image: ImageResult, frames: Type.Array(Type.Number()), diagnostics: Diagnostics }),
  example: { input: { projectId: 'launch-video', frames: [0, 90, 180, 360] } },
  async handler(input, ctx) {
    const loaded = await loadProject(ctx, input.projectId);
    const frames = previewFrames(input, loaded.project);
    const comp = findComposition(loaded.project, input.compositionId);
    const cellWidth = input.cellWidth ?? 480;
    const scale = cellWidth / Number(comp['width']);
    const columns = input.columns ?? Math.min(4, frames.length);
    assertImageSize(cellWidth * Math.min(columns, frames.length), Number(comp['height']) * scale * Math.ceil(frames.length / columns), 'preview.contactSheet');
    const fps = Number(comp['fps']);
    return withEnv(ctx, loaded, async (env) => {
      assertRenderable(ctx, loaded.project, env.registry, frames.map((frame) => ({ compositionId: input.compositionId, frame })));
      const overlays = env.overlays;
      if (overlays === undefined) throw new OpenVideoError({ code: 'OV_BACKEND_MISSING', errorClass: 'RendererError', problem: 'Contact sheets need the Skia backend.', suggestions: ['Run `openvideo doctor`.'] });
      const diagnostics: Diagnostic[] = [];
      const cells = [];
      for (const f of frames) {
        const r = await renderFrame(env, loaded.project, { ...(input.compositionId !== undefined ? { compositionId: input.compositionId } : {}), frame: f, scale });
        diagnostics.push(...r.diagnostics.filter((d) => d.severity !== 'info'));
        cells.push({ image: r.image, label: `#${String(f)} · ${(f / fps).toFixed(2)}s` });
      }
      const sheet = overlays.contactSheet(cells, { columns, cellWidth, background: '#1B1D24' });
      const name = `contact-sheet-${fileSafe(String(comp['id']))}-${shortHash({ frames, columns, cellWidth })}.png`;
      const image = await imageOutput(ctx, input.projectId, name, ctx.services.encodePng(sheet), sheet, input.inline !== false);
      return { image, frames, diagnostics: plainDiagnostics(diagnostics) };
    });
  },
});

/** Prüft Grenzen (B9) und Skripte (B5) eines Render-Jobs, bevor er startet. */
async function checkVideoJob(ctx: OperationContext, loaded: Loaded, comp: Readonly<Record<string, unknown>>, profile: OutputProfile, range: { start: number; end: number }, what: string): Promise<void> {
  const cw = Number(comp['width']);
  const ch = Number(comp['height']);
  const cfps = Number(comp['fps']);
  const width = profile.width ?? (profile.height !== undefined ? Math.round((profile.height * cw) / ch) : cw);
  const height = profile.height ?? Math.round((width * ch) / cw);
  assertImageSize(width, Math.max(height, (ch * width) / cw), what);
  const fps = profile.fps ?? cfps;
  assertFps(fps, what);
  assertFrameCount(Math.ceil(((range.end - range.start) * fps) / cfps), what);
  await withEnv(ctx, loaded, (env) => {
    const id = typeof comp['id'] === 'string' ? comp['id'] : undefined;
    assertRenderable(ctx, loaded.project, env.registry, sampleFrames(range.start, range.end, 16).map((frame) => ({ compositionId: id, frame })));
    return Promise.resolve();
  });
}

function startVideoJob(ctx: OperationContext, projectId: string, kind: string, loaded: Loaded, options: { compositionId?: string | undefined; profile: OutputProfile; outName: string; range?: { start: number; end: number } }): string {
  return ctx.services.jobs.start(
    kind,
    projectId,
    (control) =>
      withEnv(ctx, loaded, async (env) => {
      const outDir = await ctx.services.workspace.outDir(projectId);
      const runChunks = ctx.services.chunkRunner?.(env, loaded.project);
      const r = await renderVideo(env, loaded.project, {
        ...(options.compositionId !== undefined ? { compositionId: options.compositionId } : {}),
        outPath: safeJoin(outDir, options.outName),
        profile: options.profile,
        ...(options.range !== undefined ? { range: options.range } : {}),
        ...(runChunks !== undefined ? { runChunks } : {}),
        signal: control.signal,
        onProgress: (p) => {
          control.progress(p.stage, p.done, p.total);
        },
      });
      return {
        outputs: r.outputs.map((o) => ({ file: o, url: `/v1/files/${projectId}/${relative(ctx.services.workspace.projectDir(projectId), o)}` })),
        manifest: r.manifestPath,
        frames: r.manifest.frames.count,
        framesRendered: r.manifest.cache.framesRendered,
        framesFromCache: r.manifest.cache.framesFromCache,
        warnings: r.manifest.diagnostics.warnings,
      };
    }),
    ctx.traceparent,
  );
}

const previewRender = defineOperation({
  name: 'preview.render',
  summary: 'Render a low-resolution preview video (job).',
  input: Type.Object({ projectId: ProjectId, compositionId: CompositionId, scale: Type.Optional(Type.Number({ exclusiveMinimum: 0, maximum: 1 })), start: Type.Optional(FrameRef), end: Type.Optional(FrameRef) }, { additionalProperties: false }),
  output: JobResult,
  job: true,
  example: { input: { projectId: 'launch-video', scale: 0.25 } },
  async handler(input, ctx) {
    const loaded = await loadProject(ctx, input.projectId);
    const comp = findComposition(loaded.project, input.compositionId);
    const width = Math.max(2, Math.round((Number(comp['width']) * (input.scale ?? 0.25)) / 2) * 2);
    const total = compositionDurationFrames(comp);
    const start = input.start !== undefined ? frameOf(loaded.project, input.compositionId, input.start) : 0;
    const end = input.end !== undefined ? frameOf(loaded.project, input.compositionId, input.end) : total;
    if (start < 0 || end > total || start >= end) throw rangeError(`The range ${String(start)}–${String(end)} is empty or outside the composition (0–${String(total)}).`);
    const profile: OutputProfile = { format: 'mp4', codec: 'h264', width, quality: 60 };
    await checkVideoJob(ctx, loaded, comp, profile, { start, end }, 'preview.render');
    // Die Standard-Vorschau heißt preview-<id>.mp4; jede andere Variante (Bereich, Breite) bekommt eine eigene Datei (B16).
    const standard = start === 0 && end === total && (input.scale ?? 0.25) === 0.25;
    const outName = `preview-${fileSafe(String(comp['id']))}${standard ? '' : `-${String(start)}-${String(end)}-w${String(width)}`}.mp4`;
    const jobId = startVideoJob(ctx, input.projectId, 'preview.render', loaded, { compositionId: input.compositionId, profile, outName, range: { start, end } });
    return { jobId, state: ctx.services.jobs.status(jobId).state };
  },
});

const videoRender = defineOperation({
  name: 'video.render',
  summary: 'Render the final video with a render profile (job); writes a render manifest.',
  input: Type.Object(
    {
      projectId: ProjectId,
      compositionId: CompositionId,
      profileId: Type.Optional(Type.String()),
      profile: Type.Optional(AnyObject),
      outName: Type.Optional(Type.String({ pattern: '^(?!\\.)[A-Za-z0-9._-]{1,128}$', description: 'File name in out/; must not start with ".".' })),
    },
    { additionalProperties: false },
  ),
  output: JobResult,
  job: true,
  example: { input: { projectId: 'launch-video', profile: { format: 'mp4', codec: 'h264', width: 3840 } } },
  async handler(input, ctx) {
    const loaded = await loadProject(ctx, input.projectId);
    const fromId = input.profileId !== undefined ? profileById(loaded.project, input.profileId) : undefined;
    if (input.profileId !== undefined && fromId === undefined) throw new OpenVideoError({ code: 'OV_PROFILE_UNKNOWN', errorClass: 'ApiError', problem: `Render profile "${input.profileId}" does not exist.`, suggestions: ['Add it to project.renderProfiles, or pass `profile` inline.'] });
    const inline = input.profile;
    const profile: OutputProfile = fromId !== undefined ? { ...fromId, format: outputFormat(fromId.format) } : {
      format: outputFormat(inline?.['format'] ?? 'mp4'),
      ...(typeof inline?.['codec'] === 'string' ? { codec: inline['codec'] } : { codec: 'h264' }),
      ...(typeof inline?.['width'] === 'number' ? { width: inline['width'] } : {}),
      ...(typeof inline?.['height'] === 'number' ? { height: inline['height'] } : {}),
      ...(typeof inline?.['fps'] === 'number' ? { fps: inline['fps'] } : {}),
      ...(typeof inline?.['quality'] === 'number' ? { quality: inline['quality'] } : {}),
      ...(typeof inline?.['alpha'] === 'boolean' ? { alpha: inline['alpha'] } : {}),
    };
    const comp = findComposition(loaded.project, input.compositionId);
    await checkVideoJob(ctx, loaded, comp, profile, { start: 0, end: compositionDurationFrames(comp) }, 'video.render');
    const ext = profile.format.endsWith('-sequence') ? '' : `.${profile.format}`;
    const jobId = startVideoJob(ctx, input.projectId, 'video.render', loaded, { compositionId: input.compositionId, profile, outName: input.outName ?? `${fileSafe(String(comp['id']))}${ext}` });
    return { jobId, state: ctx.services.jobs.status(jobId).state };
  },
});

const renderStatus = defineOperation({
  name: 'render.status',
  summary: 'Status, progress and result of a render job.',
  input: Type.Object({ jobId: Type.String() }, { additionalProperties: false }),
  output: AnyObject,
  example: { input: { jobId: 'job-…' } },
  handler(input, ctx) {
    return Promise.resolve({ ...ctx.services.jobs.status(input.jobId) });
  },
});

const renderCancel = defineOperation({
  name: 'render.cancel',
  summary: 'Cancel a queued or running render job.',
  input: Type.Object({ jobId: Type.String() }, { additionalProperties: false }),
  output: AnyObject,
  example: { input: { jobId: 'job-…' } },
  handler(input, ctx) {
    return Promise.resolve({ ...ctx.services.jobs.cancel(input.jobId) });
  },
});

const diagnosticsGet = defineOperation({
  name: 'diagnostics.get',
  summary: 'All diagnostics: validation, backend checks, and (with frame) scene diagnostics.',
  input: Type.Object({ projectId: ProjectId, compositionId: CompositionId, frame: Type.Optional(FrameRef) }, { additionalProperties: false }),
  output: Type.Object({ diagnostics: Diagnostics, text: Type.String() }),
  example: { input: { projectId: 'launch-video', frame: 120 } },
  async handler(input, ctx) {
    const loaded = await loadProject(ctx, input.projectId);
    const list = await withEnv(ctx, loaded, (env) => {
      const out: Diagnostic[] = [...checkProject(env, loaded.project)];
      if (input.frame !== undefined && out.every((d) => d.severity !== 'error')) {
        const scene = evaluateScene(loaded.project, input.compositionId, frameOf(loaded.project, input.compositionId, input.frame), { registry: env.registry });
        out.push(...scene.diagnostics, ...analyzeScene(scene, computeBounds(scene, env.measurer)));
      }
      return Promise.resolve(out);
    });
    return { diagnostics: plainDiagnostics(list), text: list.map(formatDiagnostic).join('\n\n') };
  },
});

const fontsList = defineOperation({
  name: 'fonts.list',
  summary: 'List the fonts available to a project (bundled defaults plus project fonts).',
  input: Type.Object({ projectId: Type.Optional(ProjectId) }, { additionalProperties: false }),
  output: Type.Object({ fonts: Type.Array(AnyObject) }),
  example: { input: { projectId: 'launch-video' } },
  async handler(input, ctx) {
    const project: Record<string, unknown> = input.projectId !== undefined ? (await loadProject(ctx, input.projectId)).project : { schemaVersion: SCHEMA_VERSION, compositions: [] };
    const dir = input.projectId !== undefined ? ctx.services.workspace.projectDir(input.projectId) : ctx.services.workspace.root;
    const fonts = await ctx.services.withEnvironment(dir, project, (env) => Promise.resolve(env.fonts.all().map((f) => ({ family: f.family, weight: f.weight, style: f.style, variable: f.variable, hash: f.hash }))));
    return { fonts };
  },
});

const templatesList = defineOperation({
  name: 'templates.list',
  summary: 'List available templates.',
  input: Type.Object({}, { additionalProperties: false }),
  output: Type.Object({ templates: Type.Array(AnyObject) }),
  example: { input: {} },
  handler(_input, ctx) {
    return Promise.resolve({ templates: (ctx.services.templates?.list() ?? []).map((t) => ({ ...t })) });
  },
});

const templatesInspect = defineOperation({
  name: 'templates.inspect',
  summary: 'Return the source files and IR of a template.',
  input: Type.Object({ name: Type.String() }, { additionalProperties: false }),
  output: Type.Object({ info: AnyObject, files: Type.Record(Type.String(), Type.String()), project: AnyObject }),
  example: { input: { name: 'product-launch' } },
  async handler(input, ctx) {
    const catalog = ctx.services.templates;
    if (catalog === undefined) throw new OpenVideoError({ code: 'OV_TEMPLATES_UNAVAILABLE', errorClass: 'ApiError', problem: 'No template catalog is configured.', suggestions: [] });
    const t = await catalog.get(input.name);
    return { info: { ...t.info }, files: { ...t.files }, project: { ...t.project } };
  },
});

const sceneDescribe = defineOperation({
  name: 'scene.describe',
  summary: 'Describe a frame in plain sentences (nodes, positions, text).',
  input: Type.Object({ projectId: ProjectId, compositionId: CompositionId, frame: FrameRef }, { additionalProperties: false }),
  output: Type.Object({ description: Type.String() }),
  example: { input: { projectId: 'launch-video', frame: '4s' } },
  async handler(input, ctx) {
    const r = await frameInspect.handler(input, ctx);
    return { description: r.description };
  },
});

const sceneTreeOp = defineOperation({
  name: 'scene.tree',
  summary: 'Scene tree of a frame with bounds and opacity.',
  input: Type.Object({ projectId: ProjectId, compositionId: CompositionId, frame: FrameRef }, { additionalProperties: false }),
  output: Type.Object({ tree: Type.Array(AnyObject) }),
  example: { input: { projectId: 'launch-video', frame: 0 } },
  async handler(input, ctx) {
    const r = await frameInspect.handler(input, ctx);
    return { tree: r.tree };
  },
});

const timelineInspect = defineOperation({
  name: 'timeline.inspect',
  summary: 'Timing windows, animated properties, keyframe times, markers and tracks.',
  input: Type.Object({ projectId: ProjectId, compositionId: CompositionId }, { additionalProperties: false }),
  output: AnyObject,
  example: { input: { projectId: 'launch-video' } },
  async handler(input, ctx) {
    const loaded = await loadProject(ctx, input.projectId);
    return { ...inspectTimeline(loaded.project, input.compositionId) };
  },
});

const benchmarkRun = defineOperation({
  name: 'benchmark.run',
  summary: 'Run a reproducible benchmark scenario and return the measurements.',
  input: Type.Object({ scenario: Type.Optional(Type.String()), resolution: Type.Optional(Type.String()), frames: Type.Optional(Type.Integer({ minimum: 1, maximum: 3600 })) }, { additionalProperties: false }),
  output: AnyObject,
  example: { input: { scenario: 'text-heavy', resolution: '1080p30', frames: 60 } },
  async handler(input, ctx) {
    const bench = ctx.services.benchmark;
    if (bench === undefined) throw new OpenVideoError({ code: 'OV_BENCHMARK_UNAVAILABLE', errorClass: 'ApiError', problem: 'Benchmarks are not configured in this host.', suggestions: ['Use `openvideo benchmark` in the CLI.'] });
    const r = await bench(input);
    return isRecord(r) ? { ...r } : { result: r };
  },
});

/** Alle Operationen nach Namen (FR-21). */
export const OPERATIONS: ReadonlyMap<string, OperationDefinition> = new Map<string, OperationDefinition>(
  [
    projectCreate,
    projectInspect,
    projectUpdate,
    compositionCreate,
    compositionGet,
    compositionValidate,
    compositionPatch,
    assetImport,
    assetInspect,
    frameRender,
    frameInspect,
    previewRender,
    previewContactSheet,
    videoRender,
    renderStatus,
    renderCancel,
    diagnosticsGet,
    fontsList,
    templatesList,
    templatesInspect,
    sceneDescribe,
    sceneTreeOp,
    timelineInspect,
    benchmarkRun,
  ].map((op): [string, OperationDefinition] => [op.name, op]),
);

/**
 * Liest eine Datei eines Projekts (für `/v1/files`). Symlinks aus dem Projekt heraus werden abgelehnt;
 * Fehler nennen keinen Host-Pfad (B3).
 *
 * @example
 * ```ts
 * const bytes = await readProjectFile(ctx, 'demo', 'out/frames/main-0.png');
 * ```
 */
export async function readProjectFile(ctx: OperationContext, projectId: string, path: string): Promise<Uint8Array> {
  const file = await safeRealPath(ctx.services.workspace.projectDir(projectId), path);
  try {
    return await readFile(file);
  } catch (error) {
    if (error instanceof Error && 'code' in error) {
      throw new OpenVideoError({ code: 'OV_FILE_NOT_FOUND', errorClass: 'ApiError', problem: `File "${path}" cannot be read.`, suggestions: ['Use the url returned by the operation.'] });
    }
    throw error;
  }
}
