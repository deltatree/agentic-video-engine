---
title: 'Compositor, Color Management und Testwerkzeuge (Stories 2.4, 2.9)'
type: 'feature'
created: '2026-09-28'
status: 'ready-for-dev'
route: 'dispatch'
context:
  - '{project-root}/_bmad-output/implementation-artifacts/agent-rules.md'
  - '{project-root}/docs/reference/node-semantics.md'
  - '{project-root}/packages/core/src/contracts.ts'
  - '{project-root}/packages/core/src/props.ts'
  - '{project-root}/packages/core/src/plan.ts'
---

## Intent

**Problem:** Layer aus verschiedenen Renderern müssen mit Blend Modes, Masken, Effekten und explizitem Color Management zu einem Frame werden (FR-45..FR-47, NFR-12, AD-6). Tests brauchen Golden- und Pixel-Diff-Werkzeuge (NFR-5).

**Approach:** Reines TypeScript, plattformunabhängig (kein `node:` im Paket `compositor`). Rechnen in Float32 mit vormultipliziertem Alpha.

## Boundaries & Constraints

**Always:**
- Pakete: `packages/compositor`, `packages/testing`. Nichts anderes ändern.
- `compositor` hängt nur von `core` ab und nutzt keine Node-APIs (läuft auch im Studio-Browser).
- Transform exakt nach `localMatrix(node)` aus core, Pixelmitten-Sampling, bilinear.

**Never:** Keine GPU, kein Canvas, keine externe Bildbibliothek.

## Anforderungen

### compositor

API (Namen verbindlich, Details frei):

```ts
export type CompositorNode =
  | { kind: 'image'; image: RgbaImage }
  | { kind: 'group'; node: EvaluatedNode; children: CompositorNode[]; mask?: { image: RgbaImage; mode: 'alpha' | 'luminance'; invert: boolean } };

export interface CompositeInput {
  width: number; height: number; scale: number;          // Ausgabegröße und Vorschau-Skalierung
  background: string;                                     // '#RRGGBB[AA]' oder 'transparent'
  workingSpace: 'srgb' | 'linear' | 'rec709';            // Blend-Raum
  outputSpace?: 'srgb' | 'rec709';                        // Transferfunktion der Ausgabe (Standard srgb)
  layers: CompositorNode[];
  frame: number;                                          // für Grain-Seed
  seed: number;
  resolveLut?: (assetId: string) => Lut | undefined;
  effects?: ReadonlyMap<string, EffectDefinition>;       // Plugin-Effekte aus core Registry
}
export function compositeFrame(input: CompositeInput): RgbaImage;
export function accumulateFrames(images: RgbaImage[]): RgbaImage;  // Motion Blur: Mittel im linearen, vormultiplizierten Raum
export function parseCubeLut(text: string): Lut;                   // Adobe .cube 1D/3D
export function convertColorSpace(image: RgbaImage, from: ColorSpace, to: ColorSpace): RgbaImage;
export function applyLayerEffects(...), blendPixel(...), BLEND_FUNCTIONS
```

- `group`-Knoten: Kinder in Offscreen komponieren → `effects` der Node (Typen aus `LayerEffect`: blur, color-grade, lut, glow, vignette, grain, chromatic-aberration, color-matrix; unbekannte Typen über `effects`-Map, sonst Diagnose/Fehler `OV_EFFECT_UNKNOWN`) → `crop` → Maske → Transform (`localMatrix(node)`, mit `scale`) → `opacity` → `blendMode` auf das Ziel.
- Alle 17 Blend Modes nach W3C Compositing and Blending Level 1 (separabel und nicht-separabel: hue, saturation, color, luminosity), `add` = linear dodge. In `linear` wird vor dem Mischen linearisiert und danach zurückkodiert.
- `color-grade`: exposure (Blenden), contrast (um 0.18 linear), saturation, temperature/tint, lift/gamma/gain (ASC-CDL-artig). Formeln in TSDoc dokumentieren.
- `blur`: separabler Gauß, `radius` = Standardabweichung, Kernel ±3σ, Randbehandlung transparent.
- `grain`: Rauschen aus `random(seed, frame, x, y)`, deterministisch.
- Alpha bleibt erhalten: transparenter Hintergrund + halbtransparenter Layer → Ausgabe halbtransparent.
- Performance: 1920×1080, drei Layer, `normal` → unter 150 ms auf dieser Maschine (Test mit großzügiger Grenze 600 ms).

### testing

- `compareImages(actual, expected, { maxChannelDelta = 2, maxDiffRatio = 0.001 }) → { pass, diffPixels, maxDelta, diffImage }`.
- `expectGolden(image, goldenPath)`: vergleicht mit PNG-Datei; mit `UPDATE_GOLDENS=1` schreibt es die Datei neu. Bei Fehlschlag schreibt es `<name>.actual.png` und `<name>.diff.png` neben das Golden.
- `imageHash(image)` (sha256), `solidImage(w, h, color)`, `checkerImage(...)`.
- Audio-Analyse (reine Funktionen auf `Float32Array` je Kanal): `rms`, `peak`, `integratedLoudness` (ITU-R BS.1770-4, K-Filter, Gating, LUFS), `findOnsets(samples, sampleRate, threshold)` für Sync-Tests.
- `determinism(fn, frames)`: rendert Frames vorwärts und rückwärts, vergleicht Hashes.

## Tasks & Acceptance

**Acceptance Criteria:**
- Given jeder Blend Mode, when zwei Testfarben gemischt, then stimmt das Ergebnis mit der W3C-Formel überein (Tabelle im Test, ±1).
- Given `srgb` vs. `linear`, when 50 % Weiß über Schwarz mit `normal`, then ergibt sRGB 128 (±1) und linear 188 (±1).
- Given Maske alpha/luminance/invert, when angewendet, then passen Pixelwerte.
- Given Gruppe mit Rotation 90° und Origin Mitte, when komponiert, then liegt das Bild an der erwarteten Stelle.
- Given halbtransparenter Layer auf transparentem Hintergrund, then Alpha 128 ±1.
- Given `.cube`-Datei (Identität und Invertierung), then LUT wirkt korrekt.
- Given 1 kHz-Sinus −20 dBFS Stereo 48 kHz, when `integratedLoudness`, then ≈ −20 LUFS ±0.5 (bekannter Referenzfall laut BS.1770: 0 dBFS Sinus 997 Hz → −3.01 LUFS pro Kanal-Summe).

## Verification

- `npx tsc -b packages/compositor packages/testing`
- `npx vitest run packages/compositor packages/testing`
- `npx eslint packages/compositor packages/testing --max-warnings 0`
