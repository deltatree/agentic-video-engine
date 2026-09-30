# @agentic-video/benchmarks

Reproduzierbare Benchmarks für OpenVideo (A38, FR-94, SM-4).
Das Paket erzeugt Testprojekte im Code, rendert sie mit der echten Render-Umgebung und misst.
Eine eingecheckte Basis erkennt Leistungsverluste (Regressionen).

## Messen

Voraussetzungen:

- Node 22 und FFmpeg mit `lavfi` auf dem `PATH` (oder `OPENVIDEO_FFMPEG`).
- Chromium für Playwright (für `3d-heavy` und `mixed`).
- Ein gebautes Paket: `npx tsc -b packages/benchmarks`.

Schritte:

1. Miss alle Szenarien in 1080p30 mit 10 Frames: `node packages/benchmarks/dist/bin.js`.
2. Wähle Szenarien und Auflösungen: `--scenario text-heavy,mixed --resolution 4k30,4k60`.
3. Hol maschinenlesbare Werte: `--json`. Ohne `--json` erscheint eine Markdown-Tabelle.
4. Prüfe auf Regressionen: `--resolution all --compare`.
5. Schreib nach einer gewollten Änderung die Basis neu: `--resolution all --frames 5 --update-baseline`.

Die Kommandozeile startet jede Messung in einem eigenen Node-Prozess.
So teilen die Messungen weder Speicher noch WASM-Zustand.
`--update-baseline` ersetzt nur die neu gemessenen Einträge derselben Maschine.

Weitere Optionen:

| Option | Bedeutung |
|---|---|
| `--frames <n>` | Gemessene Frames je Szenario (Standard 10). |
| `--workers <n>` | Zusätzlicher Durchsatzlauf mit N Worker-Prozessen. |
| `--no-encode` | Die MP4-Kodierung überspringen. |
| `--tolerance <x>` | Erlaubter fps-Verlust für `--compare` (Standard 0.2 = 20 %). |

Exit-Codes:

| Code | Bedeutung |
|---|---|
| 0 | Messung fertig, keine Regression. |
| 1 | `--compare` fand mindestens eine Regression. |
| 2 | Falsche Eingabe, Fehler beim Messen oder ein abgebrochenes Szenario. Die übrigen Szenarien laufen trotzdem. |

Aus Code:

```ts
import { runBenchmark, runSuite, compareToBaseline, parseBaseline } from '@agentic-video/benchmarks';

const r = await runBenchmark({ scenario: 'mixed', resolution: '1080p30', frames: 10, workers: 1, encode: true });
const suite = await runSuite({ resolutions: ['1080p30', '4k30'], frames: 5 });
const c = compareToBaseline(suite.results, parseBaseline(baselineJson), { tolerance: 0.2 });
```

## Szenarien

| Szenario | Belastet |
|---|---|
| `text-heavy` | Textsatz: 24 umbrochene Absätze, animiert. |
| `vector-heavy` | 600 Formen: Rechtecke mit Verlauf, Ellipsen, Sternpfade, Linien. |
| `image-heavy` | 16 im Code erzeugte PNGs (512 × 512) in 60 rotierenden Image-Nodes. |
| `video-heavy` | 4 Testvideos aus FFmpeg `lavfi` (`testsrc2`), 9 Video-Nodes. |
| `3d-heavy` | `scene3d` mit 48 Meshes und 3 Lichtern (Three.js, WebGL2). |
| `mixed` | Skia-2D, HTML/CSS in Chromium, Three.js-3D und ein Compositor-Layer mit Blur. |
| `audio-heavy` | 3 Spuren mit vielen Clips, EQ, Kompressor, Ducking, Limiter und Lautheits-Mastering. |

Auflösungen: `1080p30`, `1080p60`, `4k30`, `4k60`.
Alle Projekte und Assets entstehen deterministisch aus einem festen Seed.

## Was die Werte bedeuten

