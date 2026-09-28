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
- `<script>` läuft nur in der Sandbox (ADR 0008); `check()` meldet dazu `OV_HTML_SCRIPT` als Info.
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
- Chromium startet mit OS-Sandbox. Klappt das nicht, läuft es ohne und `host.diagnostics` meldet `OV_BROWSER_NO_OS_SANDBOX`.
- Höchstens `maxPages` Seiten (Standard 4) bleiben offen. Nach einem Absturz startet Chromium bei der nächsten Anfrage neu.
