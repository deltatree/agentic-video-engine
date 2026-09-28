# Autopilot-Zustand

## Idee

Den Auftrag „Engineering Auftrag – Open Source Agentic Video Engine.md“ vollständig
umsetzen: OpenVideo, eine Open-Source-Plattform für Video-as-Code, gebaut für
Coding Agents. Veröffentlichung als öffentliches Projekt unter github.com/deltatree.

## Rahmen

| Feld | Wert |
|---|---|
| Track | greenfield (kein Quellcode, keine Tests, keine Commits) |
| Modus | fully autonomous |
| Bedingung | keine; Veröffentlichung auf GitHub ist ausdrücklich erlaubt |
| Keine Rückstellung | ja (Auftrag Abschnitt 51) |
| Sprache | Deutsch für Dokumente, Kommentare, Commits (AGENTS.local.md) |

## Aktuelle Phase

Phase 9 (Build): Epic 1 fertig; Welle 1 (Skia, Compositor, FFmpeg/Audio, Three/Pixi, Browser-Host) läuft; cache fertig

## Entscheidungen

| Nr. | Entscheidung | Begründung |
|---|---|---|
| D1 | Modus `fully autonomous` | Person verlangt „100 % autonom“. |
| D2 | npm-Scope `@agentic-video/*`, CLI `openvideo`, Arbeitstitel „OpenVideo“ | `openvideo` und `@openvideo/*` sind auf npm vergeben (geprüft 2026-09-28). Der Name bleibt über eine Konstante austauschbar. |
| D3 | Repo `deltatree/agentic-video-engine`, öffentlich | Name existiert noch nicht (geprüft 2026-09-28). |
| D4 | Lizenz Apache-2.0 | Vom Auftrag bevorzugt (Abschnitt 42). |
| D5 | Node 22 LTS als Mindestversion | Node 18 ist End-of-Life. Node 22 lokal unter `~/.local/opt/node22`. |
| D6 | FFmpeg als externer Prozess, nicht gebündelt | Hält GPL-Code aus dem Apache-2.0-Paket. Lokal: statischer Build 7.0.2. |
| D8 | TypeScript 6.0.3 | typescript-eslint unterstützt nur < 6.1 (2026-09-28). |
| D9 | Build-Workflow angepasst: ein Spec je zusammenhängendem Slice, Review je Epic, Haltepunkte autonom entschieden | 71 Stories mit je 5 Haltepunkten wären unverhältnismäßig (delivery-loop: right-size). |
| D10 | SeaweedFS (Apache-2.0) statt MinIO als S3-kompatibler Speicher | MinIO-Images sind auf Docker Hub und Quay nicht mehr frei abrufbar (Probe 2026-09-28). |
| D7 | Persönliche Agenten-Konfiguration (.claude, .cursor, _bmad …) wird nicht veröffentlicht | Stammt aus einem privaten Repo. |

## Umgebung

- Keine GPU, kein sudo, 16 Kerne, 62 GB RAM, Docker verfügbar.
- `export PATH=~/.local/opt/node22/bin:$PATH` vor jedem npm-Befehl.

## Nächster Schritt

Welle 2 starten (SDK/Compiler/Sandbox, Komponenten, Importe, Blender, Untertitel/Speech); selbst: assets, render, CLI.
