/**
 * Frame-Schlüssel (AD-7): Inhalts-Hash eines Frames für Cache und Teil-Neurender (FR-69).
 */
import type { EvaluatedNode, EvaluatedScene } from './contracts.js';
import { contentHash } from './hash.js';

/**
 * Node-Typen, deren Pixel direkt von der Zeit abhängen (nicht nur über ausgewertete Properties).
 * Nur für sie fließt die lokale Zeit in den Schlüssel ein.
 */
export const TIME_DEPENDENT_TYPES: ReadonlySet<string> = new Set(['video', 'lottie', 'html', 'sprite', 'particles', 'shader', 'scene3d', 'blender', 'model3d', 'particles3d', 'instances3d']);

function strip(node: EvaluatedNode): unknown {
  return {
    id: node.id,
    type: node.type,
    props: node.props,
    children: node.children.map(strip),
    mask: node.mask === undefined ? undefined : { ...node.mask, node: strip(node.mask.node) },
    reveal: node.reveal,
    renderer: node.renderer,
    time: TIME_DEPENDENT_TYPES.has(node.type) ? { localFrame: node.time.localFrame, relFrame: node.time.relFrame, durationFrames: node.time.durationFrames } : undefined,
  };
}

/**
 * Berechnet den Schlüssel eines Frames. Gleiche Schlüssel bedeuten gleiche Pixel.
 *
 * @param versions Versionen aller beteiligten Backends und des Compositors.
 * @param assetHashes Hashes aller Assets, die der Frame nutzt.
 *
 * @example
 * ```ts
 * const key = frameKey(scene, { skia: '0.42.0' }, { logo: 'sha256:…' }, { width: 1920, height: 1080 });
 * ```
 */
export function frameKey(
  scene: EvaluatedScene,
  versions: Readonly<Record<string, string>>,
  assetHashes: Readonly<Record<string, string>>,
  output: { readonly width: number; readonly height: number; readonly extra?: unknown },
): string {
  return contentHash({
    width: scene.width,
    height: scene.height,
    fps: scene.fps,
    seed: scene.seed,
    background: scene.background,
    colorSpace: scene.colorSpace,
    nodes: scene.nodes.map(strip),
    versions,
    assetHashes,
    output,
  });
}
