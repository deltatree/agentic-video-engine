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

Epics 1–22 umgesetzt. Nach dem Deep-Dive-Audit vom 2026-09-30 (sieben BMAD-Rollen, `planning-artifacts/audit-2026-09-30/`)
wurden die Epics 16–22 (`planning-artifacts/epics-2026-09-30.md`) geplant, umgesetzt und in drei adversarialen Reviews
(`implementation-artifacts/reviews/`) geprüft; alle Befunde sind behoben. Offen ist nur, was der Maintainer auslösen muss:
npm-Veröffentlichung per Tag `v*` (Secret `NPM_TOKEN`), GitHub Pages aktivieren, Branch-Schutz setzen (docs/guide/maintainers.md).

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
| D11 | `spring({frame, from})` in Frame-Funktionen folgt Remotion (from = Startwert); gesampelte Werte werden auf Schema-Grenzen geklemmt und mit `OV_SDK_CLAMPED` gemeldet | Auftrag A4 ist ein Beispiel; Remotion-Kompatibilität ist für Agents wertvoller; Klemmen wie CSS verhindert ungültige IR. |
| D12 | Komponenten-Props werden gegen `propsSchema` geprüft (`OV_COMPONENT_PROPS`) | Stille Rückfälle auf Standardwerte täuschen Agents (E2E-Befund). |
| D13 | Three/Pixi-Festlegungen übernommen: Ortho-Kamera 10 m ÷ zoom, Postprocessing DoF → Bloom → Tone Mapping → Grading → Vignette → LUT, Pixi-GLSL `mainImage(out vec4, in vec2)` | Vom Renderer-Agenten begründet, in READMEs dokumentiert. |
| D7 | Persönliche Agenten-Konfiguration (.claude, .cursor, _bmad …) wird nicht veröffentlicht | Stammt aus einem privaten Repo. |

| T1–T12 | Team-Entscheidungen der Epics 16–22 | siehe `planning-artifacts/epics-2026-09-30.md` |
| T13 | Encoder standardmäßig fest 4 Threads; `OPENVIDEO_ENCODER_THREADS=auto` ist Opt-in | Videodatei bleibt über Maschinen bitgleich (§20); ADR 0026 |
| T14 | Output-Cache-Schlüssel über alle Frame-Schlüssel, Encoder und Runner | Review-Befunde M1/M2 (final) |

## Umgebung

- Keine GPU, kein sudo, 16 Kerne, 62 GB RAM, Docker verfügbar.
- `export PATH=~/.local/opt/node22/bin:$PATH` vor jedem npm-Befehl.

## Nächster Schritt

Maintainer: PR prüfen und mergen, Tag `v0.1.0` für den ersten npm-Release, Pages und Branch-Schutz aktivieren.
