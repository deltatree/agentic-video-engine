/**
 * Three-Layer in der Seite: `ThreeLayerRenderer` rendert die Szene, die Node-Matrix
 * platziert das Ergebnis im Ausgabe-Canvas.
 */
import { getNumber } from '@agentic-video/core';
import { ThreeLayerRenderer } from '@agentic-video/renderer-three';
import type { BrowserLayerPayload } from '../protocol.js';
import { assetUrl, localSeconds, outputMatrix, sendCanvas, syncPageClock } from './canvas.js';

let renderer: ThreeLayerRenderer | undefined;

/**
 * Rendert genau eine `scene3d`-Node und sendet die Pixel an `frameUrl`.
 *
 * @example
 * ```ts
 * await renderThreeLayer({ nodes: [scene], width: 640, height: 360, scale: 1, frame: 0, time: 0, fps: 30, seed: 1 }, '/frame/1');
 * ```
 */
export async function renderThreeLayer(payload: BrowserLayerPayload, frameUrl: string): Promise<void> {
  const [node, ...rest] = payload.nodes;
  if (node?.type !== 'scene3d' || rest.length > 0) throw new TypeError('The three backend renders exactly one "scene3d" node per layer.');
  syncPageClock(payload, 'three');
  renderer ??= new ThreeLayerRenderer();
  const width = getNumber(node, 'width', 0);
  const height = getNumber(node, 'height', 0);
  const canvas = await renderer.render({
    node,
    width,
    height,
    scale: payload.scale,
    frame: node.time.localFrame,
    time: localSeconds(node, payload.fps),
    fps: payload.fps,
    seed: payload.seed,
    assetUrl,
    ...(payload.debug === undefined ? {} : { debug: payload.debug }),
  });
  await sendCanvas(canvas, payload.width, payload.height, frameUrl, { matrix: outputMatrix(node, payload.scale), width, height, node });
}
