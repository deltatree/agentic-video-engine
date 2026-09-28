---
title: 'Three.js- und PixiJS-Seitenbibliotheken (Stories 6.3, 7.1–7.5)'
type: 'feature'
created: '2026-09-28'
status: 'ready-for-dev'
route: 'dispatch'
context:
  - '{project-root}/_bmad-output/implementation-artifacts/agent-rules.md'
  - '{project-root}/docs/reference/node-semantics.md'
  - '{project-root}/packages/core/src/contracts.ts'
  - '{project-root}/packages/core/src/semantics.ts'
  - '{project-root}/packages/schema/src/nodes.ts'
---

## Intent

**Problem:** OpenVideo braucht einen Echtzeit-3D-Renderer (Three.js, FR-38..FR-42) und einen GPU-2D-Renderer (PixiJS, FR-31). Beide laufen im Browser (Chromium-Render-Host und Studio).

**Approach:** Zwei **Browser-Bibliotheken** ohne Node-APIs. Sie bauen aus Evaluated Nodes eine Three.js- bzw. PixiJS-Szene und rendern auf ein Canvas. Den Chromium-Host (Playwright, HTTP-Origin, Pixel-Rückkanal) baut eine andere Story im Paket `renderer-browser`; er ruft genau die unten definierte API auf.

## Boundaries & Constraints

**Always:**
- Pakete: `packages/renderer-three`, `packages/renderer-pixi`. Nichts anderes ändern.
- Keine Node-APIs im Paket-Quellcode. Tests dürfen Node, esbuild und Playwright nutzen (beide liegen in `node_modules`): bündle einen Test-Einstieg mit esbuild, liefere ihn über einen lokalen `node:http`-Server aus (HTTP-Origin, nötig für WebGPU) und rendere in Chromium mit SwiftShader-Flags (siehe agent-rules). Pixel über `canvas` → 2D-`getImageData` zurück nach Node.
- Zeit kommt nur aus dem Input (`time`, `frame`). Kein `requestAnimationFrame`, keine Uhr. AnimationMixer über `setTime`. Partikel zustandslos.
- Ergebnis ist deterministisch: zweimal rendern in frischen Browsern → bitgleich (Probelauf zeigte das für Three WebGL/WebGPU und Pixi).

## Verbindliche API

```ts
// renderer-three
export interface ThreeLayerInput {
  node: EvaluatedNode;            // type 'scene3d'
  width: number; height: number;  // Box der Szene in Composition-Pixeln
  scale: number;                  // Vorschau-Skalierung
  frame: number; time: number; fps: number; seed: number;
  assetUrl: (assetId: string) => string;   // URL auf der Host-Origin
  debug?: { showCameraFrustum?: boolean; showLightHelpers?: boolean };
}
export class ThreeLayerRenderer {
  constructor(options?: { preferredBackend?: 'auto' | 'webgpu' | 'webgl2' });
  render(input: ThreeLayerInput): Promise<HTMLCanvasElement>;  // Canvas width*scale × height*scale, transparent
  readonly activeBackend: 'webgpu' | 'webgl2' | undefined;
  dispose(): void;
}
export function checkThreeNode(node: Readonly<Record<string, unknown>>): Diagnostic[];
export const THREE_CAPABILITIES: readonly string[];  // z. B. 'three.webgl2', 'three.webgpu', 'three.gltf', 'three.postprocessing.bloom' …
export const THREE_VERSION: string;

// renderer-pixi
export interface PixiLayerInput {
  nodes: readonly EvaluatedNode[]; width: number; height: number; scale: number;
  frame: number; time: number; fps: number; seed: number;
  assetUrl: (assetId: string) => string;
  videoFrame: (assetId: string, seconds: number) => Promise<ImageBitmap | HTMLCanvasElement>;
  defaultFont: string;
}
export class PixiLayerRenderer {
  render(input: PixiLayerInput): Promise<HTMLCanvasElement>;   // Canvas width*scale × height*scale
  dispose(): void;
}
export function checkPixiNode(node: Readonly<Record<string, unknown>>): Diagnostic[];
export const PIXI_CAPABILITIES: readonly string[];
export const PIXI_VERSION: string;
```

## Anforderungen

