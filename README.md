# OpenVideo – Agentic Video Engine

[![CI](https://github.com/deltatree/agentic-video-engine/actions/workflows/ci.yml/badge.svg)](https://github.com/deltatree/agentic-video-engine/actions/workflows/ci.yml)
[![Lizenz: Apache-2.0](https://img.shields.io/badge/Lizenz-Apache--2.0-blue.svg)](LICENSE)

OpenVideo ist eine Open-Source-Plattform für **Video-as-Code**, gebaut für Coding Agents.
Ein Agent beschreibt ein Video als JSON oder TSX. OpenVideo rendert Frames, zeigt das Ergebnis und nimmt gezielte Änderungen an.

```text
frame = render(composition, assets, frame, seed)
```

Jeder Frame ist eine reine Funktion seiner Eingaben.
Frame 471 ist bitgleich, egal ob Frame 470 vorher gerendert wurde.

## Was OpenVideo kann

| Bereich | Umfang |
|---|---|
| Beschreibung | Composition IR (JSON Schema), TSX-SDK, 30 Node-Typen, Komponenten, 15 Templates |
| Animation | Keyframes, Springs, Expressions, Motion Paths, Text-Animation, Übergänge |
| 2D | Skia/CanvasKit, PixiJS, SVG, Lottie, Datenvisualisierung |
| 3D | Three.js (WebGL2/WebGPU), glTF, Licht, Kamera, Partikel; Blender Cycles und Eevee |
| Web | HTML/CSS-Layer in Chromium mit virtueller Zeit und Netzsperre |
| Bild | eigener Compositor: 17 Blend Modes, Masken, Effekte, Color Grading, Farbräume |
| Ton | Mix und Mastering, Voiceover (Piper, espeak-ng), Untertitel mit Wort-Timing (whisper.cpp) |
| Ausgabe | MP4, WebM, MOV/ProRes, GIF, Bildfolgen, Alpha; Render-Manifest mit Frame-Hashes |
| Agents | HTTP-API, MCP-Server, CLI – dieselben 24 Operationen, strukturierte Fehler mit Vorschlägen |
| Skalierung | Frame-Cache nach Inhalts-Hash, Prozess-, Docker- und Kubernetes-Worker, S3-Cache |
| Studio | visuelle Bearbeitung im Browser; jede Änderung ist ein semantischer Patch |

## Schnellstart

Voraussetzung: Node.js 22.13 oder neuer und FFmpeg.

```bash
npx @agentic-video/cli create hello
cd hello
npx @agentic-video/cli render-frame --frame 2s --out out/frame.png
npx @agentic-video/cli render --format mp4
```

`openvideo doctor` prüft die Umgebung und nennt für jede Lücke eine Lösung.
Mehr steht in [Erste Schritte](docs/guide/getting-started.md).

## Für Coding Agents

1. Starte die Agent API: `openvideo serve` oder den MCP-Server: `openvideo mcp`.
2. Lies [docs/ai/AGENTS.md](docs/ai/AGENTS.md) und [llms.txt](llms.txt).
3. Die Fähigkeiten stehen maschinenlesbar in [docs/ai/capabilities.json](docs/ai/capabilities.json).

Ein Agent ändert ein Video mit Patches, nicht mit Textersetzung:

```json
{ "patches": [{ "op": "setProperty", "nodeId": "headline", "property": "fill", "value": "#FF5A1F" }] }
```

Nach jedem Patch rendert OpenVideo nur die Frames neu, die sich wirklich ändern.

## Dokumentation

| Dokument | Inhalt |
|---|---|
| [Erste Schritte](docs/guide/getting-started.md) | Installation, erstes Projekt, Rendern |
| [Rezepte](docs/guide/recipes.md) | Fertige IR-Bausteine für typische Aufgaben |
| [Agent API](docs/guide/api.md) | Alle Operationen mit Beispielen |
| [Kommandozeile](docs/guide/cli.md) | Alle Befehle von `openvideo` |
| [Render-Semantik](docs/reference/node-semantics.md) | Verbindliche Bedeutung jedes Node-Typs |
| [Architektur-Entscheidungen](docs/adr/README.md) | ADR 0001–0017 |
| [Betrieb mit Docker und Kubernetes](deploy/README.md) | Images, Skalierung, Updates |

## Pakete

| Paket | Aufgabe |
|---|---|
| `@agentic-video/schema` | Composition IR, JSON Schema, Validierung, Migration |
| `@agentic-video/timeline` | Zeiteinheiten, Easing, Keyframes, Springs, Expressions |
| `@agentic-video/core` | Frame-Auswertung, Frame-Plan, Patches, Registry, Plugins |
| `@agentic-video/sdk` | TSX-SDK: `composition()`, JSX, Animations-Helfer |
| `@agentic-video/compiler` | TSX → IR, Sandbox-Ausführung, Rückschreiben in den Quelltext |
| `@agentic-video/components` | Komponentenbibliothek und Themes |
| `@agentic-video/templates` | 15 Templates als lesbarer TSX-Quellcode |
| `@agentic-video/render` | Render-Pipeline, Frame-Cache, Audio, Encoding, Manifest |
| `@agentic-video/renderer-skia` | 2D und Text mit Skia/CanvasKit |
| `@agentic-video/renderer-browser` | Chromium-Host für HTML/CSS, PixiJS und Three.js |
| `@agentic-video/renderer-three`, `renderer-pixi` | Szenenaufbau für Three.js und PixiJS |
| `@agentic-video/renderer-blender` | Blender Cycles und Eevee headless |
| `@agentic-video/compositor` | Blend Modes, Masken, Effekte, Farbräume |
| `@agentic-video/audio`, `ffmpeg` | Audio-Mix, Encoding und Decoding |
| `@agentic-video/speech`, `subtitles` | Voiceover, Spracherkennung, Untertitel |
| `@agentic-video/assets`, `fonts`, `importers` | Assets, Schriften, Importe aus SVG, Lottie, glTF, HTML |
| `@agentic-video/anime`, `motion-canvas-adapter` | APIs im Stil von Anime.js und Motion Canvas |
| `@agentic-video/cache`, `scheduler`, `worker` | Cache, verteiltes Rendern, Worker |
| `@agentic-video/agent`, `mcp`, `cli` | Agent API, MCP-Server, Kommandozeile |
| `@agentic-video/telemetry`, `benchmarks`, `testing` | Metriken, Benchmarks, Testwerkzeuge |
| `@agentic-video/sandbox` | Container-Sandbox für nicht vertrauenswürdigen Code |
| `apps/studio` | OpenVideo Studio |

## Exit-Codes der CLI

| Code | Bedeutung |
|---|---|
| 0 | Erfolg |
| 1 | Das Projekt oder der Render hat Fehler; die Diagnosen stehen in der Ausgabe |
| 2 | Falsche Bedienung, zum Beispiel ein unbekannter Befehl oder eine fehlende Option |

## Sicherheit

OpenVideo führt Agent-Code standardmäßig in einem Docker-Container ohne Netz aus.
Details und das Melden von Lücken stehen in [SECURITY.md](SECURITY.md).

## Entwicklung

```bash
npm ci
npm run check   # Abhängigkeiten, Build, Lint, Lizenzen, Tests
```

Wie du beiträgst, steht in [CONTRIBUTING.md](CONTRIBUTING.md).

## Lizenz

Apache-2.0. Siehe [LICENSE](LICENSE).
Lizenzen der Abhängigkeiten: [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md), SBOM in `sbom.cdx.json`.
