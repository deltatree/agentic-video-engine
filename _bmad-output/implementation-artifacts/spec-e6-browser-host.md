---
title: 'Chromium-Render-Host und HTML/CSS-Layer (Stories 6.1, 6.2)'
type: 'feature'
created: '2026-09-28'
status: 'ready-for-dev'
route: 'dispatch'
context:
  - '{project-root}/_bmad-output/implementation-artifacts/agent-rules.md'
  - '{project-root}/docs/reference/node-semantics.md'
  - '{project-root}/packages/core/src/contracts.ts'
  - '{project-root}/_bmad-output/implementation-artifacts/spec-e6-e7-three-pixi.md'
  - '{project-root}/_bmad-output/planning-artifacts/research/technical-research.md'
---

## Intent

**Problem:** HTML/CSS/SVG/Canvas/WebGL/WebGPU-Inhalte, PixiJS und Three.js brauchen einen deterministischen Browser-Host (FR-36, FR-37, AD-13).

**Approach:** Paket `renderer-browser`: startet Chromium über `playwright-core`, liefert eine gebündelte Seiten-Laufzeit von einer lokalen HTTP-Origin aus, virtualisiert Zeit und Zufall, blockiert Netz, und stellt drei `RenderBackend`s bereit: `browser` (html-Nodes), `three` (scene3d-Nodes) und `pixi` (2D-Nodes).

## Boundaries & Constraints

**Always:**
- Paket: `packages/renderer-browser`. Nichts anderes ändern.
- Die Pakete `renderer-three` und `renderer-pixi` entstehen **parallel** in einer anderen Story mit der API aus `spec-e6-e7-three-pixi.md`. Importiere in der Seiten-Laufzeit nur diese API (`ThreeLayerRenderer`, `PixiLayerRenderer`, `checkThreeNode`, `checkPixiNode`, Konstanten). Solange sie fehlen, baue und teste zuerst Host und `browser`-Backend; die Three/Pixi-Backends schreibst du gegen die API. Ihre Integrationstests müssen am Ende laufen – warte notfalls, prüfe mit `ls packages/renderer-three/src` ob sie existieren, und wiederhole.
- Seiten-Laufzeit liegt in `src/runtime/` und wird mit esbuild (Node-API im Skript `scripts/build-runtime.mjs`, Script `build:extra` in `package.json` des Pakets anlegen – das ist erlaubt) nach `dist/runtime.js` gebündelt. Der Node-Teil liest diese Datei zur Laufzeit. Tests bauen sie vorher (globalSetup oder beforeAll).
- `playwright-core` findet Chromium über `chromium.executablePath()`; Option `executablePath` und Umgebungsvariable `OPENVIDEO_CHROMIUM` überschreiben.
- Chromium-Flags: `--use-angle=swiftshader --enable-unsafe-swiftshader --enable-unsafe-webgpu --font-render-hinting=none --disable-lcd-text --force-color-profile=srgb --disable-gpu-rasterization --deterministic-mode` (nur Flags, die Chromium 153 kennt; prüfe), dazu `--disable-background-networking` usw.
- Netz: `context.route('**/*')` erlaubt nur die eigene Origin; alles andere `abort()`. Zusätzlich Service Worker sperren.

## Anforderungen

