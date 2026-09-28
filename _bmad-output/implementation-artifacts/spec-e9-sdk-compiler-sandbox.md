---
title: 'TSX-SDK, Compiler, Container-Sandbox, AST-Rückschreiben (Epic 9)'
type: 'feature'
created: '2026-09-28'
status: 'ready-for-dev'
route: 'dispatch'
context:
  - '{project-root}/_bmad-output/implementation-artifacts/agent-rules.md'
  - '{project-root}/docs/reference/node-semantics.md'
  - '{project-root}/packages/schema/src/nodes.ts'
  - '{project-root}/packages/schema/src/project.ts'
  - '{project-root}/packages/core/src/patches.ts'
  - '{project-root}/packages/timeline/src/builders.ts'
  - '{project-root}/docs/adr/0008-nicht-vertrauenswuerdiger-code-nur-im-container.md'
---

## Intent

**Problem:** Menschen und Agents sollen Videos in TSX schreiben (FR-17, FR-18). TSX ist Code und damit nicht vertrauenswürdig (FR-70..FR-72). Studio-Änderungen müssen per AST in TSX zurück (FR-76). Jede TSX-Composition muss als JSON exportierbar sein und ohne Code bitgleich rendern (FR-17a).

**Approach:** `sdk` liefert JSX-Runtime und Element-Komponenten, die reine IR-Objekte erzeugen. `compiler` bündelt TSX mit esbuild und wertet das Bundle in der `sandbox` (Docker) aus. `compiler` schreibt Patches per TypeScript-AST zurück.

## Boundaries & Constraints

**Always:**
- Pakete: `packages/sdk`, `packages/compiler`, `packages/sandbox`. Nichts anderes ändern.
- `sdk` ist isomorph (keine Node-APIs), hängt nur von `core` ab. Die JSX-Runtime ist unter `@agentic-video/sdk/jsx-runtime` und `@agentic-video/sdk/jsx-dev-runtime` exportiert (Dateien `src/jsx-runtime.ts`, `src/jsx-dev-runtime.ts`; `package.json`-Exports existieren bereits).
- JSX ist nur Syntax: Elemente sind Daten `{ type, props, source? }`. Kein React.
- Nicht vertrauenswürdiger Code läuft nur im Container (ADR 0008). Modus `trusted-host` existiert nur als ausdrückliche Option (Node-Kindprozess mit `--permission`, `--allow-fs-read` nur auf das Temp-Verzeichnis, kein Netz-Modul in der VM) und muss im Ergebnis markiert sein (`trusted: true`).
- Docker-Image für die Sandbox: `node:22-alpine`, per Digest gepinnt (ermittle mit `docker pull` + `docker image inspect`). Kein Host-Mount; Code und Eingabe über stdin, Ergebnis über stdout (JSON, Größenlimit).

## Anforderungen

### sdk
- `composition(def)` und `project(def)` erzeugen Definitionen. `composition` akzeptiert `scene` als Element **oder** als Funktion `({ frame, time, fps, width, height, durationFrames }) => Element`.
- Element-Komponenten für alle Node-Typen, mindestens: `Scene` (Wurzel; `background` setzt die Composition-Hintergrundfarbe), `Group`, `Layer`, `Rect`, `RoundedRect`, `Circle` (`radius` → ellipse), `Ellipse`, `Line`, `Polyline`, `Polygon`, `Path`, `Text`, `RichText`, `Image`, `Video`, `Sprite`, `SpriteSheet`, `Lottie`, `Svg`, `Shader`, `Particles`, `Html`, `Subtitles`, `SubtitleTrack` (`src` → Asset + Subtitle-Track + `subtitles`-Node), `CompositionRef`, `Component` (generisch) und `component(name)` (Fabrik für Komponenten der Bibliothek), `ThreeScene` (→ scene3d), `BlenderScene`, `Camera3D`, `AmbientLight`, `DirectionalLight`, `PointLight`, `SpotLight`, `HemisphereLight`, `Mesh`, `Box`, `Sphere`, `Plane`, `Cylinder`, `Cone`, `Torus`, `TorusKnot`, `Capsule`, `Model`, `Instances`, `Particles3D`, `Group3D`, `AudioTrack`, `AudioClip`, `Marker`.
- Kleine, dokumentierte Aliase: `font` → `fontFamily`; `rotationX/Y/Z` → `rotation` (Vektor, Grad) bei 3D; `src` bei Medien → Asset (automatisch deklariert, ID aus Dateiname, Typ aus Endung).
- Eine `Camera3D` außerhalb, aber per `camera="id"` von einer `ThreeScene` referenziert, wird in diese Szene verschoben (Beispiel aus Auftrag A4).
- Animations-Helfer re-exportiert: `animate`, `keyframes`, `spring`, `expr`, `ref`, `stagger`, `sequence` (aus core/timeline). Zusätzlich Remotion-kompatible Form `spring({ frame, from?, to?, fps?, config? })`, die in Frame-Funktionen sofort eine Zahl liefert.
- Nodes ohne `id` erhalten stabile IDs aus Typ und Baumposition (z. B. `text-2`), dokumentiert.
- `toIR(project | composition, { sample: (frame) => … })` → IR-Project. Frame-Funktionen werden für **jeden** Frame ausgewertet; veränderliche Werte werden `$sampled`, konstante bleiben Literal. Nodes, die nur in manchen Frames existieren, bekommen `visible` als `$sampled`. Wechselt eine ID ihren Typ → Fehler `OV_SDK_UNSTABLE_TREE` mit Frame-Angabe.
- Quellpositionen: `jsxDEV` speichert `{ file, line, column }` in `meta.source` jeder Node.
- Das Beispiel aus Auftrag A4 (Abschnitt „TypeScript/JSX DSL“) kompiliert zu einer gültigen IR (Test, Datei `test/fixtures/auftrag-a4.tsx`).

