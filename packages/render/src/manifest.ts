/**
 * Render-Manifest (FR-8, A20): alle Eingaben und Versionen eines Renders.
 * Gleiche Eingaben liefern gleiche Frame-Hashes (FR-9).
 */
import { createHash } from 'node:crypto';
import Type, { type Static } from 'typebox';
import { SCHEMA_VERSION, backendsInPlan, contentHash, findComposition, isRecord, planFrame, validateValue, type Diagnostic, type EvaluatedNode, type EvaluatedScene, type LayerPlan, type RgbaImage } from '@agentic-video/core';
import { threeBackendFor } from '@agentic-video/renderer-browser';
import type { RenderEnvironment, RuntimeInfo } from './environment.js';
import { OPENVIDEO_VERSION } from './version.js';

/** Eine Version oder `null` mit Begründung, falls die Komponente nicht beteiligt ist. */
export const VersionOrReason = Type.Union([Type.String({ minLength: 1 }), Type.Object({ version: Type.Null(), reason: Type.String({ minLength: 1 }) }, { additionalProperties: false })]);
export type VersionOrReason = Static<typeof VersionOrReason>;

const Hash = Type.String({ pattern: '^sha256:[0-9a-f]{64}$' });

/**
 * Grafik eines Renders (T5, Story 21.5): Modus des Browser-Renderers, WebGL2/WebGPU der
 * Render-Seite (wenn Chromium mit Grafik lief) und die tatsächlich gewählten Three.js-Backends.
 */
export const ManifestGraphicsSchema = Type.Object(
  {
    browserGpu: Type.Union([Type.Literal('swiftshader'), Type.Literal('native')]),
    webgl2: VersionOrReason,
    webgpu: VersionOrReason,
    /** `webgpu`/`webgl2` je genutzter `scene3d`-Wahl; `auto` nur, wenn WebGPU nicht geprüft wurde. */
    threeBackends: Type.Array(Type.Union([Type.Literal('webgpu'), Type.Literal('webgl2'), Type.Literal('auto')])),
  },
  { additionalProperties: false },
);
export type ManifestGraphics = Static<typeof ManifestGraphicsSchema>;

/** JSON Schema des Render-Manifests. */
export const RenderManifestSchema = Type.Object(
  {
    manifestVersion: Type.Literal('1.0.0'),
    openvideoVersion: Type.String(),
    schemaVersion: Type.String(),
    compositionId: Type.String(),
    compositionHash: Hash,
    projectHash: Hash,
    assetHashes: Type.Record(Type.String(), Type.String()),
    fontHashes: Type.Array(Type.Object({ family: Type.String(), weight: Type.String(), style: Type.String(), hash: Type.String() }, { additionalProperties: false })),
    dependencyVersions: Type.Record(Type.String(), Type.String()),
    rendererVersions: Type.Record(Type.String(), Type.Record(Type.String(), Type.String())),
    chromiumVersion: VersionOrReason,
    ffmpegVersion: VersionOrReason,
    threeVersion: VersionOrReason,
    pixiVersion: VersionOrReason,
    skiaVersion: VersionOrReason,
    blenderVersion: VersionOrReason,
    os: Type.String(),
    containerImage: VersionOrReason,
    gpu: VersionOrReason,
    /** Tatsächlich genutzte Backends (aus den Frame-Plänen), nicht alle registrierten. */
    renderBackend: Type.Array(Type.String()),
    graphics: Type.Optional(ManifestGraphicsSchema),
    /** Stimmen der Tonspur: ID → Cache-Schlüssel (Provider, Version, Text, Einstellungen). */
    voiceHashes: Type.Optional(Type.Record(Type.String(), Hash)),
    resolution: Type.Object({ width: Type.Integer(), height: Type.Integer() }, { additionalProperties: false }),
    fps: Type.Number(),
    codec: Type.String(),
    format: Type.String(),
    seed: Type.Integer(),
    colorSpace: Type.String(),
    timestamp: Type.String(),
    frames: Type.Object({ start: Type.Integer(), end: Type.Integer(), count: Type.Integer() }, { additionalProperties: false }),
    frameHashes: Type.Array(Hash),
    chunks: Type.Array(Type.Object({ start: Type.Integer(), end: Type.Integer(), hash: Hash, worker: Type.Optional(Type.String()) }, { additionalProperties: false })),
    ffmpegLicense: VersionOrReason,
    codecLicenses: Type.Record(Type.String(), Type.String()),
    encoder: Type.Optional(Type.Object({ name: Type.String(), args: Type.Array(Type.String()) }, { additionalProperties: false })),
    audio: Type.Union([Type.Null(), Type.Object({ path: Type.String(), durationSeconds: Type.Number(), loudness: Type.Optional(Type.Number()) }, { additionalProperties: false })]),
    outputs: Type.Array(Type.Object({ path: Type.String(), hash: Hash, bytes: Type.Integer() }, { additionalProperties: false })),
    trusted: Type.Boolean(),
    stages: Type.Record(Type.String(), Type.Number()),
    cache: Type.Object(
      {
        hitRatio: Type.Number(),
        framesRendered: Type.Integer(),
        framesFromCache: Type.Integer(),
        /** Cache-Ebene `encoding` (ganze Ausgabe): `hit`, `miss` oder `off` (ADR 0021). */
        output: Type.Optional(Type.Union([Type.Literal('hit'), Type.Literal('miss'), Type.Literal('off')])),
      },
      { additionalProperties: false },
    ),
    diagnostics: Type.Object({ errors: Type.Integer(), warnings: Type.Integer() }, { additionalProperties: false }),
  },
  { additionalProperties: false, $id: 'https://raw.githubusercontent.com/deltatree/agentic-video-engine/main/packages/render/render-manifest.schema.json' },
);
export type RenderManifest = Static<typeof RenderManifestSchema>;

