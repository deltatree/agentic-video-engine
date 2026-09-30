# @agentic-video/renderer-browser

Chromium-Host (Playwright): DOM-, PixiJS- und Three.js-Layer mit virtueller Zeit.

## Backends

| ID | Node-Typen | Fusionierbar | Aufnahme |
|---|---|---|---|
| `browser` | `html` | ja | CDP-Screenshot mit transparentem Hintergrund |
| `three` | `scene3d` | nein | `ThreeLayerRenderer` → Canvas → `POST /frame/<id>` |
| `pixi` | 2D-Nodes | ja | `PixiLayerRenderer` → Canvas → `POST /frame/<id>` |

```ts
import { createBrowserBackends } from '@agentic-video/renderer-browser';

const { browser, three, pixi } = await createBrowserBackends({ assets, fonts, width: 1920, height: 1080 });
const image = await browser.renderLayer(request);
```

## Bauen

Die Seiten-Laufzeit wird mit esbuild gebündelt:

```bash
npm run build:extra -w @agentic-video/renderer-browser
```

Das erzeugt `dist/runtime.js` (Host-Seite) und `dist/clock.js` (virtuelle Uhr für jedes Dokument).

## Chromium finden

1. Option `executablePath`.
2. Umgebungsvariable `OPENVIDEO_CHROMIUM`.
3. `chromium.executablePath()` aus `playwright-core`.

Im Cache-Schlüssel (`versions().chromium`) steht ohne eigenen Pfad die zu playwright-core gehörende Version
(`expectedChromiumVersion`, Schlüssel unverändert). Mit eigenem Pfad liest `chromiumVersionFor` einmal je Pfad die
tatsächliche Version aus `<chrome> --version`, ohne Chromium zu starten; nennt das Programm keine, gilt ein
Fingerabdruck der Programmdatei (`custom-<hash>`).

## Vertrag für HTML-Inhalte

- Jede `html`-Node läuft in einem eigenen iframe (`srcdoc`). Styles wirken nur in dieser Node.
- Assets liegen unter `/assets/<id>`, Schriften aus dem FontResolver sind per `font-family` nutzbar.
- Netzanfragen an fremde Origins werden blockiert. Service Worker sind gesperrt.
- Die Zeit ist virtuell: `Date`, `performance.now`, `requestAnimationFrame`, `setTimeout`, `setInterval`.
- `Math.random` ist pro Frame aus dem Seed der Composition gesät.
- Ein Dokument startet bei lokaler Zeit 0. Für einen früheren Frame lädt der Host es neu.
- Leite den Zustand aus der Zeit ab, nicht aus der Zahl der Aufrufe. Beispiel:

```html
<div id="bar"></div>
<script>
  openvideo.onFrame(({ time, frame, fps, progress }) => {
    bar.style.width = `${progress * 100}%`;
  });
</script>
```

- CSS-Variablen auf `:root`: `--ov-time` (Sekunden), `--ov-frame`, `--ov-progress` (ohne Einheit).
- CSS- und Web-Animationen werden pausiert und auf die lokale Zeit gesetzt.
- `<script>` läuft nur ausdrücklich erlaubt (`--trusted` oder `OPENVIDEO_ALLOW_HTML_SCRIPTS=1`) und nur mit OS-Sandbox (ADR 0008, Story 16.1); `check()` meldet dazu `OV_HTML_SCRIPT` als Info.
- Skripte laufen nur mit der Host-Option `allowHtmlScripts: true`. Standard ist `false`.
  Dann hat das iframe `sandbox="allow-same-origin"` und die CSP `script-src 'none'`.
  Es laufen keine `<script>`-Elemente, Event-Handler, `javascript:`-URLs und verschachtelten iframes.
  CSS-Animationen und die CSS-Variablen funktionieren weiter.
- `document.timeline.currentTime` und `Event.timeStamp` zeigen die virtuelle Zeit.
- Mehr als 100 000 Timer in einem Frame brechen mit `OV_BROWSER_TIMER_LIMIT` ab.

## Sicherheit des Hosts

