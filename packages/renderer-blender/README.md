# @agentic-video/renderer-blender

Blender-Backend: Cycles/Eevee headless mit Pässen.

Das Backend rendert `blender`-Nodes mit Blender 4.2 LTS im Hintergrundmodus.
Node beschreibt jeden Frame als JSON-Zustand.
Das Skript `python/openvideo_blender.py` baut daraus die Szene in Blender auf.

## Blender installieren

1. Lade `blender-4.2.*-linux-x64.tar.xz` und die `.sha256`-Datei von
   <https://download.blender.org/release/Blender4.2/>.
2. Prüfe die Prüfsumme: `grep linux-x64 blender-4.2.23.sha256 | sha256sum -c -`.
3. Entpacke das Archiv nach `~/.local/opt/`. Du brauchst kein sudo.

Das Backend sucht Blender in dieser Reihenfolge:
Option `blenderPath`, Variable `OPENVIDEO_BLENDER`, `PATH`, `~/.local/opt/blender*/blender`.
Fehlt Blender, meldet `detectBlender()` die Diagnose `OV_BLENDER_MISSING`.

## Beispiel

```ts
import { createBlenderBackend, evaluateMotionStates } from '@agentic-video/renderer-blender';

const backend = createBlenderBackend({ workDir: '/tmp/ov-blender', threads: 8 });
const check = backend.check(blenderNode); // OV_BLENDER_UNSUPPORTED usw.
const images = await backend.renderFrames([request0, request1, request2]); // ein Blender-Prozess
```

## Zeit und Motion Blur

- OpenVideo besitzt die Zeit. Blender spielt keine eigene Animation ab.
- glTF-Clips wertet das Skript zur OpenVideo-Zeit aus (`offset + lokale Zeit · speed`).
- Motion Blur braucht Zustände an Nachbar-Subframes.
  Der Frame-Render (`@agentic-video/render`) berechnet sie für jede `blender`-Node mit `motionBlur: true`
  an den Offsets ±0,25 Frames (Verschlusszeit ½ Frame) und übergibt sie als `motionStates`.
  Das gilt für jedes Backend mit der Fähigkeit `motion-states` (`MOTION_STATES_CAPABILITY`).
  Die Zustände gehen in den Layer-Schlüssel ein.
  Direkt am Backend berechnest du sie mit `evaluateMotionStates()`.
- Das Skript setzt daraus lineare Keyframes für Position, Rotation und Skalierung,
  auch für jede Instanz (`instances3d`) und jedes Partikel (`particles3d`).
  Material- und Lichtwerte gelten zum Frame selbst.

## Determinismus

- Cycles: CPU, Seed = Szenen-Seed, `use_animated_seed = False`, feste Samples ohne adaptive Samples.
- Cycles: eine Kachel (2048 px), feste Thread-Zahl, Denoiser aus, Dithering aus.
- Eevee: feste Samples. Ohne GPU läuft Eevee über Mesa (Software-OpenGL).
- Ergebnis auf der Entwicklungsmaschine (Blender 4.2.23, 16 Kerne, keine GPU):
  zwei getrennte Prozesse liefern für Cycles und Eevee bitgleiche Bilder.
  Die Toleranz im Test ist Kanal ≤ 2 bei höchstens 0,1 % der Pixel.

## Umrechnungen und Näherungen

| OpenVideo | Blender |
|---|---|
| Y oben (wie Three.js) | Wurzel-Empty dreht um +90° um X (Z oben) |
| `directional` Stärke `I` | Sonne mit Stärke `I` |
| `point`, `spot` Stärke `I` | Leistung `4π · I` Watt, harte Schatten |
| `ambient`, `hemisphere` | Weltlicht `Farbe · I / π` (Näherung) |
| `environment.preset` | Himmelsverlauf (Näherung) |
| `environment.hdri` | Environment Texture |
| `fog` | Mist-Pass im Compositor, Hintergrund bleibt ohne Nebel |
| `volume` | Principled Volume der Welt |
| Ausgabe | View Transform `Standard`, PNG 8 Bit, vormultipliziert zurück |

Pässe: `depth` (normalisiert, nah = schwarz, Hintergrund = weiß), `normal`
(Weltnormale in OpenVideo-Achsen, `n · 0,5 + 0,5`), `object-mask` (`maskObject` weiß, verdeckt durch andere Objekte).

`particles3d` wird als Instanzen übertragen: Jedes lebende Partikel ist eine unbeleuchtete Kugel
(Durchmesser `size`, Farbe über die Objektfarbe), berechnet mit derselben Formel wie im Three.js-Renderer.
`additive: true` mischt additiv (Emission plus Durchsicht).
Die Objekte sind nach Partikel-Index gepoolt; nicht lebende Partikel werden ausgeblendet.

Nicht übertragbar: `instances3d` bzw. `particles3d` mit mehr als 10 000 Instanzen/Partikeln,
GLSL-Shader-Materialien, `postprocessing`. `check()` meldet sie als `OV_BLENDER_UNSUPPORTED`.

## Fehler

| Code | Bedeutung |
|---|---|
| `OV_BLENDER_MISSING` | Blender nicht gefunden |
| `OV_BLENDER_PROCESS_FAILED` | Blender endete mit Fehler; `details.stderr` enthält die letzten Zeilen |
| `OV_BLENDER_TIMEOUT` | Ein Frame brauchte länger als `frameTimeoutMs` |
| `OV_BLENDER_ASSET_MISSING` | Ein Asset ist dem Resolver unbekannt |
