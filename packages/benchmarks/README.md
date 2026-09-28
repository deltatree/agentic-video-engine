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
| text-heavy | 1080p30 | 5 | 0.14 | 7285.0 | 7222.9 | 7565.2 | 1075 | 110 | 580 | no GPU | 0 % | 8.0 | 1 |
| text-heavy | 1080p60 | 5 | 0.14 | 7068.5 | 7060.4 | 7099.4 | 1049 | 109 | 570 | no GPU | 0 % | 8.2 | 1 |
| text-heavy | 4k30 | 5 | 0.04 | 27729.4 | 27805.6 | 27880.4 | 1841 | 105 | 1352 | no GPU | 0 % | 2.0 | 1 |
| text-heavy | 4k60 | 5 | 0.03 | 29128.8 | 28953.7 | 30405.7 | 2167 | 105 | 1319 | no GPU | 0 % | 1.9 | 1 |
| vector-heavy | 1080p30 | 5 | 2.38 | 419.6 | 419.5 | 448.4 | 1066 | 144 | 496 | no GPU | 0 % | 7.2 | 1 |
| vector-heavy | 1080p60 | 5 | 2.29 | 435.8 | 438.1 | 490.9 | 1108 | 161 | 478 | no GPU | 0 % | 7.4 | 1 |
| vector-heavy | 4k30 | 5 | 0.81 | 1227.9 | 1223.4 | 1281.8 | 1722 | 145 | 1049 | no GPU | 0 % | 1.9 | 1 |
| vector-heavy | 4k60 | 5 | 0.71 | 1409.9 | 1415.2 | 1441.2 | 1926 | 144 | 1150 | no GPU | 0 % | 1.8 | 1 |
| image-heavy | 1080p30 | 5 | 0.05 | 19141.9 | 18661.4 | 20282.9 | 1803 | 104 | 491 | no GPU | 0 % | 5.0 | 1 |
| image-heavy | 1080p60 | 5 | 0.05 | 18280.7 | 18177.6 | 18796.8 | 1707 | 103 | 493 | no GPU | 0 % | 5.8 | 1 |
| image-heavy | 4k30 | 5 | 0.01 | 78099.9 | 78279.4 | 82344.8 | 5549 | 102 | 1172 | no GPU | 0 % | 1.3 | 1 |
| image-heavy | 4k60 | 5 | 0.01 | 73726.3 | 74490.3 | 74835.5 | 4533 | 102 | 1174 | no GPU | 0 % | 1.5 | 1 |
| video-heavy | 1080p30 | 5 | 1.01 | 986.7 | 951.9 | 1119.3 | 1769 | 186 | 792 | no GPU | 0 % | 9.5 | 1 |
| video-heavy | 1080p60 | 5 | 0.96 | 1039.6 | 1066.2 | 1168.4 | 1873 | 193 | 781 | no GPU | 0 % | 9.2 | 1 |
| video-heavy | 4k30 | 5 | 0.33 | 3044.6 | 2990.4 | 3231.3 | 3600 | 142 | 1349 | no GPU | 0 % | 2.4 | 1 |
| video-heavy | 4k60 | 5 | 0.33 | 3041.0 | 2990.3 | 3283.7 | 3650 | 144 | 1398 | no GPU | 0 % | 2.3 | 1 |
| 3d-heavy | 1080p30 | 5 | 0.47 | 2109.8 | 2053.9 | 2354.0 | 4262 | 209 | 2249 | no GPU | 0 % | 9.7 | 1 |
| 3d-heavy | 1080p60 | 5 | 0.47 | 2116.7 | 2057.8 | 2357.4 | 4069 | 211 | 2254 | no GPU | 0 % | 9.3 | 1 |
| 3d-heavy | 4k30 | 5 | 0.12 | 8150.6 | 8043.9 | 8788.0 | 10901 | 193 | 4452 | no GPU | 0 % | 2.9 | 1 |
| 3d-heavy | 4k60 | 5 | 0.11 | 8882.7 | 8425.2 | 10610.4 | 10836 | 190 | 4402 | no GPU | 0 % | 2.9 | 1 |
| mixed | 1080p30 | 5 | 0.10 | 10348.4 | 10251.5 | 10854.8 | 12667 | 133 | 2399 | no GPU | 0 % | 6.4 | 1 |
| mixed | 1080p60 | 5 | 0.10 | 10018.1 | 10034.4 | 10238.3 | 12523 | 135 | 2356 | no GPU | 0 % | 7.3 | 1 |
| mixed | 4k30 | 5 | 0.01 | 71889.4 | 73860.0 | 75409.9 | 69876 | 116 | 4778 | no GPU | 0 % | 2.3 | 1 |
| mixed | 4k60 | 5 | 0.01 | 72077.5 | 71849.6 | 75482.9 | 68332 | 116 | 4839 | no GPU | 0 % | 2.4 | 1 |
| audio-heavy | 1080p30 | 5 | 7.07 | 141.5 | 142.7 | 168.9 | 910 | 155 | 501 | no GPU | 0 % | 14.4 | 1 |
| audio-heavy | 1080p60 | 5 | 7.47 | 133.9 | 130.2 | 154.5 | 938 | 160 | 548 | no GPU | 0 % | 12.7 | 1 |
| audio-heavy | 4k30 | 5 | 1.65 | 607.8 | 601.5 | 627.8 | 1319 | 145 | 1158 | no GPU | 0 % | 3.1 | 1 |
| audio-heavy | 4k60 | 5 | 1.67 | 597.7 | 609.4 | 633.6 | 1311 | 144 | 1155 | no GPU | 0 % | 3.3 | 1 |

Beobachtungen aus dieser Messung:

- Die Cache-Trefferquote ist 0 %, weil sich in jedem Szenario jeder Layer pro Frame bewegt.
- `text-heavy`, `image-heavy` und `mixed` brauchen mehrere Sekunden pro Frame in 1080p. Das ist ein Hinweis für Optimierungen in den Renderern, nicht im Benchmark.
- 1080p60 und 4k60 kosten pro Frame etwa so viel wie 30 fps. Ein Video mit 60 fps braucht also doppelt so lange.
