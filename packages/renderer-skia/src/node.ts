/**
 * Laden von CanvasKit in Node.js. Nur diese Datei nutzt Node-Module; der Renderer-Kern ist isomorph.
 * Browser-Nutzer laden CanvasKit selbst (`CanvasKitInit({ locateFile })`) und rufen diese Funktion nie auf.
 */
import type { CanvasKit } from 'canvaskit-wasm';

let cached: Promise<CanvasKit> | undefined;

/**
 * Lädt CanvasKit (`canvaskit-wasm` 0.42.0, Build `bin/full` mit Paragraph, Skottie und RuntimeEffect)
 * in Node. Mehrfache Aufrufe teilen sich eine Instanz.
 *
 * @example
 * ```ts
 * const ck = await loadCanvasKitNode();
 * const skia = createSkiaBackend({ canvasKit: ck, fonts });
 * ```
 */
export function loadCanvasKitNode(): Promise<CanvasKit> {
  cached ??= (async () => {
    const nodeModule = await import('node:module');
    const nodePath = await import('node:path');
    const require = nodeModule.createRequire(import.meta.url);
    const dir = nodePath.dirname(require.resolve('canvaskit-wasm/bin/full/canvaskit.js'));
    const mod = await import('canvaskit-wasm/full');
    return mod.default.default({ locateFile: (file: string) => nodePath.join(dir, file) });
  })();
  return cached;
}
