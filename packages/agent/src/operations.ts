/**
 * Die Operationen der Agent API (FR-21, Auftrag A5).
 */
import { existsSync } from 'node:fs';
import { readFile, realpath } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve } from 'node:path';
import Type from 'typebox';
import {
  OpenVideoError,
  SCHEMA_VERSION,
  analyzeScene,
  applyPatches,
  compositionDurationFrames,
  computeBounds,
  evaluateScene,
  findComposition,
  formatDiagnostic,
  isRecord,
  validateProject,
  type Diagnostic,
  type Patch,
} from '@agentic-video/core';
import { FrameManifestSchema, buildFrameManifest, checkProject, describeScene, inspectTimeline, profileById, renderFrame, renderVideo, sceneTree, type ManifestFrame, type OutputProfile } from '@agentic-video/render';
import { assertFps, assertFrameCount, assertImageSize, sampleFrames } from './guards.js';
import { describeOperations } from './describe.js';
import { projectImport } from './importing.js';
import { pluginsList } from './plugins.js';
import { assertProjectAccess } from './project-access.js';
import { defineOperation, type OperationContext, type OperationDefinition } from './operation.js';
import { PatchSchema, checkPatchList, toCorePatches } from './patch-schema.js';
import {
  AnyObject,
  CompositionId,
  DebugSchema,
  Diagnostics,
  FrameRef,
  ImageResult,
  JobResult,
  ProjectId,
  assertRenderable,
  errorKey,
  fileSafe,
  frameOf,
  imageOutput,
  loadProject,
  outputFormat,
  plainDiagnostics,
  rangeError,
  shortHash,
  tsxProjectError,
  validateOptionsOf,
  withEnv,
  type Loaded,
} from './shared.js';
import { subtitlesTranscribe } from './transcribe.js';
import { isSourceEntry, readProjectConfig, safeJoin, safeRealPath, writeAtomic } from './workspace.js';

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
      if (catalog === undefined) throw new OpenVideoError({ code: 'OV_TEMPLATES_UNAVAILABLE', errorClass: 'ApiError', problem: 'No template catalog is configured.', suggestions: ['Start the host with the template catalog (openvideo serve/mcp include it).', 'Create the project from JSON with "project" instead of "template".'] });
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

/** Liegt `path` (echter Pfad) in `root` (echter Pfad)? */
function inside(root: string, path: string): boolean {
  const rel = relative(root, path);
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
}

