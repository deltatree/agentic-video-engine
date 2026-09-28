---
title: 'OpenVideo Studio (Epic 11: Stories 11.1–11.4)'
type: 'feature'
created: '2026-09-28'
status: 'ready-for-dev'
route: 'dispatch'
context:
  - '{project-root}/_bmad-output/implementation-artifacts/agent-rules.md'
  - '{project-root}/packages/agent/src/operations.ts'
  - '{project-root}/packages/agent/src/server.ts'
  - '{project-root}/packages/cli/src/services.ts'
  - '{project-root}/packages/core/src/patches.ts'
  - '{project-root}/docs/reference/node-semantics.md'
---

## Intent

**Problem:** Menschen sollen Videos visuell feinjustieren können, ohne dass Code und Studio auseinanderlaufen (FR-73..FR-76). Die UX orientiert sich an professionellen Kreativwerkzeugen, ist aber radikal einfacher (A26).

**Approach:** `apps/studio` ist eine React-19-App (Vite 8, TypeScript, Monaco). Sie spricht **nur** die Agent API (`/v1/*`, gleiche Origin). Jede Änderung ist ein Patch über `composition.patch` (bzw. `project.update` im Code-Editor). Es gibt kein eigenes Projektformat.

## Boundaries & Constraints

**Always:**
- Ordner: `apps/studio` (existiert mit `package.json`). Nichts anderes ändern. Lege `index.html`, `vite.config.ts`, `tsconfig.json` (DOM-Lib, `jsx: react-jsx`, strikt wie `tsconfig.base.json`) und `src/**` an. Build-Ausgabe `apps/studio/dist` (Script `build:extra` = `vite build` existiert).
- Vorschau-Bilder kommen vom Server (`frame.render` mit `scale` passend zum Zoom, `inline: true`). Wiedergabe = fortlaufende Frame-Anfragen (Frame-Cache macht Wiederholungen schnell); Abspielrate an die Antwortzeit anpassen, Frames nie überspringen, wenn „exakt“ gewählt ist.
- Undo/Redo nutzt die `inverse`-Patches aus `composition.patch`.
- Keine Features, die nicht funktionieren (A51): kein deaktivierter Knopf für Geplantes.
- Barrierefreiheit: Tastaturbedienung, sichtbarer Fokus, ARIA-Rollen für Baum, Tabs, Slider; Kontrast WCAG AA.
- Deutsch für Kommentare; UI-Texte Englisch (Produktsprache, wie Diagnosen).

## Anforderungen (A25, A26, A27)

Layout exakt nach A25: Toolbar oben; links Scene Tree / Assets / Components (Tabs); Mitte Preview; rechts Inspector / Properties / Effects (Tabs); darunter Timeline / Audio / Keyframes / Curves (Tabs); ganz unten Code / Diagnostics / Render Queue (Tabs). Panels in der Größe verstellbar.

