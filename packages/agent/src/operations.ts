/**
 * Die Operationen der Agent API (FR-21, Auftrag A5).
 */
import { join, relative } from 'node:path';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import Type from 'typebox';
import {
  OpenVideoError,
  SCHEMA_VERSION,
  applyPatches,
  compositionDurationFrames,
  findComposition,
  formatDiagnostic,
  isRecord,
  resolveMarkers,
  toFrames,
  type Diagnostic,
  type Patch,
} from '@agentic-video/core';
import { checkProject, describeScene, inspectTimeline, profileById, renderFrame, renderVideo, sceneTree, type OutputProfile } from '@agentic-video/render';
import { defineOperation, type OperationContext, type OperationDefinition } from './operation.js';
import { readProjectConfig } from './workspace.js';

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

const SCRIPT_PATTERN = /<script\b|\son[a-z]+\s*=|javascript:/iu;

/** Findet HTML-Inhalte mit Skripten (nicht vertrauenswürdiger Code, ADR 0008). */
export function containsScripts(project: Readonly<Record<string, unknown>>): string[] {
  const hits: string[] = [];
  const visit = (value: unknown): void => {
    if (Array.isArray(value)) value.forEach(visit);
    else if (isRecord(value)) {
      if (value['type'] === 'html' && typeof value['html'] === 'string' && SCRIPT_PATTERN.test(value['html'])) hits.push(String(value['id']));
      for (const v of Object.values(value)) visit(v);
    }
  };
  visit(project['compositions']);
  return hits;
}

async function loadProject(ctx: OperationContext, projectId: string): Promise<Loaded> {
  const dir = ctx.services.workspace.projectDir(projectId);
  const config = await readProjectConfig(dir);
  if (config.entry.endsWith('.tsx')) {
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

function assertRenderable(ctx: OperationContext, project: Readonly<Record<string, unknown>>): void {
  if (ctx.services.isolation !== 'container') return;
  const scripted = containsScripts(project);
  if (scripted.length > 0) {
    throw new OpenVideoError({
      code: 'OV_SANDBOX_REQUIRED',
      errorClass: 'SecurityError',
      problem: `HTML nodes with scripts (${scripted.join(', ')}) may only render inside a container worker.`,
      suggestions: ['Render through a container worker (`openvideo worker` / Docker).', 'Remove scripts from the HTML (CSS animations are fine).', 'For your own trusted project, use the CLI with --trusted.'],
    });
  }
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
  const file = join(dir, name);
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
    const loaded = await loadProject(ctx, id);
    const env = await ctx.services.environment(loaded.dir, loaded.project);
    const diagnostics = checkProject(env, loaded.project);
    const comps = Array.isArray(loaded.project['compositions']) ? loaded.project['compositions'].filter(isRecord).map((c) => String(c['id'])) : [];
    return { projectId: id, compositions: comps, diagnostics: plainDiagnostics(diagnostics) };
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
      kind: loaded.entry.endsWith('.tsx') ? 'tsx' : 'json',
      schemaVersion: p['schemaVersion'],
      metadata: p['metadata'] ?? {},
      compositions: comps.map((c) => ({ id: c['id'], width: c['width'], height: c['height'], fps: c['fps'], durationFrames: compositionDurationFrames(c), nodes: Array.isArray(c['nodes']) ? c['nodes'].length : 0, tracks: Array.isArray(c['tracks']) ? c['tracks'].length : 0 })),
      assets: p['assets'] ?? [],
      fonts: p['fonts'] ?? [],
      renderProfiles: p['renderProfiles'] ?? [],
    };
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
    const existing: unknown = loaded.project['compositions'];
    const comps: unknown[] = Array.isArray(existing) ? Array.from<unknown>(existing) : [];
    const result = applyPatches(loaded.project, [{ op: 'setProjectProperty', property: 'compositions', value: [...comps, input.composition] }]);
    if (!result.ok) return { ok: false, compositionId: String(input.composition['id']), diagnostics: plainDiagnostics(result.diagnostics) };
    await ctx.services.workspace.save(input.projectId, result.project);
    return { ok: true, compositionId: String(input.composition['id']), diagnostics: plainDiagnostics(result.diagnostics) };
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
    const env = await ctx.services.environment(loaded.dir, loaded.project);
    const all = checkProject(env, loaded.project).filter((d) => input.compositionId === undefined || d.compositionId === undefined || d.compositionId === input.compositionId || d.path?.startsWith(`composition.${input.compositionId}`) === true);
    return { ok: all.every((d) => d.severity !== 'error'), diagnostics: plainDiagnostics(all), text: all.map(formatDiagnostic).join('\n\n') };
  },
});

