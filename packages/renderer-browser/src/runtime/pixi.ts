/**
 * Pixi-Layer in der Seite: `PixiLayerRenderer` rendert alle 2D-Nodes des Layers.
 * Video-Frames kommen vom Host über `/video/<asset>/<sekunden>` als PNG.
 */
import { DEFAULT_FONT_FAMILY } from '@agentic-video/core';
import { PixiLayerRenderer } from '@agentic-video/renderer-pixi';
import type { BrowserLayerPayload } from '../protocol.js';
import { assetUrl, sendCanvas, syncPageClock } from './canvas.js';
import { loadFonts } from './fonts.js';

let renderer: PixiLayerRenderer | undefined;

async function videoFrame(assetId: string, seconds: number): Promise<ImageBitmap> {
  const response = await fetch(`/video/${encodeURIComponent(assetId)}/${String(seconds)}`);
  if (!response.ok) throw new Error(`Video frame for asset "${assetId}" at ${String(seconds)} s failed with HTTP ${String(response.status)}.`);
  return createImageBitmap(await response.blob(), { premultiplyAlpha: 'premultiply', colorSpaceConversion: 'none' });
}

/**
 * Rendert alle Nodes eines Pixi-Layers und sendet die Pixel an `frameUrl`.
 *
 * @example
 * ```ts
 * await renderPixiLayer({ nodes, width: 640, height: 360, scale: 1, frame: 0, time: 0, fps: 30, seed: 1 }, '/frame/2');
 * ```
 */
export async function renderPixiLayer(payload: BrowserLayerPayload, frameUrl: string): Promise<void> {
  await loadFonts(document);
  syncPageClock(payload, 'pixi');
  renderer ??= new PixiLayerRenderer();
  const canvas = await renderer.render({
    nodes: payload.nodes,
    width: payload.compositionWidth ?? payload.width / payload.scale,
    height: payload.compositionHeight ?? payload.height / payload.scale,
    scale: payload.scale,
    frame: payload.frame,
    time: payload.time,
    fps: payload.fps,
    seed: payload.seed,
    assetUrl,
    videoFrame,
    defaultFont: payload.defaultFont ?? DEFAULT_FONT_FAMILY,
  });
  await sendCanvas(canvas, payload.width, payload.height, frameUrl);
}