| Wert | Bedeutung |
|---|---|
| `framesPerSecond` | Gerenderte Frames pro Sekunde in einem Prozess (ohne Kodierung). Die Regressionserkennung nutzt diesen Wert. |
| `frameMs.mean/p50/p95` | Renderzeit pro Frame in Millisekunden: Mittelwert, Median, 95. Perzentil. |
| `startupMs` | Zeit von der Umgebung bis zum ersten fertigen Frame. Das enthält Fonts, Assets, Skia und träge gestartete Backends wie Chromium. |
| `cpuPercent` | CPU-Zeit geteilt durch Wandzeit, in Prozent eines Kerns. 200 % heißt: im Mittel zwei Kerne belegt. |
| `cpuScope` | `process-tree`: Prozess plus Kindprozesse (Chromium, FFmpeg, Worker) über `/proc`. `process`: nur der eigene Prozess. |
| `peakRssMb` | Spitzen-RAM (RSS) des Prozessbaums. Ein eigener Prozess tastet alle 100 ms ab. |
| `gpu` | GPU-Auslastung und VRAM über `nvidia-smi`. Ohne GPU: `null` mit Grund `no GPU`. |
| `cacheHitRatio` | Trefferquote aller Cache-Stufen während des Renderns (0 bis 1). |
| `encoding.framesPerSecond` | Durchsatz des Encoders: Frames pro Sekunde der Stufe `ffmpeg`. |
| `audioSeconds` | Dauer der Audio-Pipeline (Mischung, Ducking, Mastering). |
| `workers`, `parallelFramesPerSecond` | Durchsatz mit N Worker-Prozessen. Der Wert enthält den Start der Worker. Fehlt `@agentic-video/scheduler`, steht `workers: 1` mit `workersNote`. |
| `frameHashes` | Pixel-Hashes der Frames. Gleiche Eingabe ergibt gleiche Hashes. |
| `deterministic` | `true`, wenn die kodierten Frames bitgleich zu den gemessenen sind. |

Ablauf einer Messung:

1. Projekt und Assets im temporären Ordner erzeugen.
2. Umgebung bauen und einen Aufwärm-Frame hinter dem Messbereich rendern (Startzeit).
3. Jeden Frame einzeln rendern und messen.
4. Optional alle Frames zu MP4 kodieren (Encoder, Audio, Determinismus).
5. Optional mit N Worker-Prozessen und leerem Cache erneut rendern.

## Regressionserkennung

- `compareToBaseline(results, baseline, { tolerance: 0.2 })` meldet Szenarien, deren fps mehr als 20 % unter der Basis liegen.
- Die Basis liegt in `packages/benchmarks/baseline.json`. Sie enthält eine Beschreibung der Maschine.
- Werte einer anderen Maschine (CPU, Kerne, RAM, Plattform oder GPU verschieden) vergleicht das Paket nicht. Es meldet sie als übersprungen mit Grund.

## Basiswerte dieser Maschine

Maschine: Intel Core i9-9980HK (16 Threads), 63 GB RAM, Linux x64, keine GPU (WebGL über SwiftShader), Node v22.23.3.
Messung: `--resolution all --frames 5`, jede Messung in einem eigenen Prozess.
Die Datei `baseline.json` enthält dieselben Werte.

