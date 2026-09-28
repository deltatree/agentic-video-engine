/**
 * Platziert das Blender-Bild der Box `width × height` mit der 2D-Matrix der Node im
 * Ausgabebild (wie `scene3d`). Bilineare Abtastung, vormultipliziertes Alpha.
 */
import { createImage, getNumber, getTransform, invert, localMatrix, multiply, scale, transformRect, type EvaluatedNode, type RgbaImage } from '@agentic-video/core';

/** Render-Auflösung der Box bei gegebener Ausgabeskalierung (mindestens 1 × 1). */
export function renderSize(node: EvaluatedNode, outputScale: number): { width: number; height: number } {
  return {
    width: Math.max(1, Math.round(getNumber(node, 'width', 0) * outputScale)),
    height: Math.max(1, Math.round(getNumber(node, 'height', 0) * outputScale)),
  };
}

/**
 * Zeichnet `image` (Render der Box) mit Matrix und Deckkraft der Node in ein neues
 * Ausgabebild `outWidth × outHeight`.
 *
 * @example
 * ```ts
 * const layer = placeImage(rendered, blenderNode, 1920, 1080, 1);
 * ```
 */
export function placeImage(image: RgbaImage, node: EvaluatedNode, outWidth: number, outHeight: number, outputScale: number): RgbaImage {
  const out = createImage(outWidth, outHeight);
  const boxW = getNumber(node, 'width', 0);
  const boxH = getNumber(node, 'height', 0);
  if (boxW <= 0 || boxH <= 0) return out;
  // Bildpixel → Box-Koordinaten → Ausgabe.
  const m = multiply(multiply(scale(outputScale, outputScale), localMatrix(node)), scale(boxW / image.width, boxH / image.height));
  const inv = invert(m);
  if (inv === undefined) return out;
  const opacity = getTransform(node).opacity;
  const bounds = transformRect(m, { x: 0, y: 0, width: image.width, height: image.height });
  const x0 = Math.max(0, Math.floor(bounds.x));
  const y0 = Math.max(0, Math.floor(bounds.y));
  const x1 = Math.min(outWidth, Math.ceil(bounds.x + bounds.width));
  const y1 = Math.min(outHeight, Math.ceil(bounds.y + bounds.height));
  const src = image.data;
  const w = image.width;
  const h = image.height;
  const texel = (x: number, y: number, c: number): number => (x < 0 || y < 0 || x >= w || y >= h ? 0 : (src[(y * w + x) * 4 + c] ?? 0));
  for (let y = y0; y < y1; y++) {
    for (let x = x0; x < x1; x++) {
      const cx = x + 0.5;
      const cy = y + 0.5;
      const u = inv[0] * cx + inv[2] * cy + inv[4] - 0.5;
      const v = inv[1] * cx + inv[3] * cy + inv[5] - 0.5;
      if (u <= -1 || v <= -1 || u >= w || v >= h) continue;
      const ix = Math.floor(u);
      const iy = Math.floor(v);
      const fx = u - ix;
      const fy = v - iy;
      const o = (y * outWidth + x) * 4;
      for (let c = 0; c < 4; c++) {
        const top = texel(ix, iy, c) * (1 - fx) + texel(ix + 1, iy, c) * fx;
        const bottom = texel(ix, iy + 1, c) * (1 - fx) + texel(ix + 1, iy + 1, c) * fx;
        out.data[o + c] = Math.round((top * (1 - fy) + bottom * fy) * opacity);
      }
    }
  }
  return out;
}
