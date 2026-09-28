# @agentic-video/renderer-three

Three.js-Szenenaufbau aus der IR (läuft im Browser).

Das Paket rendert eine ausgewertete `scene3d`-Node mit Three.js auf ein Canvas.
Es nutzt keine Node-APIs. Den Chromium-Host baut `@agentic-video/renderer-browser`.

## API

```ts
import { ThreeLayerRenderer, checkThreeNode, THREE_CAPABILITIES, THREE_VERSION } from '@agentic-video/renderer-three';

const renderer = new ThreeLayerRenderer({ preferredBackend: 'auto' });
const canvas = await renderer.render({
  node, // ausgewertete scene3d-Node
  width: 640, height: 360, scale: 1,
  frame: 12, time: 0.4, fps: 30, seed: 1,
  assetUrl: (id) => `/assets/${id}`,
  debug: { showCameraFrustum: true, showLightHelpers: true },
});
renderer.activeBackend; // 'webgpu' | 'webgl2'
renderer.dispose();
```

- `render()` liefert ein neues 2D-Canvas der Größe `width·scale × height·scale`.
- Ohne `background` ist der Hintergrund transparent.
- `checkThreeNode(irNode)` prüft eine IR-Node vor dem Rendern (Codes siehe TSDoc).

## Festlegungen

| Thema | Regel |
|---|---|
| Zeit | Nur aus der Eingabe. Die Szene wird pro Aufruf neu gebaut. |
| Backend | Node-Property `backend`, sonst `preferredBackend`. `auto` = WebGPU, außer GLSL-Shader oder kein WebGPU. |
| Orthografische Kamera | Sichtbare Höhe 10 m ÷ `zoom`. |
| Lichter | `directional`, `spot`, `hemisphere` stehen ohne `position` bei `[0, 1, 0]`. `spot.angle` ist der halbe Öffnungswinkel (Standard 60°). |
| Geometrie | Standardmaße von Three.js (Kante 1, Radius 1), 32 Segmente. |
| Animation | Zeit = `offset + localTime · speed`; mit `loop` modulo Clip-Dauer, sonst geklemmt. |
| Instanzen | `grid`: Spalten entlang +X, Zeilen entlang −Y, zentriert. `spin` dreht um Y (Grad/s). |
| Partikel | Zustandslos wie `particles2d`, Richtung gleichverteilt auf der Kugel, Standard 0,05 m groß. |
| Seed | Eigener `seed` der Node, sonst `seed` der Eingabe. |
| Tone Mapping | Standard `none`. Der Hintergrund (`background`) läuft mit durch das Tone Mapping. |
| Postprocessing | Reihenfolge: Depth of Field → Bloom → Tone Mapping → Color Grading → Vignette → LUT. |
| Color Grading | Im Anzeige-Raum: `rgb · 2^exposure`, dann Kontrast um 0,5, dann Sättigung (Rec.-709-Luma). |
| Depth of Field | Eigene Rechnung, in beiden Backends gleich: `blur = clamp(|focus − Abstand| · aperture, 0, maxBlur)`. |
| Asset-Format | Erst Dateiendung, dann erste Bytes (Host-URLs haben oft keine Endung). HDR über `HDRLoader` (Nachfolger von `RGBELoader`). |

## Einschränkungen

- GLSL-`ShaderMaterial` läuft nur unter WebGL2 (`OV_THREE_BACKEND_FEATURE`).
- Bloom sieht in WebGPU und WebGL2 ähnlich, aber nicht gleich aus (verschiedene Three.js-Implementierungen).
- Bewegungsunschärfe entsteht im Compositor (`three.motion-blur.temporal`).
- Das WebGPU-Backend übernimmt die interne Animationsschleife von Three.js, damit Effekte pro Aufruf
  und nicht pro Browser-Frame weiterzählen. Das nutzt ein internes Feld von Three.js 0.186.
