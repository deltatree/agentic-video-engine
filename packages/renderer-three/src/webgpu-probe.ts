/**
 * WebGPU-Probe mit echtem Mini-Render (Politur P1).
 *
 * Ein Adapter allein reicht nicht: Ältere Chromium-Versionen liefern einen Adapter, lehnen aber
 * Deskriptoren ab, die Three.js nutzt (z. B. `swizzle: 'rgba'` in `GPUTextureViewDescriptor`, dort
 * noch als Objekt erwartet). Dann scheiterte erst der Render mit `OV_BROWSER_RENDER`. Die Probe
 * durchläuft deshalb denselben Pfad wie Three.js: Gerät, Textur, Textur-Ansicht mit dem
 * Deskriptor von Three.js, Render-Pass mit Löschfarbe und Rücklesen eines Pixels.
 *
 * Die Funktion ist in sich geschlossen (keine Verweise auf Modul-Variablen): Der Browser-Host
 * überträgt sie per `page.evaluate` in die Render-Seite. So nutzen Cache-Schlüssel (Grafik-Probe)
 * und Renderer (`backend: 'auto'`) dieselbe Prüfung.
 */

/** Ergebnis von {@link probeWebGPU}. */
export interface WebGPUProbe {
  /** Gelang der Mini-Render? Nur dann wählt `backend: 'auto'` WebGPU. */
  readonly available: boolean;
  /**
   * Beschreibung: Adapter (`<vendor> <architecture>` bzw. `adapter`), `unavailable` (keine API),
   * `no adapter` oder `<adapter> (unusable: <Grund>)`, wenn der Mini-Render scheitert.
   */
  readonly adapter: string;
  /**
   * Ist das Ergebnis stabil und darf gespeichert werden (Review M3)? `true` bei Erfolg, fehlender
   * API und unvollständiger API (`TypeError` aus der WebIDL-Prüfung, Validierungsfehler des
   * Deskriptors). `false` bei vorübergehenden Fehlern: kein Adapter (`null`), `OperationError`,
   * verlorenes Gerät, falsch zurückgelesene Pixel – dann wird beim nächsten Start neu geprüft.
   */
  readonly stable: boolean;
}

/**
 * Prüft WebGPU mit einem Mini-Render auf dem Pfad von Three.js. Läuft nur im Browser.
 *
 * @example
 * ```ts
 * const probe = await page.evaluate(probeWebGPU); // { available: false, adapter: 'google swiftshader (unusable: TypeError: …swizzle…)' }
 * ```
 */
export async function probeWebGPU(): Promise<WebGPUProbe> {
  const isGpu = (value: unknown): value is GPU => typeof value === 'object' && value !== null && 'requestAdapter' in value && typeof value.requestAdapter === 'function';
  const gpu: unknown = Reflect.get(navigator, 'gpu');
  if (!isGpu(gpu)) return { available: false, adapter: 'unavailable', stable: true };
  let adapter: GPUAdapter | null;
  try {
    adapter = await gpu.requestAdapter();
  } catch (error) {
    // Ein Fehler beim Anfordern heißt: jetzt kein WebGPU (vorübergehend, nicht speichern).
    if (!(error instanceof Error)) throw error;
    return { available: false, adapter: `no adapter (${error.name}: ${error.message})`, stable: false };
  }
  // Ohne Adapter (z. B. GPU-Prozess gerade abgestürzt): vorübergehend, nicht speichern.
  if (adapter === null) return { available: false, adapter: 'no adapter', stable: false };
  const info: unknown = Reflect.get(adapter, 'info');
  const field = (k: string): string => (typeof info === 'object' && info !== null ? String(Reflect.get(info, k) ?? '') : '');
  const name = `${field('vendor')} ${field('architecture')}`.trim() || 'adapter';
  let device: GPUDevice | undefined;
  try {
    device = await adapter.requestDevice();
    device.pushErrorScope('validation');
    // Konstanten der WebGPU-Spezifikation (TypeScripts DOM-Typen kennen die Namensräume nicht):
    // GPUTextureUsage RENDER_ATTACHMENT 0x10 | TEXTURE_BINDING 0x04 | COPY_SRC 0x01.
    const usage = 0x10 | 0x04 | 0x01;
    const texture = device.createTexture({ size: [4, 4], format: 'rgba8unorm', usage });
    // Deskriptor wie `GPUTextureViewDescriptor` aus three/webgpu (inklusive `swizzle`).
    const sampled: GPUTextureViewDescriptor & { readonly swizzle: string } = { label: '', dimension: '2d', aspect: 'all', baseMipLevel: 0, mipLevelCount: 1, baseArrayLayer: 0, usage: 0, swizzle: 'rgba' };
    texture.createView(sampled);
    const encoder = device.createCommandEncoder();
    const pass = encoder.beginRenderPass({ colorAttachments: [{ view: texture.createView(), clearValue: { r: 1, g: 0, b: 0, a: 1 }, loadOp: 'clear', storeOp: 'store' }] });
    pass.end();
    const buffer = device.createBuffer({ size: 256 * 4, usage: 0x08 | 0x01 }); // GPUBufferUsage COPY_DST | MAP_READ
    encoder.copyTextureToBuffer({ texture }, { buffer, bytesPerRow: 256 }, [4, 4]);
    device.queue.submit([encoder.finish()]);
    const validation = await device.popErrorScope();
    // Validierungsfehler des Deskriptors von Three.js: API unvollständig (stabil).
    if (validation !== null) return { available: false, adapter: `${name} (unusable: ${validation.message})`, stable: true };
    await buffer.mapAsync(0x1); // GPUMapMode.READ
    const pixel = Array.from(new Uint8Array(buffer.getMappedRange(0, 4)));
    buffer.unmap();
    const ok = pixel[0] === 255 && pixel[1] === 0 && pixel[2] === 0 && pixel[3] === 255;
    return ok ? { available: true, adapter: name, stable: true } : { available: false, adapter: `${name} (unusable: read back ${pixel.join(',')} instead of 255,0,0,255)`, stable: false };
  } catch (error) {
    // TypeError aus der WebIDL-Prüfung (z. B. `swizzle`): API unvollständig (stabil). Alles andere
    // (OperationError, verlorenes Gerät, AbortError …) ist vorübergehend.
    if (!(error instanceof Error)) throw error;
    return { available: false, adapter: `${name} (unusable: ${error.name}: ${error.message})`, stable: error.name === 'TypeError' };
  } finally {
    device?.destroy();
  }
}