### renderer-three (FR-38..FR-42)
- Kameras perspective/orthographic (`fov`, `near`, `far`, `zoom`, `target`), erste Kamera als Standard (siehe Semantik-Doku).
- Lichter ambient, directional, point, spot, hemisphere mit Schatten (`castShadow`, `receiveShadow`, `shadows` an der Szene).
- Meshes mit allen Geometrien aus `Geometry`, Materialien standard/physical/basic/shader (`vertexShader`, `fragmentShader`, animierbare `uniforms` plus `time`), Texturen über `assetUrl` (map, normalMap, roughnessMap).
- Modelle: glTF/GLB (GLTFLoader), OBJ (OBJLoader); Animation Clips frame-genau (`AnimationMixer.setTime(offset + localTime · speed)`, `loop`), Skelett-Animation, Morph Targets (`morphTargets` nach Name). Geladene Modelle pro URL zwischenspeichern (Geometry Cache).
- `instances3d` (InstancedMesh, Layouts grid/random-box/random-sphere/explicit mit Seed aus `random` von core, `spin`).
- `particles3d` zustandslos (Formel analog `particles2d`, in 3D; additive Blending optional).
- Environment: `preset` (studio/neutral/sunset über RoomEnvironment bzw. prozedurale Umgebung), `hdri` (RGBELoader/EXRLoader nach Dateiendung), `showBackground`; Nebel; Tone Mapping (none/aces/agx/neutral).
- Postprocessing (WebGL2: EffectComposer; WebGPU: TSL-PostProcessing, soweit verfügbar): Bloom, Depth of Field, Color Grading (exposure/contrast/saturation; LUT über `assetUrl` als .cube), Vignette. Motion Blur übernimmt der Compositor (Zeit-Supersampling) → hier nicht nötig, aber als Capability `three.motion-blur.temporal` dokumentieren.
- Reflexionen: `envMapIntensity`, `metalness`/`roughness` mit Environment (Capability `three.reflections.envmap`).
- Transparenter Hintergrund, wenn `background` fehlt.
- Backend-Wahl: Node-Property `backend` (`auto` = WebGPU bevorzugt, WebGL2 Rückfall). `checkThreeNode` meldet WebGPU-only-Features unter `webgl2` (`OV_THREE_BACKEND_FEATURE`) und nicht unterstützte Kombinationen (z. B. Postprocessing-Effekt, der unter WebGPU fehlt).
- Debug: Kamera-Frustum und Light-Helper (FR-27) bei `debug`.

### renderer-pixi (FR-31)
- Rendert dieselben 2D-Nodes wie Skia, soweit PixiJS es kann: group (inkl. clip), rect, ellipse, line, polyline, polygon, path (`Graphics.svg`/eigener Pfad-Parser), text (PixiJS `Text` mit CSS-Schrift `defaultFont`), image, video (über `videoFrame`), sprite, shader (nur `glsl`), particles (`particles2d` aus core); Paint: Farben, lineare/radiale Verläufe (FillGradient), Kontur, Opacity, Blend Modes (Pixi-Teilmenge), Filter blur/color-matrix, Masken (alpha), Reveal-Clips.
- Alles, was fehlt (z. B. `textPath`, `lottie`, SkSL, konische Verläufe, einige Blend Modes), meldet `checkPixiNode` als `OV_PIXI_UNSUPPORTED` mit Vorschlag „renderer: 'skia'“. `PIXI_CAPABILITIES` listet Unterstütztes.
- Semantik exakt wie Skia (Transform über `localMatrix` aus core).

## Tasks & Acceptance

**Acceptance Criteria:**
- Golden-Tests (visuell geprüft) für: jede Geometrie, jedes Licht, Schatten, PBR, glTF-Modell mit Animation (erzeuge ein kleines glTF im Test, z. B. per GLTFExporter oder als handgeschriebene JSON), Morph Target, Instancing, Partikel, Bloom, DoF, Color Grading, Nebel, transparenter Hintergrund, WebGPU und WebGL2 je einmal.
- Frame-Genauigkeit: Animation Clip bei Frame n in frischem Browser gleich wie nach Frames 0..n (Hash).
- Pixi: Golden je Node-Typ; Pixel-Diff gegen eine Referenz ist nicht verlangt (Skia rendert in anderer Story).
- `checkThreeNode`/`checkPixiNode` haben Tests für jede Einschränkung.

## Verification

- `npx tsc -b packages/renderer-three packages/renderer-pixi`
- `npx vitest run packages/renderer-three packages/renderer-pixi`
- `npx eslint packages/renderer-three packages/renderer-pixi --max-warnings 0`