| Szenario | Auflösung | Frames | fps | Mittel ms | p50 ms | p95 ms | Start ms | CPU % | Spitzen-RAM MB | GPU % | Cache-Treffer | Encoder fps | Worker |
|---|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| text-heavy | 1080p30 | 5 | 1.94 | 516.1 | 508.1 | 578.8 | 1190 | 182 | 554 | no GPU | 0 % | 7.0 | 1 |
| text-heavy | 1080p60 | 5 | 1.48 | 675.6 | 639.4 | 840.4 | 1351 | 163 | 584 | no GPU | 0 % | 6.2 | 1 |
| text-heavy | 4k30 | 5 | 0.46 | 2192.4 | 2142.0 | 2831.9 | 2094 | 135 | 1135 | no GPU | 0 % | 1.4 | 1 |
| text-heavy | 4k60 | 5 | 0.48 | 2078.3 | 1998.8 | 2436.0 | 1780 | 136 | 1087 | no GPU | 0 % | 1.4 | 1 |
| vector-heavy | 1080p30 | 5 | 2.36 | 424.5 | 442.8 | 493.0 | 1501 | 165 | 453 | no GPU | 0 % | 5.1 | 1 |
| vector-heavy | 1080p60 | 5 | 2.61 | 382.6 | 364.9 | 438.8 | 1457 | 166 | 447 | no GPU | 0 % | 5.6 | 1 |
| vector-heavy | 4k30 | 5 | 0.90 | 1105.8 | 1063.8 | 1313.9 | 2416 | 147 | 930 | no GPU | 0 % | 1.6 | 1 |
| vector-heavy | 4k60 | 5 | 0.99 | 1011.8 | 1021.0 | 1269.2 | 1822 | 155 | 916 | no GPU | 0 % | 1.7 | 1 |
| image-heavy | 1080p30 | 5 | 0.90 | 1109.4 | 934.2 | 1548.1 | 2332 | 153 | 469 | no GPU | 0 % | 3.7 | 1 |
| image-heavy | 1080p60 | 5 | 0.87 | 1151.1 | 1045.5 | 1428.6 | 2000 | 155 | 454 | no GPU | 0 % | 3.9 | 1 |
| image-heavy | 4k30 | 5 | 0.25 | 3973.7 | 3775.1 | 5091.7 | 5818 | 146 | 985 | no GPU | 0 % | 1.2 | 1 |
| image-heavy | 4k60 | 5 | 0.26 | 3810.8 | 3898.4 | 4135.7 | 4884 | 147 | 1045 | no GPU | 0 % | 1.1 | 1 |
| video-heavy | 1080p30 | 5 | 0.89 | 1119.4 | 1089.2 | 1288.1 | 2380 | 189 | 767 | no GPU | 0 % | 6.6 | 1 |
| video-heavy | 1080p60 | 5 | 0.85 | 1175.5 | 1164.8 | 1437.3 | 2561 | 186 | 765 | no GPU | 0 % | 6.7 | 1 |
| video-heavy | 4k30 | 5 | 0.30 | 3291.4 | 2978.2 | 4546.3 | 4007 | 145 | 1330 | no GPU | 0 % | 2.0 | 1 |
| video-heavy | 4k60 | 5 | 0.31 | 3194.2 | 3013.6 | 4088.4 | 4549 | 147 | 1298 | no GPU | 0 % | 2.0 | 1 |
| 3d-heavy | 1080p30 | 5 | 0.46 | 2155.0 | 2012.4 | 2615.2 | 4525 | 186 | 2104 | no GPU | 0 % | 6.8 | 1 |
| 3d-heavy | 1080p60 | 5 | 0.47 | 2125.3 | 2059.5 | 2568.9 | 5320 | 179 | 2110 | no GPU | 0 % | 6.7 | 1 |
| 3d-heavy | 4k30 | 5 | 0.15 | 6518.9 | 6438.3 | 7961.1 | 10411 | 181 | 3889 | no GPU | 0 % | 2.2 | 1 |
| 3d-heavy | 4k60 | 5 | 0.14 | 6971.4 | 7126.0 | 8016.6 | 10521 | 178 | 3920 | no GPU | 0 % | 2.3 | 1 |
| mixed | 1080p30 | 5 | 0.34 | 2921.4 | 2880.3 | 3236.9 | 5558 | 171 | 2077 | no GPU | 0 % | 7.2 | 1 |
| mixed | 1080p60 | 5 | 0.36 | 2776.8 | 2860.4 | 2978.3 | 5824 | 173 | 2059 | no GPU | 0 % | 8.2 | 1 |
| mixed | 4k30 | 5 | 0.10 | 9714.9 | 9478.6 | 10545.1 | 14610 | 159 | 3534 | no GPU | 0 % | 1.7 | 1 |
| mixed | 4k60 | 5 | 0.09 | 11458.7 | 10855.8 | 13452.9 | 15087 | 150 | 3536 | no GPU | 0 % | 1.9 | 1 |
| audio-heavy | 1080p30 | 5 | 6.98 | 143.3 | 145.2 | 159.4 | 1252 | 161 | 473 | no GPU | 0 % | 9.0 | 1 |
| audio-heavy | 1080p60 | 5 | 8.26 | 121.1 | 131.2 | 135.5 | 1093 | 165 | 466 | no GPU | 0 % | 8.6 | 1 |
| audio-heavy | 4k30 | 5 | 1.97 | 508.3 | 481.0 | 592.3 | 1548 | 138 | 1059 | no GPU | 0 % | 2.2 | 1 |
| audio-heavy | 4k60 | 5 | 1.48 | 674.6 | 626.4 | 1072.1 | 1516 | 125 | 1067 | no GPU | 0 % | 2.1 | 1 |

Beobachtungen aus dieser Messung:

- Die Messung lief, während ein anderer Test acht Worker-Prozesse rechnen ließ (Load etwa 12 bei 16 Threads). Die Werte sind deshalb eher zu hoch; wiederhole sie auf einer freien Maschine.
- Die Cache-Trefferquote ist 0 %, weil sich in jedem Szenario jeder Layer pro Frame bewegt.
- Gegenüber der ersten Basis sind `image-heavy` etwa 17-mal, `text-heavy` 14-mal und `mixed` 3,5-mal schneller (1080p30). Ursache war eine Skia-Surface mit nicht vormultipliziertem Alpha und ein Gauß-Weichzeichner, der das ganze Bild faltete.
- `mixed` und `3d-heavy` hängen am Software-Rendering von Chromium (SwiftShader): Rücklesen der WebGL-Pixel und das Abfangen der Frame-Übertragung durch Playwright.
- 1080p60 und 4k60 kosten pro Frame etwa so viel wie 30 fps. Ein Video mit 60 fps braucht also doppelt so lange.