- `createBrowserHost(options: { executablePath?; assets: AssetResolver; fonts: FontResolver; width; height; } ) → BrowserHost` mit `render(kind, payload)`, `close()`. Ein Host hält einen Browser und eine Seite pro Ausgabegröße; wiederverwendbar über viele Frames.
- HTTP-Server (`node:http`, 127.0.0.1, zufälliger Port, zufälliges Pfad-Token gegen fremde Seiten): `/runtime.js`, `/index.html`, `/assets/<id>` (Bytes aus `AssetResolver`, korrekter MIME-Typ), `/fonts.css` (`@font-face` für alle Faces aus `FontResolver`, Dateien unter `/fonts/<hash>`), `POST /frame/<id>` (Pixel-Rückkanal: Rohbytes RGBA).
- Virtuelle Zeit per `addInitScript`: `Date`, `Date.now`, `performance.now`, `requestAnimationFrame`/`cancelAnimationFrame`, `setTimeout`/`setInterval` (virtuelle Warteschlange, beim Setzen der Zeit ausgeführt, begrenzte Iterationen), `Math.random` (seeded pro Frame aus `random` von core-Logik; kopiere nicht core in die Seite, sondern bündle die benötigte Funktion aus `@agentic-video/core` mit esbuild).
- `window.openvideo` in HTML-Layern: `{ frame, time, fps, progress, onFrame(cb) }`. `onFrame`-Callbacks laufen synchron pro Frame vor der Aufnahme.
- HTML-Layer (`browser`-Backend): Für jede `html`-Node ein Container mit `html` und `css` (in Shadow-DOM oder iframe `srcdoc`? Entscheide und begründe in TSDoc; Isolation der Styles zwischen Nodes ist Pflicht), Box `width × height`, platziert per CSS-Transform `matrix(...)` aus `localMatrix(node)` und `request.scale`, `opacity`, `mix-blend-mode` für `blendMode` innerhalb des Layers, `filter` aus `filters`. Web Animations (`document.getAnimations()`) pausieren und `currentTime` = lokale Zeit in ms setzen. CSS-Variablen `--ov-time`, `--ov-frame`, `--ov-progress`. Warten auf `document.fonts.ready` und alle Bilder `decode()`. Aufnahme per CDP `Page.captureScreenshot` (PNG, transparenter Hintergrund über `Emulation.setDefaultBackgroundColorOverride`) → `decodePng` aus `@agentic-video/png`.
- `three`-Backend: Seiten-Laufzeit ruft `ThreeLayerRenderer.render(...)`, zeichnet das Canvas mit der Node-Matrix in ein Ausgabe-Canvas (2D, `setTransform`), liest Pixel (vormultipliziert!) und sendet sie per `POST /frame`. `fusable: false`.
- `pixi`-Backend: analog mit `PixiLayerRenderer`; `fusable: true`. Video-Frames für Pixi liefert der Host über `/video/<asset>/<seconds>` (Node-Seite ruft `assets.videoFrame` und liefert PNG).
- Alle drei Backends implementieren `RenderBackend` inkl. `check()` (Three/Pixi: `checkThreeNode`/`checkPixiNode`; HTML: Hinweis `OV_HTML_SCRIPT` als `info`, wenn `<script>` enthalten ist – Skripte laufen nur in der Sandbox, siehe ADR 0008) und `versions()` (Chromium-Version aus `browser.version()`, Three/Pixi-Versionen).
- Speicher/Performance: Seiten wiederverwenden, keine Neuladung pro Frame.

## I/O & Edge-Case Matrix

| Scenario | Input | Expected |
|---|---|---|
| Netzzugriff | `<img src="https://example.com/x.png">` | Anfrage blockiert, Bild fehlt, Frame rendert |
| Uhr | `<div id=t></div><script>t.textContent=Date.now()</script>` | Frame 30 zweimal gerendert → gleicher Text |
| CSS-Animation | `@keyframes` 1 s, Frame 15 bei 30 fps | Zustand bei 500 ms, unabhängig von vorherigen Frames |
| Transparenz | html ohne Hintergrund | Alpha 0 außerhalb des Inhalts |

## Tasks & Acceptance

**Acceptance Criteria:**
- Golden-Tests für HTML mit CSS-Transforms, Filtern, Masken, Verläufen, Typografie (Webfont aus FontResolver), SVG, Canvas-2D-Skript, WebGL-Skript, Web Component; CSS-Animation frame-genau.
- Determinismus-Test: zwei getrennte Hosts, Frames in unterschiedlicher Reihenfolge → gleiche Hashes.
- Sicherheits-Test: externe Anfrage wird blockiert (Zähler im Route-Handler).
- Three- und Pixi-Backends rendern je eine Beispielszene über den Host (Golden).

## Verification

- `npm run build:extra -w @agentic-video/renderer-browser` (nach dem Anlegen) und `npx tsc -b packages/renderer-browser`
- `npx vitest run packages/renderer-browser`
- `npx eslint packages/renderer-browser --max-warnings 0`