const PatchSchema = Type.Record(Type.String(), Type.Unknown(), { description: 'A patch object with "op": setProperty | addNode | removeNode | moveNode | addKeyframe | removeKeyframe | replaceAsset | addAsset | removeAsset | setCompositionProperty | setProjectProperty' });

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
  const index = typeof p['index'] === 'number' ? { index: p['index'] } : {};
  switch (p['op']) {
    case 'setProperty':
      return { op: 'setProperty', nodeId: str('nodeId'), property: str('property'), value: p['value'], ...withComp };
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
      return { op: 'setCompositionProperty', compositionId: str('compositionId'), property: str('property'), value: p['value'] };
    case 'setProjectProperty':
      return { op: 'setProjectProperty', property: str('property'), value: p['value'] };
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
    const env = await ctx.services.environment(loaded.dir, loaded.project);
    const components = [...env.registry.components.keys()];
    const result = applyPatches(loaded.project, patches, { validateOptions: { extraNodeSchemas: env.registry.extraNodeSchemas(), ...(components.length > 0 ? { components } : {}) } });
    const inverse = result.inverse.map((p) => ({ ...p }));
    if (!result.ok || input.dryRun === true) return { ok: result.ok, diagnostics: plainDiagnostics(result.diagnostics), inverse, sourceUpdated: false };
    if (loaded.entry.endsWith('.tsx')) {
      const sources = ctx.services.sources;
      if (sources === undefined) throw new OpenVideoError({ code: 'OV_SOURCE_UNAVAILABLE', errorClass: 'ProjectError', problem: 'TSX write-back is not configured.', suggestions: [] });
      const back = await sources.writeBack(loaded.dir, loaded.entry, patches);
      if (back.diagnostics.some((d) => d.severity === 'error')) return { ok: false, diagnostics: plainDiagnostics(back.diagnostics), inverse: [], sourceUpdated: false };
      const recompiled = await loadProject(ctx, input.projectId);
      return { ok: true, diagnostics: plainDiagnostics([...back.diagnostics, ...checkProject(env, recompiled.project).filter((d) => d.severity !== 'info')]), inverse, sourceUpdated: true };
    }
    await ctx.services.workspace.save(input.projectId, result.project);
    return { ok: true, diagnostics: plainDiagnostics(result.diagnostics), inverse, sourceUpdated: false };
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
    const exists = Array.isArray(loaded.project['assets']) && loaded.project['assets'].filter(isRecord).some((a) => a['id'] === imported.id);
    const patch: Patch = exists ? { op: 'replaceAsset', assetId: imported.id, src: imported.src, type: imported.type, hash: imported.hash } : { op: 'addAsset', asset: { id: imported.id, type: imported.type, src: imported.src, hash: imported.hash } };
    const result = applyPatches(loaded.project, [patch]);
    if (!result.ok) return { asset: { ...imported }, diagnostics: plainDiagnostics(result.diagnostics) };
    await ctx.services.workspace.save(input.projectId, result.project);
    return { asset: { id: imported.id, type: imported.type, src: imported.src, hash: imported.hash, metadata: imported.metadata }, diagnostics: plainDiagnostics(imported.diagnostics) };
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
    assertRenderable(ctx, loaded.project);
    const env = await ctx.services.environment(loaded.dir, loaded.project);
    const frame = frameOf(loaded.project, input.compositionId, input.frame);
    const r = await renderFrame(env, loaded.project, { ...(input.compositionId !== undefined ? { compositionId: input.compositionId } : {}), frame, scale: input.scale ?? 1, ...(input.debug !== undefined ? { debug: input.debug } : {}) });
    const image = await imageOutput(ctx, input.projectId, `${r.scene.compositionId}-${String(frame)}${input.scale !== undefined ? `-x${String(input.scale)}` : ''}.png`, ctx.services.encodePng(r.image), r.image, input.inline !== false);
    return { image, key: r.key, cached: r.cached, diagnostics: plainDiagnostics(r.diagnostics) };
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
    const env = await ctx.services.environment(loaded.dir, loaded.project);
    const { evaluateScene, computeBounds, analyzeScene } = await import('@agentic-video/core');
    const frame = frameOf(loaded.project, input.compositionId, input.frame);
    const scene = evaluateScene(loaded.project, input.compositionId, frame, { registry: env.registry });
    const bounds = computeBounds(scene, env.measurer);
    return { frame, tree: sceneTree(scene, bounds).map((n) => ({ ...n })), diagnostics: plainDiagnostics([...scene.diagnostics, ...analyzeScene(scene, bounds)]), description: describeScene(scene, bounds) };
  },
});

