/**
 * Umwandlung zwischen `RgbaImage` und CanvasKit-Bildern.
 */
import type { CanvasKit, Image, ImageInfo, Surface } from 'canvaskit-wasm';
import { OpenVideoError, type RgbaImage } from '@agentic-video/core';
import { nullable } from './scope.js';

/**
 * Bildformat aller Ausgaben: RGBA 8 Bit, vormultipliziert, sRGB.
 *
 * @example
 * ```ts
 * const pixels = image.readPixels(0, 0, rgbaInfo(ck, image.width(), image.height()));
 * ```
 */
export function rgbaInfo(ck: CanvasKit, width: number, height: number): ImageInfo {
  return { width, height, colorType: ck.ColorType.RGBA_8888, alphaType: ck.AlphaType.Premul, colorSpace: ck.ColorSpace.SRGB };
}

/**
 * Macht aus einem `RgbaImage` ein CanvasKit-Bild. Der Aufrufer gibt es mit `delete()` frei.
 *
 * @example
 * ```ts
 * const img = imageFromRgba(ck, frame);
 * canvas.drawImage(img, 0, 0);
 * img.delete();
 * ```
 */
export function imageFromRgba(ck: CanvasKit, image: RgbaImage): Image {
  const img = nullable(ck.MakeImage(rgbaInfo(ck, image.width, image.height), image.data, image.width * 4));
  if (img === null) {
    throw new OpenVideoError({ code: 'OV_IMAGE_INVALID', errorClass: 'ImageError', problem: `Cannot create a ${String(image.width)}x${String(image.height)} image from RGBA data.`, details: { bytes: image.data.byteLength }, suggestions: ['Pass width × height × 4 bytes of premultiplied RGBA data.'] });
  }
  return img;
}

/**
 * Liest ein CanvasKit-Bild als vormultipliziertes sRGB-RGBA.
 *
 * @example
 * ```ts
 * const rgba = rgbaFromImage(ck, surface.makeImageSnapshot());
 * ```
 */
export function rgbaFromImage(ck: CanvasKit, img: Image): RgbaImage {
  const width = img.width();
  const height = img.height();
  const pixels = img.readPixels(0, 0, rgbaInfo(ck, width, height));
  if (!(pixels instanceof Uint8Array)) {
    throw new OpenVideoError({ code: 'OV_SKIA_READBACK', errorClass: 'SkiaRendererError', problem: 'Reading pixels from the Skia image failed.', suggestions: ['Check that width and height are positive and fit into memory.'] });
  }
  return { width, height, data: new Uint8Array(pixels) };
}

/**
 * Liest die Pixel einer Surface.
 *
 * @example
 * ```ts
 * const layer = rgbaFromSurface(ck, surface);
 * ```
 */
export function rgbaFromSurface(ck: CanvasKit, surface: Surface): RgbaImage {
  surface.flush();
  const snapshot = surface.makeImageSnapshot();
  try {
    return rgbaFromImage(ck, snapshot);
  } finally {
    snapshot.delete();
  }
}

/**
 * Erzeugt eine Raster-Surface; wirft `OV_SKIA_SURFACE`, wenn das nicht geht.
 *
 * @example
 * ```ts
 * const surface = makeSurface(ck, 1920, 1080);
 * ```
 */
export function makeSurface(ck: CanvasKit, width: number, height: number): Surface {
  const surface = Number.isInteger(width) && Number.isInteger(height) && width > 0 && height > 0 ? nullable(ck.MakeSurface(width, height)) : null;
  if (surface === null) {
    throw new OpenVideoError({
      code: 'OV_SKIA_SURFACE',
      errorClass: 'SkiaRendererError',
      problem: `Cannot create a ${String(width)}x${String(height)} raster surface.`,
      details: { width, height },
      suggestions: ['Use positive integer sizes.', 'Render at a smaller preview scale if memory is short.'],
    });
  }
  return surface;
}

/**
 * Dekodiert PNG, JPEG, WebP oder GIF (erstes Bild) in ein vormultipliziertes `RgbaImage`.
 *
 * @example
 * ```ts
 * const image = decodeImage(ck, readFileSync('logo.png'));
 * ```
 */
export function decodeImage(canvasKit: CanvasKit, bytes: Uint8Array): RgbaImage {
  const img = nullable(canvasKit.MakeImageFromEncoded(bytes));
  if (img === null) {
    throw new OpenVideoError({
      code: 'OV_IMAGE_DECODE',
      errorClass: 'ImageError',
      problem: 'The image data cannot be decoded.',
      details: { bytes: bytes.byteLength },
      suggestions: ['Use PNG, JPEG, WebP or GIF.', 'Check that the file is not truncated.'],
    });
  }
  try {
    return rgbaFromImage(canvasKit, img);
  } finally {
    img.delete();
  }
}
