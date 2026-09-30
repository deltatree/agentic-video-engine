/**
 * Three-Layer in der Seite: `ThreeLayerRenderer` rendert die Szene, die Node-Matrix
 * platziert das Ergebnis im Ausgabe-Canvas.
 */
import { OpenVideoError, getNumber } from '@agentic-video/core';
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
  if (node?.type !== 'scene3d' || rest.length > 0) {
    throw new OpenVideoError({
      code: 'OV_BROWSER_PAYLOAD',
      errorClass: 'ThreeRendererError',
      problem: `The three backend renders exactly one "scene3d" node per layer, got ${String(payload.nodes.length)} node(s) (${payload.nodes.map((n) => `${n.id}:${n.type}`).join(', ')}).`,
      ...(node !== undefined ? { nodeId: node.id } : {}),
      suggestions: ['Plan layers with planFrame; the three backend is not fusable.', 'Wrap 2D content next to the scene in a separate node instead of the scene3d children.'],
    });
  }
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
    // Probe des Hosts (steht im Cache-Schlüssel): keine Live-Entscheidung in der Seite (Review M3).
    ...(payload.graphics === undefined ? {} : { graphics: payload.graphics }),
  });
  await sendCanvas(canvas, payload.width, payload.height, frameUrl, { matrix: outputMatrix(node, payload.scale), width, height, node });
}
