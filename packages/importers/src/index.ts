/**
 * @packageDocumentation
 * Importe offener Formate in die OpenVideo-IR (FR-85): SVG, Lottie, glTF und HTML/CSS.
 * Alle Importer sind reine Umwandler. Jeder Informationsverlust erzeugt eine Diagnose
 * `OV_IMPORT_LOSSY` (Schweregrad `warning`) mit Pfad und Vorschlag.
 *
 * @example
 * ```ts
 * import { importSvg } from '@agentic-video/importers';
 * const { nodes, assets, diagnostics } = importSvg(markup, { idPrefix: 'logo' });
 * ```
 */
export { LOSSY_CODE, parseDataUri, type ImportedAsset, type JsonNode, type NodeImportResult } from './common.js';
export { importSvg, type SvgImportOptions } from './svg.js';
export { importLottie, type LottieImportOptions } from './lottie.js';
export { importGltf, readGlbJson, type GltfClip, type GltfImportOptions, type GltfImportResult } from './gltf.js';
export { importHtml, type HtmlImportOptions } from './html.js';
