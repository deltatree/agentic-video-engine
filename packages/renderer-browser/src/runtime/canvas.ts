/**
 * Gemeinsame Ausgabe für Three- und Pixi-Layer: Canvas in Ausgabegröße zeichnen,
 * Pixel lesen und per `POST /frame/<id>` an den Host senden.
 */
import { localMatrix, multiply, scale as scaleMatrix, getTransform, type EvaluatedNode, type Matrix2D } from '@agentic-video/core';
import type { BrowserLayerPayload } from '../protocol.js';
import { clearDefs, defineColorMatrices } from './defs.js';
import { cssFilter } from './style.js';

/** URL eines Assets auf der Host-Origin. */
export function assetUrl(assetId: string): string {
  return `/assets/${encodeURIComponent(assetId)}`;
}

/**
 * Stellt die Uhr der Host-Seite auf den Frame: `Date`, `performance.now` und ein pro Frame
 * neu gesätes `Math.random` machen Bibliotheken unabhängig von der Render-Reihenfolge.
 *
 * @example
 * ```ts
 * syncPageClock(payload, 'three');
 * ```
 */
export function syncPageClock(payload: BrowserLayerPayload, key: string): void {
  window.__ovClock?.frame({ timeMs: payload.time * 1000, frame: payload.frame, fps: payload.fps, progress: 0, seed: payload.seed, key });
}

/** Lokale Zeit einer Node in Sekunden. */
export function localSeconds(node: EvaluatedNode, fps: number): number {
  return node.time.localFrame / fps;
}

/** Ausgabematrix einer Node: `scale(outputScale) × localMatrix(node)`. */
export function outputMatrix(node: EvaluatedNode, outputScale: number): Matrix2D {
  return multiply(scaleMatrix(outputScale, outputScale), localMatrix(node));
}

/**
 * Zeichnet eine Quelle in ein neues Ausgabe-Canvas und sendet die Pixel an den Host.
 * Chromium liefert `getImageData` mit geradem Alpha; der Host multipliziert verlustfrei vor.
 *
 * @example
 * ```ts
 * await sendCanvas(sceneCanvas, 1920, 1080, '/frame/7', { matrix, width: 800, height: 600, node });
 * ```
 */
export async function sendCanvas(
  source: CanvasImageSource,
  width: number,
  height: number,
  frameUrl: string,
  place?: { readonly matrix: Matrix2D; readonly width: number; readonly height: number; readonly node: EvaluatedNode },
): Promise<void> {
  const out = document.createElement('canvas');
  out.width = width;
  out.height = height;
  const ctx = out.getContext('2d', { colorSpace: 'srgb', willReadFrequently: true });
  if (ctx === null) throw new Error('2D canvas context is not available.');
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
  if (place === undefined) {
    ctx.drawImage(source, 0, 0);
  } else {
    const m = place.matrix;
    ctx.setTransform(m[0], m[1], m[2], m[3], m[4], m[5]);
    ctx.globalAlpha = getTransform(place.node).opacity;
    clearDefs();
    const idFor = (i: number): string => `ov-canvas-cm-${String(i)}`;
    const { filter, colorMatrices } = cssFilter(place.node.props['filters'], place.node.props['shadow'], idFor);
    defineColorMatrices(colorMatrices, idFor);
    ctx.filter = filter;
    ctx.drawImage(source, 0, 0, place.width, place.height);
  }
  const data = ctx.getImageData(0, 0, width, height).data;
  const response = await fetch(frameUrl, { method: 'POST', body: data, headers: { 'content-type': 'application/octet-stream' } });
  if (!response.ok) throw new Error(`Frame upload failed with HTTP ${String(response.status)}.`);
}