- Der Server braucht ein zufälliges Token im Header `x-openvideo-token`. Der Host setzt es im Route-Handler.
  Das Token steht nicht in der URL der Seite.
- Frame-Uploads haben zufällige IDs (`crypto.randomUUID`).
- Chromium löst keine Hostnamen auf, nutzt einen toten Proxy (außer für `127.0.0.1`) und kennt kein WebRTC.
- Chromium startet mit OS-Sandbox. Klappt das nicht und sind Skripte verlangt (`allowHtmlScripts: true`),
  bricht der Host mit dem Fehler `OV_BROWSER_NO_OS_SANDBOX` ab: Skripte laufen nie ohne OS-Sandbox.
  Ohne Skripte läuft Chromium dann ohne Sandbox weiter, und `host.diagnostics` meldet `OV_BROWSER_NO_OS_SANDBOX` als Warnung.
  `probeOsSandbox()` prüft vorab, ob die Sandbox verfügbar ist (nicht als root, User Namespaces nötig).
- `--enable-unsafe-swiftshader` und `--enable-unsafe-webgpu` (`CHROMIUM_GRAPHICS_ARGS`) setzt der Host erst,
  wenn der erste `three`- oder `pixi`-Layer kommt; dafür startet er Chromium einmal neu. HTML rastert mit
  und ohne diese Schalter pixelgleich.
- Chromium erbt nur eine minimale Umgebung (`chromiumEnv`: `PATH`, `HOME`, `TMPDIR`, Locale, Fontconfig …),
  keine Tokens und keine S3-Schlüssel. Im GPU-Modus kommen nur die Variablen der Treiber dazu (`chromiumGpuEnv`).
- Höchstens `maxPages` Seiten (Standard 4) bleiben offen. Nach einem Absturz startet Chromium bei der nächsten Anfrage neu.

## GPU-Modus und Grafik-Probe (T5, ADR 0019)

- Standard ist SwiftShader (CPU, bitgleich). `OPENVIDEO_BROWSER_GPU=1` bzw. Option `gpu: true` startet Chromium mit
  nativem ANGLE (`CHROMIUM_NATIVE_GPU_ARGS`: `--use-angle=default --ignore-gpu-blocklist --enable-gpu`). HTML rastert
  weiter auf der CPU. Die Browser-Backends tragen dann `browser-gpu: native` in `versions()` (Cache-Schlüssel);
  im Standardmodus fehlt der Eintrag.
- `host.graphics()` bzw. `lazy.prepareGraphics()` prüft auf der Render-Seite WebGL2 (`MAX_TEXTURE_SIZE`) und WebGPU
  per Mini-Render auf dem Pfad von Three.js (`readPageGraphics` mit `probeWebGPU` aus `@agentic-video/renderer-three`:
  Gerät, Textur, Ansicht mit dem Deskriptor von Three.js inklusive `swizzle`, Render-Pass, Rücklesen). Ein Adapter mit
  unvollständiger API zählt als `unavailable`; `backend: 'auto'` nutzt dann WebGL2. Mit `graphicsCache` (z. B. Cache-Ebene
  `layer`) liegt das Ergebnis je Chromium-Version, Schaltern und Modus (im GPU-Modus zusätzlich `hostGpu`) im Speicher;
  ein Treffer startet kein Chromium. Danach trägt das `three`-Backend `three-webgpu` (`available`/`unavailable`) und `three-max-texture`
  in `versions()`: So steht die WebGPU/WebGL2-Wahl von `backend: 'auto'` (Regel: `threeBackendFor`) und die
  Texturverkleinerung im Cache-Schlüssel.
- `lazy.runtimeVersions()` liefert nach dem Start die tatsächliche Chromium-Version (`browser.version()`); vorher gilt
  im Schlüssel die zu playwright-core gehörende Version (`expectedChromiumVersion`).
- Gemeinsame Proben für `openvideo doctor`, Manifest und Telemetrie: `probeBrowserGraphics` (Chromium, WebGL2,
  WebGPU auf einer Probe-Seite) und `probeHostGpu` (`nvidia-smi`, sonst `/dev/dri`).