/**
 * Pixel-Hash eines Frames: SHA-256 über Breite, Höhe (je u32, Big Endian) und die vormultiplizierten
 * RGBA-Daten. Rechnet inkrementell mit `node:crypto` (Story 18.5): kein zusammengesetzter Puffer,
 * native Geschwindigkeit; der Wert ist identisch zu `contentHash(header ‖ data)`.
 *
 * @example
 * ```ts
 * const hash = imageHash(frame); // 'sha256:…'
 * ```
 */
export function imageHash(image: RgbaImage): string {
  const header = new Uint8Array(8);
  const view = new DataView(header.buffer);
  view.setUint32(0, image.width);
  view.setUint32(4, image.height);
  return `sha256:${createHash('sha256').update(header).update(image.data).digest('hex')}`;
}

/** Hash eines Chunks über die Pixel-Hashes seiner Frames. */
export function chunkHash(frameHashes: readonly string[]): string {
  return contentHash(frameHashes);
}

/** Version aus einer Map lesen oder begründetes `null` liefern. */
export function versionOr(versions: Readonly<Record<string, string>>, key: string, reason: string): VersionOrReason {
  const v = versions[key];
  return v !== undefined && v !== '' ? v : { version: null, reason };
}

/**
 * Prüft ein Manifest gegen sein Schema.
 *
 * @example
 * ```ts
 * const problems = validateManifest(JSON.parse(text));
 * ```
 */
export function validateManifest(manifest: unknown): string[] {
  return validateValue(RenderManifestSchema, manifest).map((i) => `${i.segments.join('.')}: ${i.message}`);
}

/** Zählt Fehler und Warnungen. */
export function countDiagnostics(diagnostics: readonly Diagnostic[]): { errors: number; warnings: number } {
  return { errors: diagnostics.filter((d) => d.severity === 'error').length, warnings: diagnostics.filter((d) => d.severity === 'warning').length };
}

export { SCHEMA_VERSION };

/** Rohe Struktur einer ausgewerteten Node (Props, `id`, `type`, `children`) für reine Prüffunktionen. */
function rawNode(node: EvaluatedNode): Record<string, unknown> {
  return { ...node.props, id: node.id, type: node.type, children: node.children.map(rawNode) };
}

/** Standard-2D-Renderer des Projekts (`settings.renderer2d`, Standard `skia`). */
export function renderer2dOf(project: Readonly<Record<string, unknown>>): string {
  const settings = project['settings'];
  return isRecord(settings) && typeof settings['renderer2d'] === 'string' ? settings['renderer2d'] : 'skia';
}