## Vorher/Nachher Epic 18 (2026-09-30, andere Maschine)

Diese Messung stammt **nicht** von der Referenzmaschine oben: 4 Kerne, 15 GB RAM, Linux x64, keine GPU, FFmpeg 6.1,
geteilt mit anderen Agenten (Load 3–15 während der Messung). `baseline.json` bleibt darum unverändert; die Werte
stehen in [`results-2026-09-30.json`](results-2026-09-30.json). Vorher und nachher liefen **abwechselnd** je Szenario
(`--scenario <s> --resolution <r> --frames 5`, jede Messung in eigenem Prozess), damit beide dieselbe Fremdlast
sehen. Aussagekräftig sind die Verhältnisse, nicht die absoluten Werte.

Seit Epic 18 misst die Schleife wie ein Chunk im Video-Render (mit Layer-Historie, Story 18.3): Animierte Layer
werden nicht mehr in den Layer-Cache komprimiert. Der Frame-Cache wird weiter geschrieben.

| Szenario | Auflösung | fps vorher | fps nachher | Faktor | ms/Frame vorher | ms/Frame nachher | Frame-Hashes |
|---|---|---:|---:|---:|---:|---:|---|
| text-heavy | 1080p30 | 1.81 | 2.74 | 1.52 | 552 | 364 | gleich |
| vector-heavy | 1080p30 | 2.12 | 2.92 | 1.38 | 472 | 342 | gleich |
| image-heavy | 1080p30 | 1.12 | 1.54 | 1.38 | 896 | 651 | gleich |
| video-heavy | 1080p30 | 0.72 | 1.04 | 1.44 | 1388 | 962 | gleich |
| 3d-heavy | 1080p30 | 0.63 | 0.59 | 0.93 | 1576 | 1693 | gleich |
| mixed | 1080p30 | 0.42 | 0.74 | 1.76 | 2389 | 1356 | gleich |
| audio-heavy | 1080p30 | 14.53 | 19.54 | 1.35 | 69 | 51 | gleich |
| text-heavy | 4k30 | 0.78 | 1.00 | 1.27 | 1275 | 1003 | gleich |
| vector-heavy | 4k30 | 1.66 | 2.52 | 1.52 | 601 | 396 | gleich |
| image-heavy | 4k30 | 0.58 | 0.68 | 1.18 | 1722 | 1463 | gleich |
| video-heavy | 4k30 | 0.64 | 0.72 | 1.12 | 1554 | 1390 | gleich |
| 3d-heavy | 4k30 | 0.19 | 0.17 | 0.89 | 5181 | 5812 | gleich |
| mixed | 4k30 | 0.17 | 0.23 | 1.34 | 5901 | 4414 | gleich |
| audio-heavy | 4k30 | 2.91 | 7.67 | 2.64 | 344 | 130 | gleich |

Ganzer Video-Render (`renderVideo`, 180 Frames 1080p30, ohne Ton; Ersatz für die DoD-Kurzvariante, die auf der
belegten Maschine nicht vorher/nachher lief):

| Szenario | vorher, 1 Prozess (alter Standard) | vorher, 4 Worker | nachher, 1 Prozess | nachher, 3 Worker (neuer Standard) |
|---|---:|---:|---:|---:|
| vector-heavy | 53.5 s | 48.4 s | 33.2 s | 26.3 s |
| text-heavy | 93.6 s | 94.4 s | 85.7 s | 66.9 s |
| mixed | 380.9 s | 216.9 s | 235.1 s | 200.6 s |

Frame- und Chunk-Hashes sind in allen Läufen gleich; `deterministic` ist überall `true`.

Einordnung:

- Gewinne je Frame: Compositor auf Inhalts-Bounds und ein Durchlauf für reine Bild-Layer (4K-Compositor mit einem
  Layer etwa 250 → 60 ms), native Frame-Hashes (4K etwa 190 → 25 ms), keine Kompression animierter Layer, statische
  Layer aus dem Speicher, HTML-Aufnahme nur im Inhaltsbereich (`mixed` 1080p: Browser-Layer etwa 230 → 120 ms).
- Ganzer Render: Der Encoder läuft parallel zum Rendern, und der Standard nutzt mehrere Worker-Prozesse.
- `3d-heavy` hängt fast nur am Software-Rendering von Three.js in SwiftShader; die Abweichung liegt im Rauschen
  der geteilten Maschine.
- Die Encoder-fps der Tabelle oben sind nicht mehr vergleichbar: `ffmpeg` misst jetzt die Zeit, die der Encoder den
  Ablauf aufhält (Schreiben parallel zum Rendern plus Abschluss), mit Threads nach freien Kernen (hier 3 statt 4).