async function previewFrames(input: { projectId: string; compositionId?: string | undefined; frames?: readonly (number | string)[] | undefined; count?: number | undefined }, project: Readonly<Record<string, unknown>>): Promise<number[]> {
  if (input.frames !== undefined) return input.frames.map((f) => frameOf(project, input.compositionId, f));
  const comp = findComposition(project, input.compositionId);
  const total = compositionDurationFrames(comp);
  const count = Math.max(1, Math.min(64, input.count ?? 8));
  return Promise.resolve(Array.from({ length: count }, (_, i) => Math.min(total - 1, Math.round((i * (total - 1)) / Math.max(1, count - 1)))));
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
    assertRenderable(ctx, loaded.project);
    const env = await ctx.services.environment(loaded.dir, loaded.project);
    const overlays = env.overlays;
    if (overlays === undefined) throw new OpenVideoError({ code: 'OV_BACKEND_MISSING', errorClass: 'RendererError', problem: 'Contact sheets need the Skia backend.', suggestions: ['Run `openvideo doctor`.'] });
    const frames = await previewFrames(input, loaded.project);
    const comp = findComposition(loaded.project, input.compositionId);
    const cellWidth = input.cellWidth ?? 480;
    const scale = cellWidth / Number(comp['width']);
    const fps = Number(comp['fps']);
    const diagnostics: Diagnostic[] = [];
    const cells = [];
    for (const f of frames) {
      const r = await renderFrame(env, loaded.project, { ...(input.compositionId !== undefined ? { compositionId: input.compositionId } : {}), frame: f, scale });
      diagnostics.push(...r.diagnostics.filter((d) => d.severity !== 'info'));
      cells.push({ image: r.image, label: `#${String(f)} · ${(f / fps).toFixed(2)}s` });
    }
    const sheet = overlays.contactSheet(cells, { columns: input.columns ?? Math.min(4, frames.length), cellWidth, background: '#1B1D24' });
    const image = await imageOutput(ctx, input.projectId, `contact-sheet-${frames.join('-').slice(0, 60)}.png`, ctx.services.encodePng(sheet), sheet, input.inline !== false);
    return { image, frames, diagnostics: plainDiagnostics(diagnostics) };
  },
});