/** Genutzte Backends und Three.js-Wahl eines Frames. */
export interface FrameBackendUsage {
  readonly backends: readonly string[];
  readonly threeBackends: readonly ('webgpu' | 'webgl2' | 'auto')[];
}

/**
 * Welche Backends ein Frame tatsächlich nutzt (aus dem Frame-Plan) und welches Three.js-Backend
 * jede `scene3d`-Node wählt (Story 21.5). `three-webgpu` in `env.versions` (Ergebnis der Probe der
 * Render-Seite) entscheidet `backend: 'auto'`; ohne Probe bleibt `auto` stehen.
 *
 * @example
 * ```ts
 * frameBackendUsage(env, project, scene); // { backends: ['skia', 'three'], threeBackends: ['webgl2'] }
 * ```
 */
export function frameBackendUsage(env: Pick<RenderEnvironment, 'registry' | 'versions'>, project: Readonly<Record<string, unknown>>, scene: EvaluatedScene): FrameBackendUsage {
  const plan = planFrame(scene, env.registry, { renderer2d: renderer2dOf(project) });
  const probe = env.versions['three-webgpu'];
  const three = new Set<'webgpu' | 'webgl2' | 'auto'>();
  const visit = (p: LayerPlan): void => {
    if (p.kind === 'composite') {
      p.children.forEach(visit);
      return;
    }
    if (p.backend !== 'three') return;
    for (const n of p.nodes) {
      if (n.type !== 'scene3d') continue;
      const raw = rawNode(n);
      const explicit = raw['backend'] === 'webgpu' || raw['backend'] === 'webgl2';
      three.add(explicit || probe !== undefined ? threeBackendFor(raw, probe === 'available') : 'auto');
    }
  };
  plan.forEach(visit);
  return { backends: [...backendsInPlan(plan)].sort(), threeBackends: [...three].sort() };
}

/**
 * Grafik-Angaben für das Manifest aus Plattform, Laufzeit-Probe und genutzten Three.js-Backends.
 *
 * @example
 * ```ts
 * manifestGraphics(env, await env.runtime?.(), ['webgl2']);
 * ```
 */
export function manifestGraphics(env: Pick<RenderEnvironment, 'platform'>, runtime: RuntimeInfo | undefined, threeBackends: readonly ('webgpu' | 'webgl2' | 'auto')[]): ManifestGraphics {
  const notProbed = { version: null, reason: 'Chromium did not render WebGL/WebGPU layers in this process.' };
  const g = runtime?.graphics;
  return {
    browserGpu: env.platform.browserGpu ?? 'swiftshader',
    webgl2: g === undefined ? notProbed : g.webgl2 === 'unavailable' ? { version: null, reason: 'WebGL2 is unavailable in Chromium.' } : g.webgl2,
    webgpu: g === undefined ? notProbed : g.webgpuAvailable ? g.webgpu : { version: null, reason: `WebGPU is unavailable in Chromium (${g.webgpu}); three uses WebGL2.` },
    threeBackends: [...new Set(threeBackends)].sort(),
  };
}

/**
 * Chromium-Version für das Manifest: die tatsächliche aus `browser.version()` (lokal oder aus den
 * Worker-Ergebnissen), sonst eine Begründung. Die erwartete Version aus playwright-core steht nur im
 * Cache-Schlüssel.
 */
export function manifestChromium(runtime: RuntimeInfo | undefined, fromWorkers: readonly string[], usedBrowser: boolean): VersionOrReason {
  const actual = runtime?.versions['chromium'] ?? fromWorkers[0];
  if (actual !== undefined && actual !== '') return actual;
  return { version: null, reason: usedBrowser ? 'Chromium ran in a worker that did not report its version.' : 'No layer of this render used Chromium.' };
}

/** GPU für das Manifest: erkannte GPU oder Begründung. */
export function manifestGpu(env: Pick<RenderEnvironment, 'platform'>): VersionOrReason {
  return env.platform.gpu ?? { version: null, reason: 'No GPU detected (nvidia-smi, /dev/dri); software rendering (SwiftShader/CPU).' };
}

