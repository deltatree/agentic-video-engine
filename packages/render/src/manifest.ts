/**
 * Render-Manifest (FR-8, A20): alle Eingaben und Versionen eines Renders.
 * Gleiche Eingaben liefern gleiche Frame-Hashes (FR-9).
 */
import Type, { type Static } from 'typebox';
import { SCHEMA_VERSION, contentHash, validateValue, type Diagnostic, type RgbaImage } from '@agentic-video/core';

/** Eine Version oder `null` mit Begründung, falls die Komponente nicht beteiligt ist. */
export const VersionOrReason = Type.Union([Type.String({ minLength: 1 }), Type.Object({ version: Type.Null(), reason: Type.String({ minLength: 1 }) }, { additionalProperties: false })]);
export type VersionOrReason = Static<typeof VersionOrReason>;

const Hash = Type.String({ pattern: '^sha256:[0-9a-f]{64}$' });

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
    renderBackend: Type.Array(Type.String()),
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
    cache: Type.Object({ hitRatio: Type.Number(), framesRendered: Type.Integer(), framesFromCache: Type.Integer() }, { additionalProperties: false }),
    diagnostics: Type.Object({ errors: Type.Integer(), warnings: Type.Integer() }, { additionalProperties: false }),
  },
  { additionalProperties: false, $id: 'https://raw.githubusercontent.com/deltatree/agentic-video-engine/main/packages/render/render-manifest.schema.json' },
);
export type RenderManifest = Static<typeof RenderManifestSchema>;

/** Pixel-Hash eines Frames: SHA-256 über Breite, Höhe und vormultiplizierte RGBA-Daten. */
export function imageHash(image: RgbaImage): string {
  const header = new Uint8Array(8);
  const view = new DataView(header.buffer);
  view.setUint32(0, image.width);
  view.setUint32(4, image.height);
  return contentHash(concat(header, image.data));
}

function concat(a: Uint8Array, b: Uint8Array): Uint8Array {
  const out = new Uint8Array(a.length + b.length);
  out.set(a, 0);
  out.set(b, a.length);
  return out;
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
