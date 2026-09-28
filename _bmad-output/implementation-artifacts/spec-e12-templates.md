---
title: '15 Templates (Story 12.3)'
type: 'feature'
created: '2026-09-28'
status: 'ready-for-dev'
route: 'dispatch'
context:
  - '{project-root}/_bmad-output/implementation-artifacts/agent-rules.md'
  - '{project-root}/packages/sdk/README.md'
  - '{project-root}/packages/sdk/src/index.ts'
  - '{project-root}/packages/components/src/index.ts'
  - '{project-root}/packages/agent/src/services.ts'
  - '{project-root}/packages/compiler/README.md'
  - '{project-root}/packages/render/src/node-env.ts'
---

## Intent

**Problem:** Agents und Menschen sollen mit hochwertigen Startpunkten beginnen (FR-81). Templates sind echter, lesbarer Quellcode – keine Black Boxes.

**Approach:** Paket `templates`: je Template ein Ordner `templates/<name>/` mit `src/video.tsx` (SDK + Komponenten), `template.json` (Info), `project.json` (aus der TSX kompilierte IR, eingecheckt, damit JSON-Nutzer ohne Compiler starten können), `README.md`, und ggf. `assets/` (nur selbst erzeugte, lizenzfreie Dateien: SVG-Logos, prozedural erzeugte Bilder/Modelle über Skripte im Paket, **keine** Fremdinhalte). Dazu `src/index.ts` mit einem `TemplateCatalog` (Typ aus `@agentic-video/agent`, aber **nicht** importieren – Abhängigkeitsregel `templates → core, sdk, components`; definiere eine strukturell gleiche Schnittstelle) über die mitgelieferten Dateien.

## Boundaries & Constraints

**Always:**
- Paket: `packages/templates`. Nichts anderes ändern.
- Die 15 Templates aus A29: `product-launch`, `saas-explainer`, `logo-reveal`, `social-video` (1080×1920), `youtube-intro`, `presentation`, `data-visualization`, `code-tutorial`, `architecture-diagram`, `3d-product-showcase` (scene3d mit prozeduralem Modell/Geometrie), `lower-third` (transparent, Alpha), `subtitle-video` (Untertitel-Track inline), `podcast-clip` (Wellenform-Balken aus Audio-Amplituden als Keyframes eines Test-Tons), `cinematic-title`, `comparison-video`.
- Jedes Template nutzt Theme-Tokens (umfärbbar), Komponenten wo sinnvoll, Übergänge, und ist 5–20 s lang. Qualität zählt: professionelle Typografie, Abstände, Timing. Prüfe jedes Template **visuell** per Kontaktbogen.
- `project.json` erzeugst du per Skript `scripts/build-templates.mjs` (Compiler im Modus `trusted-host`, denn es ist eigener Code) – Script `build:extra` in `package.json` des Pakets.

## Tasks & Acceptance

**Acceptance Criteria:**
- Given jedes Template, when `compileTsx` (trusted-host), then gültige IR ohne Fehler; das eingecheckte `project.json` ist aktuell (Test vergleicht).
- Given jedes Template, when mit `createNodeEnvironment` (render) Frames 0/Mitte/Ende gerendert, then keine Fehler-Diagnosen; ein Kontaktbogen je Template liegt als Golden in `test/golden/` (visuell geprüft).
- Given `createTemplateCatalog()`, then `list()` liefert 15 Einträge mit Maßen/fps/Dauer; `get(name)` liefert IR und Quelldateien.
- Given ein anderes Theme (`THEMES.light` aus components), when ein Template damit gerendert wird, then ändern sich die Farben (Test für 2 Templates).

## Verification

- `npm run build:extra -w @agentic-video/templates`
- `npx tsc -b packages/templates`
- `npx vitest run packages/templates/`
- `npx eslint packages/templates --max-warnings 0`