- **Scene Tree:** Baum aus `scene.tree` bzw. der IR (`composition.get`); Auswahl, Mehrfachauswahl (Shift/Ctrl), Umbenennen (`name`), Sperren (`locked`), Verbergen (`visible`), Reihenfolge per Drag & Drop (`moveNode`), Gruppieren (`addNode` group + `moveNode`), Löschen.
- **Assets:** Liste aus `project.inspect`; Import per Datei-Drop (`asset.import` mit base64); Drag auf die Bühne legt `image`/`video`/`svg`/`lottie`-Node an.
- **Components:** Liste der registrierten Komponenten (neue Operation ist nicht nötig: nutze `templates.list` nicht; lies die Komponenten über `composition.validate`? – nein: lege sie als statische Liste mit Beispiel-Props an, die du aus `@agentic-video/components` beim Build importierst, `COMPONENTS`); Klick fügt die Komponente mit ihrem Beispiel ein.
- **Preview/Bühne:** Zoom/Pan (Rad, Leertaste+Ziehen), Rulers, Guides (aus Rulers ziehen), Safe Areas, Grid, Bounds der Auswahl (aus `scene.tree`), Drag zum Verschieben (setzt `x`/`y`), Snapping an Guides, Safe-Area-Kanten und Bounds anderer Nodes, Ausrichten/Verteilen (links, Mitte, rechts, oben, Mitte, unten; horizontal/vertikal verteilen), Kopieren/Einfügen/Duplizieren (neue IDs), Debug-Overlays (Toggle, nutzt `debug` von `frame.render`), Auflösungswechsel (Skalierung 25/50/100 %).
- **Inspector/Properties:** Felder je Node-Typ aus dem JSON Schema (`GET /v1/operations` liefert es nicht; nutze `@agentic-video/schema` `NODE_SCHEMAS` beim Build): Zahl (Slider + Eingabe), Farbe (Farbwähler), Text, Enum (Select), Vec2; animierte Werte zeigen ein Keyframe-Symbol; „Keyframe hier setzen“ (`addKeyframe` am aktuellen Frame). Responsiv (schmale Breiten stapeln).
- **Effects:** Liste `filters`/`effects`/`shadow` bearbeiten.
- **Timeline:** Zeitlineal (Frames/SMPTE), Playhead, Frame-Stepping (←/→, Shift = 10), Play/Pause (Leertaste), Zeitfenster jeder Node als Balken (aus `timeline.inspect`), verschiebbar/trimmbar (setzt `timing.from`/`timing.duration`), Keyframe-Rauten je Property, Marker (anzeigen, anlegen, verschieben via `setCompositionProperty markers`), Zoom der Timeline.
- **Audio:** Wellenform je Audio-Clip (Datei über `/v1/files/<projekt>/<src>` laden, `AudioContext.decodeAudioData`, Spitzen zeichnen), Clip-Lautstärke.
- **Keyframes/Curves:** Keyframe-Editor (Wert/Zeit/Easing je Keyframe), Kurven-Editor für das Easing eines Segments mit Bezier-Griffen → setzt `ease: 'cubic-bezier(…)'`.
- **Code:** Monaco mit `project.json` (JSON-Schema-Validierung über `@agentic-video/schema/openvideo.schema.json`); Speichern → `project.update`; bei TSX-Projekten die TSX-Quelle anzeigen (lesend, falls kein Speicherweg existiert – dann klar als „read-only“ beschriftet).
- **Diagnostics:** `diagnostics.get` für den aktuellen Frame; Klick wählt die Node und springt im Code zur Stelle (JSON-Pointer bzw. `source`).
- **Render Queue:** `video.render`/`preview.render` starten (Profil wählen), `render.status` pollen, Fortschritt, Abbruch (`render.cancel`), fertige Dateien verlinken.
- **Tastenkürzel:** Undo (Ctrl+Z), Redo (Ctrl+Shift+Z / Ctrl+Y), Kopieren/Einfügen/Duplizieren (Ctrl+C/V/D), Löschen (Entf), Gruppieren (Ctrl+G), Play (Leertaste), Frame ←/→, Zoom (Ctrl +/−/0). Hilfe-Dialog mit allen Kürzeln (`?`).
- Projektwahl beim Start: `project.inspect` ohne ID listet Projekte; URL-Parameter `?project=<id>` öffnet direkt.

## Tasks & Acceptance

**Acceptance Criteria (UI-Tests mit Playwright in `apps/studio/test/*.test.ts`, Vitest-Runner wie die anderen Pakete):**
- Starte im Test `startAgentServer` aus `@agentic-video/agent` mit `createLocalServices` aus `@agentic-video/cli` (Workspace im Temp-Ordner, echte Render-Umgebung, `isolation: 'trusted'`) und liefere `apps/studio/dist` über die Option `fallback` aus. Öffne Chromium (Playwright), erzeuge ein Projekt per API.
- Tests: Layout sichtbar (alle Panels per Rolle/Label); Node verschieben per Drag → IR hat neues `x`/`y`; Undo stellt es wieder her; Mehrfachauswahl + Ausrichten links; Keyframe setzen im Inspector erzeugt `$keyframes`; Timeline-Balken verschieben ändert `timing.from`; Code-Editor speichern ändert die IR; Diagnose anklicken wählt die Node; Render-Queue-Job läuft bis `succeeded`; Tastenkürzel Ctrl+D dupliziert.
- Screenshot des Studios (visuell prüfen!) als Artefakt im Test-Ordner ablegen (nicht einchecken).

## Verification

- `cd apps/studio && npx vite build` (bzw. `npm run build:extra -w @agentic-video/studio`)
- `npx tsc -p apps/studio/tsconfig.json --noEmit`
- `npx vitest run apps/studio/`
- `npx eslint apps/studio --max-warnings 0` (falls nicht im ESLint-Projekt: mit Kopie von `tsconfig.eslint.json` prüfen und im Bericht nennen)
