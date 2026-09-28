/**
 * @packageDocumentation
 * Skia-Renderer von OpenVideo: 2D-Formen, Typografie, Medien, Lottie, SkSL-Shader
 * und Partikel auf CanvasKit. Läuft in Node und im Browser (`loadCanvasKitNode` nur in Node).
 *
 * @example
 * ```ts
 * import { createSkiaBackend, loadCanvasKitNode } from '@agentic-video/renderer-skia';
 * const skia = createSkiaBackend({ canvasKit: await loadCanvasKitNode(), fonts });
 * const layer = await skia.renderLayer(request);
 * ```
 */
export { createSkiaBackend, CANVASKIT_VERSION, SKIA_CAPABILITIES, SKIA_NODE_TYPES, type SkiaBackendOptions } from './backend.js';
export { createSkiaTextMeasurer, detectDirection, TextEngine, type TextLayout } from './text.js';
export { renderDebugOverlay, renderContactSheet, drawDebugOverlay, DEBUG_GRID_SIZE, type ContactSheetOptions } from './debug.js';
export { decodeImage, imageFromRgba } from './image.js';
export { parseSvg, parseSvgTransform, svgColor, svgLength, svgNumbers, SUPPORTED_SVG_ELEMENTS, type SvgDocument, type SvgElement, type SvgMatrix } from './svg.js';
export { fitRect } from './draw.js';
export { filterMatrix } from './paint.js';
export { loadCanvasKitNode } from './node.js';
