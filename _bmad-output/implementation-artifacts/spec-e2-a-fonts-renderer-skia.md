---
title: 'Fonts und Skia-Renderer (Stories 2.1, 2.2, 2.3, 3.5, 4.3, 4.4)'
type: 'feature'
created: '2026-09-28'
status: 'ready-for-dev'
route: 'dispatch'
context:
  - '{project-root}/_bmad-output/implementation-artifacts/agent-rules.md'
  - '{project-root}/docs/reference/node-semantics.md'
  - '{project-root}/packages/core/src/contracts.ts'
  - '{project-root}/packages/core/src/semantics.ts'
  - '{project-root}/packages/core/src/props.ts'
---

## Intent

**Problem:** OpenVideo braucht einen hochwertigen, deterministischen 2D- und Text-Renderer, der in Node und im Browser läuft (FR-28..FR-35, FR-27, FR-32).

**Approach:** Paket `fonts` lädt und hasht Schriften. Paket `renderer-skia` implementiert `RenderBackend` (id `skia`) auf CanvasKit (`canvaskit-wasm` 0.42.0, Build `bin/full`: Paragraph, Skottie, RuntimeEffect).

## Boundaries & Constraints

**Always:**
- Pakete: `packages/fonts`, `packages/renderer-skia`. Nichts anderes ändern.
- `renderer-skia` ist isomorph: Der Renderer-Kern nutzt keine Node-APIs. Nur eine separate Datei `src/node.ts` (Export `loadCanvasKitNode()`) darf `node:`-Module nutzen; der Paket-Einstieg exportiert beides, Browser-Nutzer importieren nichts aus `node.ts`.
- Semantik exakt nach `docs/reference/node-semantics.md` und den Funktionen aus `@agentic-video/core` (`localMatrix`, `getTransform`, `effectiveFill`, `revealShape`, `particles2d`, `textUnitState`, `splitTextUnits`, `pointAtProgress`).
- Ausgabe: `RgbaImage` vormultipliziert, sRGB, Größe `request.width × request.height`, `scale` vorangestellt.
- Deterministisch: gleiche Eingabe → bitgleiche Pixel (Test: zweimal rendern, Hash vergleichen).

**Never:** Keine Systemschriften automatisch laden (Determinismus). Kein Browser/Chromium in diesem Paket.

## Anforderungen

### fonts
- Bündle Standardschriften unter `packages/fonts/assets/` mit OFL-Lizenzdatei: **Inter** (variabel, rsms/inter), **JetBrains Mono** (variabel oder Regular/Bold), **Noto Color Emoji** (googlefonts/noto-emoji). Lade sie aus den offiziellen GitHub-Releases/Repos herunter (Netz ist verfügbar). Prüfe Lizenzen (SIL OFL 1.1).
- `loadFontSet(options: { projectDir?: string; fonts?: IrFont[]; resolveAsset?: (id) => Promise<{ path: string; bytes: Uint8Array }> ; includeDefaults?: boolean })` → `FontSet` implementiert `FontResolver` aus core, dazu `faces()`, `families()`, `diagnostics`.
- Jede Schrift wird geparst (Tabellen `name`, `fvar`, `OS/2` genug für Familie, Gewicht, Stil, variable Achsen) und gehasht (`contentHash` aus core). Fehlende Dateien und ungültige Schriften → Diagnose `OV_FONT_MISSING` / `OV_FONT_INVALID` mit Vorschlag.
- `checkFontUsage(project, fontSet)` → Diagnosen für Text-Nodes, deren `fontFamily` nicht geladen ist (`OV_FONT_MISSING`, Vorschlag: ähnlichster Name oder `project.fonts` ergänzen).
- `fontManifest(fontSet)` → `{ family, weight, style, hash, path }[]` für das Render-Manifest.

