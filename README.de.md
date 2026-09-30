# OpenVideo – Agentic Video Engine

[![CI](https://github.com/deltatree/agentic-video-engine/actions/workflows/ci.yml/badge.svg)](https://github.com/deltatree/agentic-video-engine/actions/workflows/ci.yml)
[![Lizenz: Apache-2.0](https://img.shields.io/badge/Lizenz-Apache--2.0-blue.svg)](LICENSE)

[English version](README.md) (maßgeblich)

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
| Beschreibung | Composition IR (JSON Schema), TSX-SDK, 31 Node-Typen, 29 Komponenten, 15 Templates |
| Animation | Keyframes, Springs, Expressions, Werte je Frame, Motion Paths, Text-Animation, Übergänge, `sequence` mit automatischer Überblendung, benannte Events |
| 2D | Skia/CanvasKit (Standard, bitgleich), PixiJS (WebGL in Chromium) mit Rückfall pro Node auf Skia, SVG, Lottie, Datenvisualisierung |
| 3D | Three.js (WebGPU mit Rückfall auf WebGL2), glTF, Licht, Kamera, Partikel; Blender Cycles und Eevee |
| Web | HTML/CSS-Layer in Chromium mit virtueller Zeit und Netzsperre; Browser-GPU-Modus als Opt-in |
| Bild | eigener Compositor: 17 Blend Modes, Masken, Effekte, Color Grading, Farbräume, `zIndex`, alles über Backend-Grenzen hinweg |
| Ton | Mix und Mastering, Voiceover (Piper, espeak-ng), Untertitel mit Wort-Timing (whisper.cpp), ASS-Styles, Karaoke |
| Ausgabe | MP4, WebM, MOV/ProRes, GIF, Bildfolgen, Alpha; Render-Manifest mit Frame-Hashes; Kurzmanifest für einzelne Frames |
| Agents | HTTP-API, MCP-Server, CLI – dieselben 31 Operationen, typisierte Patches, Vorschau-Patches ohne Speichern, Selbstbeschreibung, strukturierte Fehler mit Vorschlägen, Live-Ereignisse |
| Plugins | Agent Tools, Codecs, Exporter, Asset Loader, Studio-Panels, Node-Typen, Komponenten, Effekte, Backends – mit Rechten |
| Skalierung | Paralleles Rendern als Standard, Caches für Frames, Layer, Compiler-Ausgabe und Encoding nach Inhalts-Hash, Prozess-, Docker- und Kubernetes-Worker, S3-Cache |
| Studio | visuelle Bearbeitung im Browser mit Live-Sync; jede Änderung ist ein semantischer Patch |

## Schnellstart

Voraussetzung: Node.js 22.13 oder neuer und FFmpeg.

> **Noch nicht auf npm:** Die Pakete `@agentic-video/*` sind bis zur ersten Veröffentlichung
> (Release-Workflow bei einem Tag `v*`) nicht in der npm-Registry; `npx @agentic-video/cli` findet
> sie bis dahin nicht. Installiere die CLI so lange aus dem Repository:

```bash
git clone https://github.com/deltatree/agentic-video-engine.git
cd agentic-video-engine
npm ci && npm run build          # baut alle Pakete und kopiert das Studio ins CLI-Paket
alias openvideo="node $PWD/packages/cli/dist/bin.js"
cd .. && openvideo create hello
cd hello
openvideo render-frame --frame 2s --out out/frame.png
openvideo render --format mp4
```

Nach der ersten Veröffentlichung geht es ohne Checkout:

```bash
npx @agentic-video/cli create hello
cd hello
npx @agentic-video/cli render-frame --frame 2s --out out/frame.png
npx @agentic-video/cli render --format mp4
```

`openvideo doctor` (bzw. `npx @agentic-video/cli doctor`) prüft die Umgebung und nennt für jede Lücke eine Lösung.
Mehr steht in [Erste Schritte](docs/guide/getting-started.de.md).

## Für Coding Agents

1. Starte die Agent API mit `openvideo serve` oder den MCP-Server mit `openvideo mcp --project ./hello`. Ohne Server ruft `openvideo op <name> --input '<json>'` jede Operation auf.
2. Lies [docs/ai/AGENTS.md](docs/ai/AGENTS.md) (deutsch: [AGENTS.de.md](docs/ai/AGENTS.de.md)) und [llms.txt](llms.txt) (per MCP auch als Resource `openvideo://agents.md`).
3. Die Fähigkeiten stehen maschinenlesbar in [docs/ai/capabilities.json](docs/ai/capabilities.json) und kommen live über `capabilities.get` und `schema.get`.
4. Lerne an [Beispielen](examples/README.md): fünf vollständige Projekte (JSON und TSX, 2D, 3D, 9:16, Charts, Untertitel) und ein gültiges JSON-Beispiel je Node-Typ (`capabilities.get` mit `{ "nodeType": "text" }`). MCP-Clients konfiguriert [examples/mcp.json](examples/mcp.json).

Ein Agent ändert ein Video mit Patches, nicht mit Textersetzung:

```json
{ "patches": [{ "op": "setProperty", "nodeId": "headline", "property": "fill", "value": "#FF5A1F" }] }
```

Nach jedem Patch rendert OpenVideo nur die Frames neu, die sich wirklich ändern.

Coding Agents, die **an diesem Repository** arbeiten, beginnen mit [AGENTS.md](AGENTS.md).

## Dokumentation

Englisch zuerst; deutsche Fassungen liegen als `*.de.md` daneben, wo es sie gibt. Generierte Referenzen, Plugins und Maintainer-Leitfaden gibt es nur auf Englisch; ADRs nur auf Deutsch.

| Dokument | Inhalt |
|---|---|
| [Erste Schritte](docs/guide/getting-started.de.md) | Installation, erstes Projekt, Studio, Rendern |
| [Rezepte](docs/guide/recipes.de.md) | Fertige IR-Bausteine für typische Aufgaben |
| [Agent API](docs/guide/api.md) | Alle Operationen, HTTP-Endpunkte, Eingabe-Beispiele, Patch-Arten (generiert, Englisch) |
| [Kommandozeile](docs/guide/cli.md) | Alle Befehle von `openvideo` (generiert, Englisch) |
| [Plugins](docs/guide/plugins.md) | Agent Tools, Codecs, Exporter, Asset Loader und Studio-Panels aus Plugins; Rechte (Englisch) |
| [Maintainer](docs/guide/maintainers.md) | Branch-Schutz für `main` als Ruleset (gh api), Pflicht-Checks, Repository-Einstellungen (Englisch) |
| [API-Referenz](https://deltatree.github.io/agentic-video-engine/) | Alle exportierten Funktionen und Typen je Paket (TypeDoc, veröffentlicht von `.github/workflows/docs.yml`; `npm run docs` schreibt eine Markdown-Fassung nach `docs/api/`) |
| [Beispiele](examples/README.md) | Fünf Beispielprojekte mit README, Assets und Test (Englisch) |
| [Render-Semantik](docs/reference/node-semantics.de.md) | Verbindliche Bedeutung und ein JSON-Beispiel jedes Node-Typs |
| [Render-Manifest](docs/reference/render-manifest.de.md) | Felder des Render-Manifests und des Kurzmanifests für Frames |
| [Architektur-Entscheidungen](docs/adr/README.md) | ADR 0001–0028 |
| [Betrieb mit Docker und Kubernetes](deploy/README.de.md) | Images, Skalierung, Hochverfügbarkeit, Updates |

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
| `@agentic-video/assets`, `fonts`, `importers` | Assets, Schriften, Importe aus SVG, Lottie, glTF, HTML, Anime.js, Motion Canvas |
| `@agentic-video/anime`, `motion-canvas-adapter` | APIs im Stil von Anime.js und Motion Canvas |
| `@agentic-video/cache`, `scheduler`, `worker` | Cache, verteiltes Rendern, Worker |
| `@agentic-video/agent`, `mcp`, `cli` | Agent API, MCP-Server, Kommandozeile |
| `@agentic-video/telemetry`, `benchmarks`, `testing` | Metriken, Benchmarks, Testwerkzeuge |
| `@agentic-video/sandbox` | Container-Sandbox für nicht vertrauenswürdigen Code |
| `@agentic-video/png` | PNG-Kodierung und -Dekodierung |
| `apps/studio` | OpenVideo Studio |

## Exit-Codes der CLI

| Code | Bedeutung |
|---|---|
| 0 | Erfolg |
| 1 | Das Projekt oder der Render hat Fehler; die Diagnosen stehen in der Ausgabe |
| 2 | Falsche Bedienung, zum Beispiel ein unbekannter Befehl oder eine fehlende Option |

## Sicherheit

OpenVideo führt Agent-Code standardmäßig in einem Docker-Container ohne Netz aus.
Details und das Melden von Lücken stehen in [SECURITY.de.md](SECURITY.de.md).

## Entwicklung

```bash
npm ci
npm run check   # Abhängigkeiten, Build, Lint, Doku-Drift, Lizenzen, Tests
```

Wie du beiträgst, steht in [CONTRIBUTING.de.md](CONTRIBUTING.de.md).

## Lizenz

Apache-2.0. Siehe [LICENSE](LICENSE).
Lizenzen der Abhängigkeiten und der Inhalte jedes Container-Images (FFmpeg, Chromium, Blender im Image `openvideo-blender`): [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md), `licenses.json`, SBOM in `sbom.cdx.json`. `node scripts/licenses.mjs --check` schlägt fehl, wenn sie nicht mehr zu `package-lock.json` und `deploy/docker/Dockerfile` passen.