/** Kurzmanifest für Einzelbilder, Mehrfach-Frames und Kontaktbögen (Story 21.5). */
export const FrameManifestSchema = Type.Object(
  {
    manifestVersion: Type.Literal('1.0.0'),
    kind: Type.Literal('frames'),
    openvideoVersion: Type.String(),
    schemaVersion: Type.String(),
    compositionId: Type.String(),
    compositionHash: Hash,
    projectHash: Hash,
    scale: Type.Number(),
    resolution: Type.Object({ width: Type.Integer(), height: Type.Integer() }, { additionalProperties: false }),
    seed: Type.Integer(),
    frames: Type.Array(Type.Object({ frame: Type.Number(), key: Type.String(), hash: Hash, cached: Type.Boolean() }, { additionalProperties: false })),
    renderBackend: Type.Array(Type.String()),
    graphics: ManifestGraphicsSchema,
    chromiumVersion: VersionOrReason,
    gpu: VersionOrReason,
    os: Type.String(),
    containerImage: VersionOrReason,
    dependencyVersions: Type.Record(Type.String(), Type.String()),
    trusted: Type.Boolean(),
    timestamp: Type.String(),
  },
  { additionalProperties: false },
);
export type FrameManifest = Static<typeof FrameManifestSchema>;

/** Ein gerenderter Frame für {@link buildFrameManifest}. */
export interface ManifestFrame {
  readonly frame: number;
  readonly image: RgbaImage;
  readonly key: string;
  readonly cached: boolean;
  readonly scene: EvaluatedScene;
}

/**
 * Baut das Kurzmanifest einer Frame-Operation (`frame.render`, `frame.renderMany`,
 * `preview.contactSheet`, `openvideo render-frame --manifest`): Eingabe-Hashes, Frame-Schlüssel und
 * Pixel-Hashes, genutzte Backends, Grafik, tatsächliche Chromium-Version und GPU.
 *
 * @example
 * ```ts
 * const r = await renderFrame(env, project, { frame: 0 });
 * const manifest = await buildFrameManifest(env, project, [{ frame: 0, ...r }], 1);
 * ```
 */
export async function buildFrameManifest(env: RenderEnvironment, project: Readonly<Record<string, unknown>>, frames: readonly ManifestFrame[], scale: number): Promise<FrameManifest> {
  const first = frames[0];
  const compositionId = first?.scene.compositionId ?? String(findComposition(project, undefined)['id']);
  const comp = findComposition(project, compositionId);
  const backends = new Set<string>();
  const three: ('webgpu' | 'webgl2' | 'auto')[] = [];
  for (const f of frames) {
    const usage = frameBackendUsage(env, project, f.scene);
    usage.backends.forEach((b) => backends.add(b));
    three.push(...usage.threeBackends);
  }
  const runtime = await env.runtime?.();
  const usedBrowser = ['browser', 'three', 'pixi'].some((b) => backends.has(b));
  return {
    manifestVersion: '1.0.0',
    kind: 'frames',
    openvideoVersion: OPENVIDEO_VERSION,
    schemaVersion: String(project['schemaVersion']),
    compositionId,
    compositionHash: contentHash(comp),
    projectHash: contentHash(project),
    scale,
    resolution: { width: first?.image.width ?? 0, height: first?.image.height ?? 0 },
    seed: first?.scene.seed ?? 0,
    frames: frames.map((f) => ({ frame: f.frame, key: f.key, hash: imageHash(f.image), cached: f.cached })),
    renderBackend: [...backends].sort(),
    graphics: manifestGraphics(env, runtime, three),
    chromiumVersion: manifestChromium(runtime, [], usedBrowser),
    gpu: manifestGpu(env),
    os: env.platform.os,
    containerImage: env.platform.containerImage ?? { version: null, reason: 'Rendered outside a container.' },
    dependencyVersions: Object.fromEntries(Object.entries(env.versions).filter(([k]) => !k.startsWith('backend:'))),
    trusted: env.trusted,
    timestamp: new Date().toISOString(),
  };
}

/**
 * Prüft ein Kurzmanifest gegen sein Schema.
 *
 * @example
 * ```ts
 * validateFrameManifest(manifest); // []
 * ```
 */
export function validateFrameManifest(manifest: unknown): string[] {
  return validateValue(FrameManifestSchema, manifest).map((i) => `${i.segments.join('.')}: ${i.message}`);
}
