/**
 * Texturgrenzen der GPU (Auftrag §40): Bildtexturen werden gegen `MAX_TEXTURE_SIZE` (WebGL2) bzw.
 * `maxTextureDimension2D` (WebGPU) geprüft. Zu große Texturen sind ein Fehler mit konkreten
 * Vorschlägen, oder werden auf Wunsch (`textureDownscale`) seitenverhältnistreu verkleinert.
 */
import { OpenVideoError } from '@agentic-video/core';

/** Kontext einer Texturverwendung für Prüfung und Fehlermeldung. */
export interface TextureUse {
  /** Größte erlaubte Kantenlänge in Pixeln. */
  readonly maxSize: number;
  /** Zu große Texturen verkleinern statt abzubrechen. */
  readonly downscale: boolean;
  /** Node, deren Material die Textur nutzt. */
  readonly nodeId: string;
  /** Composition-Frame des Renderaufrufs. */
  readonly frame: number;
  /** Asset-ID der Textur. */
  readonly assetId: string;
}

/**
 * Zielgröße einer Textur, deren längste Kante höchstens `maxSize` ist (Seitenverhältnis bleibt,
 * Kanten mindestens 1 px). Passt sie schon, kommt die Eingabe zurück.
 *
 * @example
 * ```ts
 * fitTextureSize(16384, 8192, 8192); // { width: 8192, height: 4096 }
 * ```
 */
export function fitTextureSize(width: number, height: number, maxSize: number): { readonly width: number; readonly height: number } {
  if (width <= maxSize && height <= maxSize) return { width, height };
  const k = maxSize / Math.max(width, height);
  return { width: Math.max(1, Math.min(maxSize, Math.floor(width * k))), height: Math.max(1, Math.min(maxSize, Math.floor(height * k))) };
}

/**
 * Fehler für eine Textur über dem GPU-Maximum, im Format aus Auftrag §40.
 *
 * @example
 * ```ts
 * throw textureTooLargeError({ maxSize: 8192, downscale: false, nodeId: 'product-model', frame: 184, assetId: 'hero-texture.png' }, 16384, 16384);
 * ```
 */
export function textureTooLargeError(use: TextureUse, width: number, height: number): OpenVideoError {
  const max = use.maxSize;
  return new OpenVideoError({
    code: 'OV_THREE_TEXTURE_TOO_LARGE',
    errorClass: 'ThreeRendererError',
    problem: 'The selected texture exceeds the GPU maximum texture size.',
    nodeId: use.nodeId,
    frame: use.frame,
    // Schlüssel und Werte ergeben mit `formatDiagnostic` die Blöcke „Asset:“ und „GPU maximum:“ aus §40.
    details: { Asset: `${use.assetId}\n${String(width)} × ${String(height)}`, 'GPU maximum': `${String(max)} × ${String(max)}` },
    suggestions: [
      `Resize the asset to <= ${String(max)} px.`,
      'Enable automatic texture downscaling: set textureDownscale: true on the scene3d node (or ThreeLayerRenderer option downscaleTextures).',
      'Use the Blender backend.',
    ],
  });
}
