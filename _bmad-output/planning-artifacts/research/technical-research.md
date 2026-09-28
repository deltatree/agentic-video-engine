# Technische Recherche: Bausteine für OpenVideo

- Datum: 2026-09-28
- Typ: technical, Form: select (Bausteine wählen)
- Entscheidung: Welche Bibliotheken tragen Rendering, Medien und Agent-Schnittstelle?
- Methode: Probeläufe auf der Zielmaschine plus npm-Registry. Jede Aussage nennt ihre Quelle.

## Befunde

| Nr. | Befund | Quelle |
|---|---|---|
| B1 | `canvaskit-wasm` 0.42.0, BSD-3-Clause. Der Build `bin/full` enthält `ParagraphBuilder`, `TypefaceFontProvider`, `RuntimeEffect` (SkSL-Shader), `MakeManagedAnimation` (Skottie/Lottie). | npm-Registry, abgerufen 2026-09-28; Probelauf `ck.mjs` |
| B2 | CanvasKit läuft in Node 22 ohne Browser. Hebräisch (RTL), Ligatur „ffi“ und Symbol „✓“ werden korrekt gesetzt. | Probelauf `ck.mjs`, Bild `ck.png` |
| B3 | CanvasKit in Node: 4K-Fläche, 50 abgerundete Rechtecke plus Pixel-Auslesen dauern 145 ms. | Probelauf `ck.mjs` |
| B4 | Playwright 1.63.0 (Apache-2.0) lädt Chrome Headless Shell 153.0.8010.12. WebGL2 läuft über ANGLE/SwiftShader ohne GPU. Maximale Texturgröße: 8192. | Probelauf `pw.mjs` |
| B5 | WebGPU steht nur auf einer HTTP-Origin zur Verfügung, nicht auf `about:blank`. Mit `--enable-unsafe-webgpu --enable-unsafe-swiftshader` liefert Chromium einen SwiftShader-Adapter. | Probelauf `pw2.mjs` |
| B6 | Three.js 0.186.1 (WebGL und `WebGPURenderer`) und PixiJS 8.21.0 liefern über zwei Browserstarts bitgleiche Frames (SHA-256 identisch). | Probelauf `pw3.mjs` |
| B7 | CDP `Page.captureScreenshot` mit transparentem Hintergrund liefert bei 1080p 54 ms pro Frame. Fünf Aufnahmen sind bitgleich. Die Playwright-API `page.screenshot` braucht 142 ms. | Probelauf `dom.mjs` |
| B8 | FFmpeg 7.0.2 (statischer Build) nimmt RGBA-Rohdaten über stdin an. H.264 bei 1080p: 14 ms pro Frame. Encoder vorhanden: libx264, libx265, libvpx-vp9, libaom-av1, prores_ks, gif, libwebp_anim. | Probelauf; `ffmpeg -encoders` |
| B9 | TypeScript 7.0.2 ist der native Compiler. typescript-eslint 8.70.1 unterstützt nur TypeScript `>=4.8.4 <6.1.0`. | npm-Registry, abgerufen 2026-09-28 |
| B10 | Vitest 5.0.2 verlangt Node `^22.12.0`. Vite 8.3.1 und ESLint 10 verlangen Node 20.19 oder 22.13. | npm-Registry, abgerufen 2026-09-28 |
| B11 | `@modelcontextprotocol/sdk` 1.30.1 (MIT), `ajv` 8.20.0 (MIT), `lottie-web` 5.13.0 (MIT), `monaco-editor` 0.57.0 (MIT), `react` 19.3.0 (MIT), `@opentelemetry/sdk-node` 0.222.0 (Apache-2.0). | npm-Registry, abgerufen 2026-09-28 |
| B12 | npm-Namen `openvideo` und `@openvideo/core` sind vergeben. `@agentic-video/core` ist frei. | npm-Registry, abgerufen 2026-09-28 |

## Folgerungen

1. CanvasKit ist der Standard-Renderer für 2D, Text und Lottie. Er läuft in Node und im Browser. Studio-Vorschau und Render nutzen denselben Code.
2. Chromium über Playwright trägt DOM, PixiJS und Three.js. Die Seite kommt von einem lokalen HTTP-Server, sonst fehlt WebGPU.
3. DOM-Ebenen werden per CDP-Screenshot mit transparentem Hintergrund erfasst.
4. FFmpeg bekommt Rohframes über stdin. Es bleibt ein externer Prozess.
5. TypeScript 6.0.3 statt 7.0.2, damit Linting funktioniert.
6. Node 22.13 oder neuer ist Mindestversion.

## Offene Punkte

- Blender ist lokal nicht installiert. Probelauf folgt mit einem portablen Build.
- Lokale TTS- und ASR-Engines sind nicht installiert. Probelauf folgt beim Voice-Epic.