const projectOpen = defineOperation({
  name: 'project.open',
  summary: 'Open an existing project folder (openvideo.json or project.json) inside the allowed project roots and return its projectId.',
  input: Type.Object(
    {
      path: Type.String({ minLength: 1, description: 'Project folder; absolute, or relative to the first allowed root.' }),
      id: Type.Optional(Type.String({ pattern: '^[a-z0-9][a-z0-9-]{0,57}$', description: 'Preferred project id (default: folder name).' })),
    },
    { additionalProperties: false },
  ),
  output: Type.Object({ projectId: Type.String(), name: Type.String(), entry: Type.String(), kind: Type.String(), compositions: Type.Array(Type.String()) }),
  example: { input: { path: 'launch-video' } },
  async handler(input, ctx) {
    const roots = ctx.services.projectRoots ?? [];
    const first = roots[0];
    if (first === undefined) {
      throw new OpenVideoError({
        code: 'OV_PROJECT_OPEN_DISABLED',
        errorClass: 'SecurityError',
        problem: 'Opening project folders is not enabled on this host.',
        suggestions: ['Start the server with `openvideo mcp --project <dir>` or `openvideo serve --project <dir>`.', 'Or set OPENVIDEO_PROJECT_ROOTS to a comma-separated list of folders.', 'Or create a new project with project.create.'],
      });
    }
    const notFound = (): OpenVideoError =>
      new OpenVideoError({ code: 'OV_PROJECT_UNKNOWN', errorClass: 'ProjectError', problem: `No project folder "${input.path}" inside the allowed roots.`, received: JSON.stringify(input.path), suggestions: ['Pass a folder that contains openvideo.json or project.json.', `Allowed roots: ${String(roots.length)} configured; relative paths start at the first one.`] });
    let dir: string;
    try {
      dir = await realpath(isAbsolute(input.path) ? input.path : resolve(first, input.path));
    } catch (error) {
      if (error instanceof Error && 'code' in error) throw notFound();
      throw error;
    }
    const realRoots = await Promise.all(roots.map((r) => realpath(r).catch(() => undefined)));
    if (!realRoots.some((r) => r !== undefined && inside(r, dir))) {
      throw new OpenVideoError({ code: 'OV_PATH_OUTSIDE', errorClass: 'SecurityError', problem: `"${input.path}" is outside the allowed project roots.`, received: JSON.stringify(input.path), suggestions: ['Open a folder inside the roots given with --project or OPENVIDEO_PROJECT_ROOTS.', 'Or restart the server with --project pointing to this folder.'] });
    }
    if (!existsSync(join(dir, 'openvideo.json')) && !existsSync(join(dir, 'project.json'))) throw notFound();
    const config = await readProjectConfig(dir);
    const projectId = await ctx.services.workspace.link(dir, input.id);
    const loaded = await loadProject(ctx, projectId);
    const comps = Array.isArray(loaded.project['compositions']) ? loaded.project['compositions'].filter(isRecord).map((c) => String(c['id'])) : [];
    return { projectId, name: config.name, entry: config.entry, kind: isSourceEntry(config.entry) ? 'tsx' : 'json', compositions: comps };
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

const compositionPatch = defineOperation({
  name: 'composition.patch',
  summary: 'Apply semantic patches atomically; TSX projects are updated through AST edits.',
  input: Type.Object(
    {
      projectId: ProjectId,
      patches: Type.Array(PatchSchema, { minItems: 1, description: 'Applied in order, all or nothing. See schema.get { "name": "patch" } for every patch kind.' }),
      dryRun: Type.Optional(Type.Boolean({ description: 'Check and return diagnostics and inverse without saving.' })),
    },
    { additionalProperties: false },
  ),
  output: Type.Object({ ok: Type.Boolean(), diagnostics: Diagnostics, inverse: Type.Array(AnyObject), sourceUpdated: Type.Boolean() }),
  example: { input: { projectId: 'launch-video', patches: [{ op: 'setProperty', nodeId: 'headline', property: 'fontSize', value: 82 }, { op: 'setProperty', nodeId: 'headline', property: 'y', value: 720 }] } },
  check: (input) => (isRecord(input) && input['patches'] !== undefined ? checkPatchList(input['patches'], 'patches') : undefined),
  async handler(input, ctx) {
    const loaded = await loadProject(ctx, input.projectId);
    const patches = toCorePatches(input.patches);
    return withEnv(ctx, loaded, async (env) => {
      const result = applyPatches(loaded.project, patches, { validateOptions: validateOptionsOf(env.registry) });
      const inverse = result.inverse.map((p) => ({ ...p }));
      if (!result.ok || input.dryRun === true) return { ok: result.ok, diagnostics: plainDiagnostics(result.diagnostics), inverse, sourceUpdated: false };
      if (isSourceEntry(loaded.entry)) {
        const sources = ctx.services.sources;
        if (sources === undefined) throw new OpenVideoError({ code: 'OV_SOURCE_UNAVAILABLE', errorClass: 'ProjectError', problem: 'TSX write-back is not configured.', suggestions: ['Start the host with the TSX compiler (openvideo serve/mcp with Docker or --trusted).', 'Edit the TSX entry file directly and call composition.validate.'] });
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
    if (service === undefined) throw new OpenVideoError({ code: 'OV_ASSETS_UNAVAILABLE', errorClass: 'ApiError', problem: 'No asset service is configured.', suggestions: ['Start the host with the asset service (openvideo serve/mcp include it).', 'Copy the file into the project assets/ folder and declare it with an addAsset patch.'] });
    const loaded = await loadProject(ctx, input.projectId);
    // Mit dem Projekt: Asset Loader aus Plugins gelten auch beim Import (Story 21.1).
    const imported = await service.import(loaded.dir, input, loaded.project);
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
    if (service === undefined) throw new OpenVideoError({ code: 'OV_ASSETS_UNAVAILABLE', errorClass: 'ApiError', problem: 'No asset service is configured.', suggestions: ['Start the host with the asset service (openvideo serve/mcp include it).', 'Copy the file into the project assets/ folder and declare it with an addAsset patch.'] });
    const loaded = await loadProject(ctx, input.projectId);
    return { ...(await service.inspect(loaded.dir, loaded.project, input.assetId)) };
  },
});

const frameRender = defineOperation({
  name: 'frame.render',
  summary: 'Render one frame to PNG; returns the image, diagnostics and the frame cache key.',
  input: Type.Object(
    {
      projectId: ProjectId,
      compositionId: CompositionId,
      frame: FrameRef,
      scale: Type.Optional(Type.Number({ exclusiveMinimum: 0, maximum: 4 })),
      debug: Type.Optional(DebugSchema),
      inline: Type.Optional(Type.Boolean()),
      patches: Type.Optional(Type.Array(PatchSchema, { minItems: 1, description: 'Transient preview: applied only for this render and never saved (e.g. while dragging in the Studio).' })),
    },
    { additionalProperties: false },
  ),
  output: Type.Object({ image: ImageResult, key: Type.String(), cached: Type.Boolean(), diagnostics: Diagnostics, manifest: FrameManifestSchema }),
  example: { input: { projectId: 'launch-video', frame: '2s', scale: 0.5, debug: { showBounds: true } } },
  check: (input) => (isRecord(input) && input['patches'] !== undefined ? checkPatchList(input['patches'], 'patches') : undefined),
  async handler(input, ctx) {
    const loaded = await withPreviewPatches(ctx, await loadProject(ctx, input.projectId), input.patches);
    const comp = findComposition(loaded.project, input.compositionId);
    const scale = input.scale ?? 1;
    assertImageSize(Number(comp['width']) * scale, Number(comp['height']) * scale, 'frame.render');
    const frame = frameOf(loaded.project, input.compositionId, input.frame);
    return withEnv(ctx, loaded, async (env) => {
      assertRenderable(ctx, loaded.project, env.registry, [{ compositionId: input.compositionId, frame }]);
      const r = await renderFrame(env, loaded.project, { ...(input.compositionId !== undefined ? { compositionId: input.compositionId } : {}), frame, scale, ...(input.debug !== undefined ? { debug: input.debug } : {}) });
      // Der Name kommt aus geprüften Teilen; Varianten (scale, debug) bekommen einen eigenen Hash (B4, B16).
      // Transiente Vorschauen überschreiben eine feste Datei, statt je Zwischenstand eine neue anzulegen.
      const variant = input.patches !== undefined ? '-preview' : input.scale !== undefined || input.debug !== undefined ? `-${shortHash({ scale: input.scale, debug: input.debug })}` : '';
      const image = await imageOutput(ctx, input.projectId, `${fileSafe(r.scene.compositionId)}-${String(frame)}${variant}.png`, ctx.services.encodePng(r.image), r.image, input.inline !== false);
      // Kurzmanifest (Story 21.5): Eingaben, Pixel-Hash, genutzte Backends, Grafik, Chromium, GPU.
      const manifest = await buildFrameManifest(env, loaded.project, [{ frame, ...r }], scale);
      return { image, key: r.key, cached: r.cached, diagnostics: plainDiagnostics(r.diagnostics), manifest };
    });
  },
});

/**
 * Wendet Vorschau-Patches nur im Speicher an (`frame.render` mit `patches`, Story 20.5).
 * Abgelehnte Patches melden die erste neue Fehlerdiagnose; gespeichert wird nie.
 */
async function withPreviewPatches(ctx: OperationContext, loaded: Loaded, patches: readonly unknown[] | undefined): Promise<Loaded> {
  if (patches === undefined) return loaded;
  const result = await withEnv(ctx, loaded, (env) => Promise.resolve(applyPatches(loaded.project, toCorePatches(patches), { validateOptions: validateOptionsOf(env.registry) })));
  if (!result.ok) {
    const first = result.diagnostics.find((d) => d.severity === 'error');
    throw new OpenVideoError({
      code: 'OV_PREVIEW_PATCH',
      errorClass: 'ValidationError',
      problem: `The preview patches were rejected: ${first?.problem ?? 'unknown error'}`,
      ...(first?.nodeId !== undefined ? { nodeId: first.nodeId } : {}),
      suggestions: ['Check the patches with composition.patch { dryRun: true }.', ...(first?.suggestions ?? [])],
    });
  }
  return { ...loaded, project: result.project };
}

const frameRenderMany = defineOperation({
  name: 'frame.renderMany',
  summary: 'Render several frames to separate PNGs in one call (e.g. before/after a change); returns one image per frame.',
  input: Type.Object(
    {
      projectId: ProjectId,
      compositionId: CompositionId,
      frames: Type.Array(FrameRef, { minItems: 1, maxItems: 16, description: 'Up to 16 frames or times; duplicates are rendered once.' }),
      scale: Type.Optional(Type.Number({ exclusiveMinimum: 0, maximum: 4 })),
      debug: Type.Optional(DebugSchema),
      inline: Type.Optional(Type.Boolean({ description: 'Include base64 PNG data (default true; MCP shows the images).' })),
    },
    { additionalProperties: false },
  ),
  output: Type.Object({ frames: Type.Array(Type.Number()), images: Type.Array(ImageResult), keys: Type.Array(Type.String()), diagnostics: Diagnostics, manifest: FrameManifestSchema }),
  example: { input: { projectId: 'launch-video', frames: [0, '2s', 'marker:outro'], scale: 0.5 } },
  async handler(input, ctx) {
    const loaded = await loadProject(ctx, input.projectId);
    const comp = findComposition(loaded.project, input.compositionId);
    const scale = input.scale ?? 1;
    assertImageSize(Number(comp['width']) * scale, Number(comp['height']) * scale, 'frame.renderMany');
    const total = compositionDurationFrames(comp);
    const frames = [...new Set(input.frames.map((f) => frameOf(loaded.project, input.compositionId, f)))];
    const outside = frames.find((f) => f < 0 || f >= total);
    if (outside !== undefined) throw rangeError(`Frame ${String(outside)} is outside the composition (0–${String(total - 1)}).`);
    return withEnv(ctx, loaded, async (env) => {
      assertRenderable(ctx, loaded.project, env.registry, frames.map((frame) => ({ compositionId: input.compositionId, frame })));
      const images = [];
      const keys: string[] = [];
      const diagnostics: Diagnostic[] = [];
      const rendered: ManifestFrame[] = [];
      const variant = input.scale !== undefined || input.debug !== undefined ? `-${shortHash({ scale: input.scale, debug: input.debug })}` : '';
      for (const frame of frames) {
        const r = await renderFrame(env, loaded.project, { ...(input.compositionId !== undefined ? { compositionId: input.compositionId } : {}), frame, scale, ...(input.debug !== undefined ? { debug: input.debug } : {}) });
        images.push(await imageOutput(ctx, input.projectId, `${fileSafe(r.scene.compositionId)}-${String(frame)}${variant}.png`, ctx.services.encodePng(r.image), r.image, input.inline !== false));
        keys.push(r.key);
        rendered.push({ frame, ...r });
        // Gleiche Meldung an mehreren Frames nur einmal (Frame steht in der Diagnose).
        for (const d of r.diagnostics) if (d.severity !== 'info' && !diagnostics.some((x) => x.code === d.code && x.path === d.path && x.problem === d.problem)) diagnostics.push(d);
      }
      return { frames, images, keys, diagnostics: plainDiagnostics(diagnostics), manifest: await buildFrameManifest(env, loaded.project, rendered, scale) };
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
    return withEnv(ctx, loaded, async (env) => {
      // fromAudio-Transkripte wie beim Render (Review Q3).
      await env.prepare?.(loaded.project);
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
  output: Type.Object({ image: ImageResult, frames: Type.Array(Type.Number()), diagnostics: Diagnostics, manifest: FrameManifestSchema }),
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
      const rendered: ManifestFrame[] = [];
      for (const f of frames) {
        const r = await renderFrame(env, loaded.project, { ...(input.compositionId !== undefined ? { compositionId: input.compositionId } : {}), frame: f, scale });
        rendered.push({ frame: f, ...r });
        diagnostics.push(...r.diagnostics.filter((d) => d.severity !== 'info'));
        cells.push({ image: r.image, label: `#${String(f)} · ${(f / fps).toFixed(2)}s` });
      }
      const sheet = overlays.contactSheet(cells, { columns, cellWidth, background: '#1B1D24' });
      const name = `contact-sheet-${fileSafe(String(comp['id']))}-${shortHash({ frames, columns, cellWidth })}.png`;
      const image = await imageOutput(ctx, input.projectId, name, ctx.services.encodePng(sheet), sheet, input.inline !== false);
      return { image, frames, diagnostics: plainDiagnostics(diagnostics), manifest: await buildFrameManifest(env, loaded.project, rendered, scale) };
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
  summary: 'Status, progress and result of a render job; without jobId, all jobs (optionally of one project), newest first.',
  input: Type.Object({ jobId: Type.Optional(Type.String()), projectId: Type.Optional(ProjectId) }, { additionalProperties: false }),
  output: AnyObject,
  example: { input: { jobId: 'job-…' } },
  handler(input, ctx) {
    if (input.jobId !== undefined) return Promise.resolve({ ...ctx.services.jobs.status(input.jobId) });
    // Liste (Story 20.8): das Studio stellt damit seine Render Queue nach einem Neuladen wieder her.
    const jobs = ctx.services.jobs
      .list()
      .filter((j) => input.projectId === undefined || j.projectId === input.projectId)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
      .map((j) => ({ ...j }));
    return Promise.resolve({ jobs });
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
    const list = await withEnv(ctx, loaded, async (env) => {
      const out: Diagnostic[] = [...checkProject(env, loaded.project)];
      if (input.frame !== undefined && out.every((d) => d.severity !== 'error')) {
        await env.prepare?.(loaded.project);
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
    if (catalog === undefined) throw new OpenVideoError({ code: 'OV_TEMPLATES_UNAVAILABLE', errorClass: 'ApiError', problem: 'No template catalog is configured.', suggestions: ['Start the host with the template catalog (openvideo serve/mcp include it).', 'Create the project from JSON with "project" instead of "template".'] });
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

const [capabilitiesGet, schemaGet] = describeOperations(() => OPERATIONS);

/** Alle Operationen nach Namen (FR-21). */
export const OPERATIONS: ReadonlyMap<string, OperationDefinition> = new Map<string, OperationDefinition>(
  [
    capabilitiesGet,
    schemaGet,
    projectCreate,
    projectOpen,
    projectImport,
    projectInspect,
    projectUpdate,
    compositionCreate,
    compositionGet,
    compositionValidate,
    compositionPatch,
    assetImport,
    assetInspect,
    frameRender,
    frameRenderMany,
    frameInspect,
    previewRender,
    previewContactSheet,
    videoRender,
    renderStatus,
    renderCancel,
    diagnosticsGet,
    subtitlesTranscribe,
    fontsList,
    templatesList,
    templatesInspect,
    sceneDescribe,
    sceneTreeOp,
    timelineInspect,
    benchmarkRun,
    pluginsList,
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
  await assertProjectAccess(ctx.services, projectId);
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