### renderer-skia
- `createSkiaBackend(options: { canvasKit, fonts: FontResolver, defaultFont?: string })` → `RenderBackend` mit `id: 'skia'`, `fusable: true`, `nodeTypes` = alle 2D-Typen, `capabilities` (z. B. `skia.text.shaping`, `skia.text.variable-fonts`, `skia.lottie`, `skia.sksl`, `skia.blend.all`), `versions()` → `{ 'canvaskit-wasm': '0.42.0' }`.
- Rendert alle 2D-Node-Typen: group (inkl. `clip`), rect (inkl. Eckenradien), ellipse, line, polyline, polygon, path (inkl. `fillRule`, Trim), text, rich-text, image, video (über `assets.videoFrame`), svg, sprite, lottie (Skottie, frame-genau), shader (SkSL-RuntimeEffect mit Uniforms `time`, `frame`, `resolution` + eigene), particles.
- Paint: Farben, lineare/radiale/konische Verläufe, Kontur (Breite, Cap, Join, Dash), Schatten, Filter (blur, brightness, contrast, saturate, grayscale, sepia, invert, hue-rotate, color-matrix), alle 17 Blend Modes, Opacity als Gruppe (saveLayer), Maske (alpha/luminance/invert, Masken-Node im lokalen Raum), Reveal-Clips.
- **SVG:** eigener kleiner SVG-Parser (Elemente `svg`, `g`, `path`, `rect`, `circle`, `ellipse`, `line`, `polyline`, `polygon`, `text` einfach, `linearGradient`, `radialGradient`, `defs`/`use`; Attribute `transform`, `fill`, `stroke`, `stroke-width`, `opacity`, `fill-opacity`, `stroke-opacity`, `fill-rule`, `viewBox`, `style`-Attribut). Nicht unterstützte Elemente → Diagnose `OV_SVG_UNSUPPORTED` in `check()`. Exportiere den Parser (`parseSvg(markup) → SvgDocument`) für spätere SVG-Importe.
- Typografie über CanvasKit Paragraph/TypefaceFontProvider: Kerning, Ligaturen, `fontFeatures`, `fontVariations`, `letterSpacing`, `lineHeight`, `textAlign`, `direction`, Umbruch bei `width`, `maxLines`, `ellipsis`, Emoji-Fallback, Verlaufsfüllung, Kontur, Text entlang Pfad (`textPath`), `textAnimation` pro Zeichen/Wort/Zeile.
- `createSkiaTextMeasurer(canvasKit, fonts)` implementiert `TextMeasurer` (Breite, Höhe, Zeilen, Überlauf, fehlende Glyphen, Baseline).
- Debug-Overlays (FR-27): `renderDebugOverlay(canvasKit, fonts, scene, bounds, options: DebugOptions, size)` zeichnet Bounds, Anchors (Origin-Punkte), Safe Areas, Baselines, Grid (100 px), Node-IDs. `showCameraFrustum`/`showLightHelpers` gehören zum 3D-Renderer; hier nur ignorieren.
- Kontaktbogen: `renderContactSheet(canvasKit, fonts, frames: { image: RgbaImage; label: string }[], options: { columns; cellWidth; background })` → `RgbaImage` mit Beschriftung unter jedem Bild.
- Hilfen: `decodeImage(canvasKit, bytes) → RgbaImage` (PNG/JPEG/WebP/GIF erstes Bild), `encodePngSkia` nicht nötig (Paket `png` existiert).
- `check(node)`: meldet nicht unterstützte Features (z. B. `shader` nur mit `glsl` → `OV_SKIA_UNSUPPORTED`, Vorschlag `sksl` angeben oder `renderer: "pixi"`).

## I/O & Edge-Case Matrix

| Scenario | Input | Expected |
|---|---|---|
| Leerer Layer | keine Nodes | transparentes Bild |
| Halbtransparentes Rechteck | rect fill `#FF000080` | Pixel (128, 0, 0, 128) vormultipliziert ±1 |
| Vorschau | scale 0.5 | Bild halb so groß, Inhalt skaliert |
| Fehlende Schrift | fontFamily `Nope` | Rendert mit Standardschrift, `check` liefert Diagnose |
| Unbekanntes Asset | image asset `x` fehlt | `OpenVideoError` `OV_ASSET_MISSING` |

## Tasks & Acceptance

**Acceptance Criteria:**
- Given jede Node-Art und jeder Effekt aus den Anforderungen, when gerendert, then existiert ein Golden-Test (visuell geprüft) in `packages/renderer-skia/test/golden/`.
- Given dieselbe Szene zweimal (auch in umgekehrter Frame-Reihenfolge), when gerendert, then sind die Hashes gleich.
- Given ein Text mit `ffi`, Hebräisch und Emoji, when gerendert, then zeigt das Golden Ligatur, RTL und farbiges Emoji.
- Given `textAnimation` mit `unit: 'char'`, when Frame 0, Mitte, Ende gerendert, then bewegen sich Zeichen versetzt.
- Given eine Lottie-Datei (lege eine kleine, selbst geschriebene Lottie-JSON als Testdatei an), when Frame n gerendert, then ist das Ergebnis frame-genau und deterministisch.
- Test-Assets erzeugst du selbst (z. B. PNG über das `png`-Paket, Testvideo über FFmpeg im Test, falls nötig).

## Verification

- `npx tsc -b packages/fonts packages/renderer-skia` — grün
- `npx vitest run packages/fonts packages/renderer-skia` — grün
- `npx eslint packages/fonts packages/renderer-skia --max-warnings 0` — grün
