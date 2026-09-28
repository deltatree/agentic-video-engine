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

Phase 3 (Recherche) → Phase 4 (PRD)

## Entscheidungen

| Nr. | Entscheidung | Begründung |
|---|---|---|
| D1 | Modus `fully autonomous` | Person verlangt „100 % autonom“. |
| D2 | npm-Scope `@agentic-video/*`, CLI `openvideo`, Arbeitstitel „OpenVideo“ | `openvideo` und `@openvideo/*` sind auf npm vergeben (geprüft 2026-09-28). Der Name bleibt über eine Konstante austauschbar. |
| D3 | Repo `deltatree/agentic-video-engine`, öffentlich | Name existiert noch nicht (geprüft 2026-09-28). |
| D4 | Lizenz Apache-2.0 | Vom Auftrag bevorzugt (Abschnitt 42). |
| D5 | Node 22 LTS als Mindestversion | Node 18 ist End-of-Life. Node 22 lokal unter `~/.local/opt/node22`. |
| D6 | FFmpeg als externer Prozess, nicht gebündelt | Hält GPL-Code aus dem Apache-2.0-Paket. Lokal: statischer Build 7.0.2. |
| D7 | Persönliche Agenten-Konfiguration (.claude, .cursor, _bmad …) wird nicht veröffentlicht | Stammt aus einem privaten Repo. |

## Umgebung

- Keine GPU, kein sudo, 16 Kerne, 62 GB RAM, Docker verfügbar.
- `export PATH=~/.local/opt/node22/bin:$PATH` vor jedem npm-Befehl.

## Nächster Schritt

Technische Spikes (CanvasKit, Playwright, Three, Pixi), dann PRD.