### sandbox
- `runSandboxed({ code, input, limits: { timeoutMs, memoryMb, cpus, pids }, mode: 'docker' | 'trusted-host' })` → `{ output, stderr, durationMs, trusted }`.
- Docker: `--rm -i --network none --read-only --tmpfs /tmp:rw,noexec,nosuid,size=16m --cap-drop ALL --security-opt no-new-privileges --pids-limit N --memory M --memory-swap M --cpus C --user 65534:65534 --ulimit nofile=64`, Standard-seccomp-Profil, Name zufällig, harter Abbruch (`docker kill`) nach Timeout.
- Fehler: `OV_SANDBOX_TIMEOUT`, `OV_SANDBOX_MEMORY`, `OV_SANDBOX_CRASH`, `OV_SANDBOX_UNAVAILABLE` (Docker fehlt; Vorschlag: Docker installieren oder JSON-Composition nutzen oder bewusst `--trusted`).
- `sandboxAvailable()` für `doctor`.
- **Security-Tests** (NFR-5): Host-Datei lesen (z. B. Pfad des Test-Repos) scheitert, Netzwerk (`fetch('https://example.com')` und `169.254.169.254`) scheitert, `/var/run/docker.sock` fehlt, Fork-Bombe wird durch pids-Limit gestoppt, Speicherüberlauf endet mit `OV_SANDBOX_MEMORY`, Endlosschleife endet mit `OV_SANDBOX_TIMEOUT`, Schreiben ins Root-FS scheitert.

### compiler
- `compileTsx(entryPath, { projectDir, mode: 'docker' | 'trusted-host' })` → `{ project: IrProject, diagnostics, bundleHash }`: esbuild bündelt (Format IIFE, `jsx: 'automatic'`, `jsxImportSource: '@agentic-video/sdk'`, `jsxDev: true`, Plattform `neutral`, Node-Builtins verboten → Diagnose), die Sandbox wertet aus und ruft `toIR`. Laufzeitfehler werden per Sourcemap auf TSX-Datei/Zeile abgebildet (Diagnose mit `details.file`, `details.line`).
- Ergebnis wird mit `validateProject` geprüft; Diagnosen tragen Quellpositionen aus `meta.source`.
- `exportJson(project)` → formatiertes JSON ohne Code; Test: IR aus TSX == IR aus exportiertem JSON (Rundreise), und das JSON enthält keine Funktionen.
- **AST-Rückschreiben** `applyPatchesToSource(source, patches, { fileName })` → `{ source, applied, diagnostics }` mit der TypeScript-Compiler-API: findet JSX-Elemente über ihr `id`-Attribut (String-Literal), ersetzt oder ergänzt Attribute mit Literalen (Zahl, String, Boolean, Objekt-/Array-Literal), verschachtelte Pfade (`scale.x`) in Objekt-Literalen, `addNode` (JSX-Element als letztes Kind des Elternelements), `removeNode`, `moveNode`, `addKeyframe`/`removeKeyframe` (Attribut wird zu `{keyframes([...])}`, Import ergänzen). Textänderungen nur über AST-Positionen, minimal, Formatierung sonst unverändert. Nicht literale Attributwerte (Ausdrücke) → Diagnose `OV_ROUNDTRIP_DYNAMIC` mit Vorschlag, der Patch wird für diese Stelle nicht angewendet.

## Tasks & Acceptance

**Acceptance Criteria:**
- Given das A4-Beispiel, when kompiliert, then gültige IR mit scene3d (Kamera verschoben), text, subtitles; `meta.source` gesetzt.
- Given `scene: ({ frame }) => <Rect x={frame * 2} …/>`, when kompiliert, then `x` ist `$sampled` mit einem Wert je Frame; ein konstanter Wert bleibt Literal.
- Given alle Security-Angriffe, when in Docker ausgeführt, then scheitert jeder mit Diagnose.
- Given `setProperty(headline, fontSize, 82)` auf TSX-Quelle, when rückgeschrieben, then ändert sich genau das Attribut (Diff-Test).
- Given ein Laufzeitfehler in Zeile 12 der TSX-Datei, then nennt die Diagnose Datei und Zeile 12.

## Verification

- `npx tsc -b packages/sdk packages/sandbox packages/compiler`
- `npx vitest run packages/sdk packages/sandbox packages/compiler`
- `npx eslint packages/sdk packages/sandbox packages/compiler --max-warnings 0`