function startVideoJob(ctx: OperationContext, projectId: string, kind: string, loaded: Loaded, options: { compositionId?: string | undefined; profile: OutputProfile; outName: string; range?: { start: number; end: number } }): string {
  return ctx.services.jobs.start(
    kind,
    projectId,
    async (control) => {
      const env = await ctx.services.environment(loaded.dir, loaded.project);
      const outDir = await ctx.services.workspace.outDir(projectId);
      const runChunks = ctx.services.chunkRunner?.(env, loaded.project);
      const r = await renderVideo(env, loaded.project, {
        ...(options.compositionId !== undefined ? { compositionId: options.compositionId } : {}),
        outPath: join(outDir, options.outName),
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
    },
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
    assertRenderable(ctx, loaded.project);
    const comp = findComposition(loaded.project, input.compositionId);
    const width = Math.max(2, Math.round((Number(comp['width']) * (input.scale ?? 0.25)) / 2) * 2);
    const start = input.start !== undefined ? frameOf(loaded.project, input.compositionId, input.start) : 0;
    const end = input.end !== undefined ? frameOf(loaded.project, input.compositionId, input.end) : compositionDurationFrames(comp);
    const jobId = startVideoJob(ctx, input.projectId, 'preview.render', loaded, { compositionId: input.compositionId, profile: { format: 'mp4', codec: 'h264', width, quality: 60 }, outName: `preview-${String(comp['id'])}.mp4`, range: { start, end } });
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
      outName: Type.Optional(Type.String({ pattern: '^[A-Za-z0-9._-]+$' })),
    },
    { additionalProperties: false },
  ),
  output: JobResult,
  job: true,
  example: { input: { projectId: 'launch-video', profile: { format: 'mp4', codec: 'h264', width: 3840 } } },
  async handler(input, ctx) {
    const loaded = await loadProject(ctx, input.projectId);
    assertRenderable(ctx, loaded.project);
    const fromId = input.profileId !== undefined ? profileById(loaded.project, input.profileId) : undefined;
    if (input.profileId !== undefined && fromId === undefined) throw new OpenVideoError({ code: 'OV_PROFILE_UNKNOWN', errorClass: 'ApiError', problem: `Render profile "${input.profileId}" does not exist.`, suggestions: ['Add it to project.renderProfiles, or pass `profile` inline.'] });
    const inline = input.profile;
    const profile: OutputProfile = fromId ?? {
      format: typeof inline?.['format'] === 'string' ? inline['format'] : 'mp4',
      ...(typeof inline?.['codec'] === 'string' ? { codec: inline['codec'] } : { codec: 'h264' }),
      ...(typeof inline?.['width'] === 'number' ? { width: inline['width'] } : {}),
      ...(typeof inline?.['height'] === 'number' ? { height: inline['height'] } : {}),
      ...(typeof inline?.['fps'] === 'number' ? { fps: inline['fps'] } : {}),
      ...(typeof inline?.['quality'] === 'number' ? { quality: inline['quality'] } : {}),
      ...(typeof inline?.['alpha'] === 'boolean' ? { alpha: inline['alpha'] } : {}),
    };
    const comp = findComposition(loaded.project, input.compositionId);
    const ext = profile.format.endsWith('-sequence') ? '' : `.${profile.format}`;
    const jobId = startVideoJob(ctx, input.projectId, 'video.render', loaded, { compositionId: input.compositionId, profile, outName: input.outName ?? `${String(comp['id'])}${ext}` });
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
    const env = await ctx.services.environment(loaded.dir, loaded.project);
    const list: Diagnostic[] = [...checkProject(env, loaded.project)];
    if (input.frame !== undefined && list.every((d) => d.severity !== 'error')) {
      const { evaluateScene, computeBounds, analyzeScene } = await import('@agentic-video/core');
      const scene = evaluateScene(loaded.project, input.compositionId, frameOf(loaded.project, input.compositionId, input.frame), { registry: env.registry });
      list.push(...scene.diagnostics, ...analyzeScene(scene, computeBounds(scene, env.measurer)));
    }
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
    const env = await ctx.services.environment(dir, project);
    return { fonts: env.fonts.all().map((f) => ({ family: f.family, weight: f.weight, style: f.style, variable: f.variable, hash: f.hash })) };
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

/** Liest eine Datei eines Projekts (für `/v1/files`). */
export async function readProjectFile(ctx: OperationContext, projectId: string, path: string): Promise<Uint8Array> {
  const { safeJoin } = await import('./workspace.js');
  return readFile(safeJoin(ctx.services.workspace.projectDir(projectId), path));
}
