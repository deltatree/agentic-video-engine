---
stepsCompleted: [1, 2, 3, 4]
inputDocuments:
  - prds/prd-agentic-video-engine-2026-09-28/prd.md
  - architecture/architecture-agentic-video-engine-2026-09-28/ARCHITECTURE-SPINE.md
  - research/technical-research.md
---

# OpenVideo – Epics und Stories

## Überblick

Dieses Dokument zerlegt PRD (FR-1..FR-94, NFR-1..NFR-13) und Architektur (AD-1..AD-14) in umsetzbare Stories.
Jede Story nennt ihre Anforderungen. Die Reihenfolge folgt technischen Abhängigkeiten; sie reduziert den Umfang nicht (A51).

Für jede Story gelten zusätzlich diese Standard-Akzeptanzkriterien (Definition of Done):

- `npm run build`, `npm run lint`, `npm test` sind grün.
- Jede neue öffentliche API hat Typen, TSDoc, ein Beispiel und einen Test (NFR-3).
- Kein `any`, kein `@ts-ignore`, kein leerer `catch`, kein TODO (NFR-2, NFR-9).
- `scripts/check-deps.mjs` meldet keinen Verstoß gegen AD-14.
- Kommentare und Doku sind Deutsch.

## Abdeckung

| Anforderungen | Epic |
|---|---|
| FR-1..FR-20, FR-84, FR-87, NFR-1..NFR-4, NFR-8, NFR-10 | E1 |
| FR-6..FR-9, FR-28..FR-35, FR-45..FR-47, FR-60..FR-65, FR-68, FR-69, FR-77, FR-78, NFR-5, NFR-12 | E2 |
| FR-21..FR-27 | E3 |
| FR-48..FR-51, FR-28 (Image, Video, SVG, Sprite) | E4 |
| FR-52..FR-59 | E5 |
| FR-31, FR-36, FR-37 | E6 |
| FR-38..FR-42 | E7 |
| FR-43, FR-44 | E8 |
| FR-17, FR-17a, FR-18, FR-70..FR-72, FR-76 | E9 |
| FR-66, FR-67, FR-69, FR-92 | E10 |
| FR-73..FR-76, FR-80 | E11 |
| FR-81..FR-83 | E12 |
| FR-85, FR-86 | E13 |
| FR-79, FR-88..FR-91, FR-94, NFR-6, NFR-11 | E14 |
| FR-93, SM-1..SM-4 | E15 |

## Epic-Liste

1. E1 Fundament und invariante Grenzen
2. E2 Erster vertikaler Slice: JSON → Skia → MP4
3. E3 Agent-Schnittstelle und visuelles Feedback
4. E4 Asset Pipeline und Medien-Nodes
5. E5 Audio, Untertitel, Voiceover
6. E6 Browser-Renderer: DOM und PixiJS
7. E7 3D mit Three.js
8. E8 Blender-Backend
9. E9 TSX-DSL, Compiler und Sandbox
10. E10 Paralleles und verteiltes Rendering
11. E11 Studio
12. E12 Komponenten, Themes, Templates
13. E13 Importe und Adapter
14. E14 Betrieb, Qualität, Verteilung
15. E15 Agent-Dokumentation, Definition of Done, Veröffentlichung

---

## Epic 1: Fundament und invariante Grenzen

Ziel: Die sieben Grenzen aus A52 stehen sauber: Composition IR, Timeline, Frame Evaluation, Renderer Interface, Asset Model, Plugin Interface, Agent Interface.

### Story 1.1: Monorepo und Qualitätswerkzeuge

Als Entwickler will ich ein baubares Monorepo mit strengen Prüfungen, damit jede Änderung sofort geprüft wird.

**Akzeptanzkriterien:**
- **Given** ein frischer Klon **When** `npm ci && npm run build && npm run lint && npm test` läuft **Then** endet alles mit Exit-Code 0.
- **Given** ein Paket nutzt `any` oder `@ts-ignore` **When** der Lint läuft **Then** schlägt er fehl.
- **Given** `core` importiert `renderer-skia` **When** `scripts/check-deps.mjs` läuft **Then** schlägt er mit Pfadangabe fehl.
- Apache-2.0-Lizenz liegt im Root und in jedem Paket.

### Story 1.2: Composition IR, JSON Schema, Validierung

Als Agent will ich meine Composition gegen ein Schema prüfen, damit ich präzise Fehler bekomme. (FR-1..FR-4)

**Akzeptanzkriterien:**
- **Given** eine IR mit `scale.x: "large"` **When** validiert **Then** nennt die Meldung Pfad `composition.<id>.nodes.<id>.scale.x`, Erwartung, erhaltenen Wert und Korrekturvorschlag.
- **Given** zwei Nodes mit gleicher ID **Then** meldet die Validierung beide Pfade.
- `schema/openvideo.schema.json` wird aus der TypeBox-Definition erzeugt und ist eingecheckt.
- Jeder Node-Typ hat ein eigenes Teilschema.

### Story 1.3: IR-Migration

Als Nutzer will ich alte IR-Dateien laden können. (FR-5)

**Akzeptanzkriterien:**
- **Given** eine IR mit älterer `schemaVersion` **When** geladen **Then** wird sie migriert, und jeder Verlust erscheint als Diagnose.
- **Given** eine IR ohne `schemaVersion` **Then** wird sie abgelehnt.

### Story 1.4: Zeiteinheiten, Easing, Keyframes, Springs

Als Autor will ich Zeit in jeder Einheit angeben und Werte animieren. (FR-10, FR-11)

**Akzeptanzkriterien:**
- `"2s"`, `"2000ms"`, `48` und `"00:00:02:00"` ergeben bei 24 fps Frame 48.
- Property-Test: Keyframe-Interpolation trifft jeden Keyframe exakt.
- Property-Test: Monotones Easing bleibt zwischen Start- und Endwert.
- Springs hängen nur von der Zeit ab, nicht von der Framerate der Auswertung.
- Farben, Zahlen, Vektoren und Pfade werden interpoliert.

### Story 1.5: Expressions

Als Agent will ich Werte als sichere Ausdrücke schreiben. (FR-12)

**Akzeptanzkriterien:**
- `sin(time * 2) * 40` wertet bei `time = 0.25` korrekt aus.
- Ein Ausdruck mit `constructor`, `this` oder unbekanntem Namen wird mit Diagnose abgelehnt.
- Seeded `random(i)` und `noise(x)` liefern bei gleichem Seed gleiche Werte.

### Story 1.6: Timeline-Komposition

Als Autor will ich Animationen sequenzieren, verschachteln und umkehren. (FR-13..FR-16)

**Akzeptanzkriterien:**
- Sequenz, Parallel, Stagger, Delay, Loop, Ping-Pong, Marker, Named Events, Transitions, Nested Compositions, Time Stretch, Time Remap, Reverse, Hold haben je einen Test.
- Eine verschachtelte Composition mit Remap zeigt exakt den abgebildeten Frame.

### Story 1.7: Frame Evaluation, Registry, Plugins, Capabilities

Als Renderer-Entwickler will ich eine reine Evaluated Scene und einen Frame-Plan. (FR-6, FR-44, FR-84)

**Akzeptanzkriterien:**
- `evaluateScene` für Frame 471 ist bitgleich, egal ob Frame 470 vorher lief.
- `planFrame` fasst benachbarte Nodes desselben Backends zusammen; `layer`, `html`, `scene3d`, `blender` sind eigene Layer.
- Ein Plugin ohne Permission `fs.read` erhält keinen Dateizugriff im Kontext.
- Es gibt kein globales Register (Test: zwei Registries beeinflussen sich nicht).
- Komponenten-Makros werden expandiert; Kind-IDs lauten `<id>/<lokal>`.

### Story 1.8: Semantische Patches

Als Agent will ich einzelne Werte ändern, ohne die Szene neu zu schreiben. (FR-19, FR-20)

**Akzeptanzkriterien:**
- Alle sieben Operationen haben Tests.
- Eine fehlerhafte Patch-Liste ändert nichts und liefert eine Diagnose.
- Jede Operation liefert ihre Umkehrung; Anwenden plus Umkehrung ergibt die Ausgangs-IR bitgleich.

### Story 1.9: Fehler und Diagnosen

Als Agent will ich Fehler, die mir sagen, was zu tun ist. (FR-87)

**Akzeptanzkriterien:**
- `OpenVideoError` formatiert sich als Text (Blöcke wie in A40) und als JSON.
- Jede Diagnose hat `code`, `severity`, `problem`, `suggestions`.

### Story 1.10: Asset-Modell und Renderer-Schnittstelle als Verträge

Als Entwickler will ich stabile Verträge für Assets und Renderer. (FR-49, AD-5)

**Akzeptanzkriterien:**
- Typen `AssetRecord`, `RenderBackend`, `LayerRequest`, `RgbaImage` sind exportiert und dokumentiert.
- Ein Referenz-Test-Backend im Testpaket prüft den Vertrag.

---

## Epic 2: Erster vertikaler Slice: JSON → Skia → MP4

Ziel: Eine JSON-Composition mit 2D und Text wird zu MP4 mit Manifest.

### Story 2.1: Fonts

Als Autor will ich Schriften, die vor dem Render geladen und gehasht sind. (FR-32)
- Standard-Schriften (Inter, JetBrains Mono, Noto Color Emoji; OFL) sind gebündelt.
- Eine fehlende Schrift ergibt eine Diagnose mit Vorschlag.
- Font-Hashes landen im Manifest.

### Story 2.2: Skia-Renderer 2D

Als Autor will ich 2D-Primitive und Effekte. (FR-28..FR-30)
- Golden Test je Primitiv: group, rect (mit Radius), ellipse, line, polyline, polygon, path, image.
- Golden Test je Effekt: linearer, radialer, konischer Verlauf, Schatten, Blur, Maske (Alpha, Luma, invertiert), Clipping, Filter, alle Blend Modes, SkSL-Shader.
- Pfad-Trimming (`trimStart`, `trimEnd`) für Linien-Animation.

### Story 2.3: Typografie in Skia

Als Autor will ich professionelle Typografie. (FR-33..FR-35)
- Golden Tests für Kerning, Ligaturen, Tracking, Zeilenhöhe, Ausrichtung, RTL, Emoji, Umbruch, variable Achsen, Font Features.
- Text entlang Pfad, Text als Maske, Text mit Verlauf.
- Animation pro Zeichen, Wort, Zeile.

### Story 2.4: Compositor und Color Management

Als Autor will ich Layer mit Blend Modes, Masken und korrekter Farbe. (FR-46, FR-47, NFR-12)
- Blend Modes in `srgb` und `linear`, jeweils mit Test gegen Formel.
- Transferfunktionen sRGB, Rec.709, linear mit Hin-/Rück-Test.
- Premultiplied-Alpha korrekt (Test: halbtransparent über transparent).
- Crop, Transform, Layer-Effekte (Blur, Color Grading, LUT).

### Story 2.5: FFmpeg-Schicht

Als Nutzer will ich jedes geforderte Format. (FR-60..FR-64, FR-60a)
- ffprobe-Test je Format (MP4, MOV, WebM, GIF, WebP, PNG-/JPEG-/WebP-Sequenz) und Codec (H.264, H.265, VP9, AV1, ProRes).
- Alpha-Export (ProRes 4444, VP9 Alpha, PNG-Sequenz) mit Alpha-Wert-Test.
- Hardware-Encoder werden erkannt; CPU-Fallback greift immer.
- FFmpeg-Version, Build-Konfiguration und Lizenz stehen im Manifest.

### Story 2.6: Cache und Frame-Schlüssel

Als Nutzer will ich, dass nur Geändertes neu gerendert wird. (FR-68, FR-69)
- Ändern sich Nodes nur in Frames 800–900, rendert der zweite Lauf nur diese Frames (Zähler-Test).
- Cache-Ebenen: asset, font, composition, frame, layer, geometry, shader, audio, encoding.

### Story 2.7: Render-Pipeline und Manifest

Als Nutzer will ich aus einer Composition ein Video mit Manifest. (FR-6..FR-9, FR-65)
- End-to-End: JSON → MP4; ffprobe bestätigt Dauer, Größe, fps.
- `render-manifest.json` enthält alle Felder und validiert gegen sein Schema.
- Determinismus-Test: jeder Frame zweimal, in umgekehrter Reihenfolge, bitgleich.

### Story 2.8: CLI-Grundbefehle

Als Entwickler will ich `validate`, `render`, `render-frame`, `inspect` mit `--json`. (FR-77, FR-78)
- Beispiel aus A28 (`--composition --format --codec --width --height --fps`) funktioniert.
- `--json` liefert gültiges JSON auf stdout, Diagnosen auf stderr.

### Story 2.9: Testwerkzeuge

Als Entwickler will ich Golden- und Pixel-Diff-Tests. (NFR-5)
- `compareImages` mit Toleranz (Kanal ≤ 2, Pixel ≤ 0,1 %) und Diff-Bild.
- `UPDATE_GOLDENS=1` erneuert Referenzen bewusst.

---

## Epic 3: Agent-Schnittstelle und visuelles Feedback

### Story 3.1: Operationsregister und Agent API Server

Als Agent will ich alle 23 Operationen über HTTP. (FR-21, FR-23)
- Jede Operation hat Ein-/Ausgabe-Schema; `GET /v1/operations` listet sie.
- Test: jede Operation einmal gültig, einmal ungültig.
- `render.status` und `render.cancel` steuern laufende Jobs.

### Story 3.2: MCP Server

Als Agent will ich dieselben Operationen per MCP. (FR-22)
- MCP-Client-Test über stdio listet alle Tools und ruft `composition.validate` auf.

### Story 3.3: Frames, Kontaktbögen, Vorschau

Als Agent will ich Ergebnisse sehen. (FR-24)
- `frame.render`, `renderFrames`, `preview.contactSheet` (mit Frame-Nummer und Zeit), `preview.render` (Low-Res-MP4).

### Story 3.4: Szenenbaum, Bounding Boxes, Diagnosen

Als Agent will ich verstehen, was im Frame ist. (FR-25, FR-26)
- `scene.tree`, `scene.describe`, `timeline.inspect` liefern Bounds pro Node.
- Diagnosen: Safe Area, Überlauf, Text-Überlauf, fehlende Fonts/Assets, Layer, GPU, Warnungen; je ein Test.

### Story 3.5: Debug-Rendering

Als Agent will ich Hilfslinien sehen. (FR-27)
- Golden Test je Overlay: Bounds, Anchors, Safe Area, Baseline, Grid, Node-IDs, Camera Frustum, Light Helpers.

---

## Epic 4: Asset Pipeline und Medien-Nodes

### Story 4.1: Content Addressable Storage und Import

(FR-48..FR-50) Import jedes Formats aus FR-48; Datensatz mit allen Feldern aus FR-49; doppelter Import verarbeitet nichts neu (Zähler-Test).

### Story 4.2: Kontrollierter Asset-Fetcher

(FR-51) Remote-URLs werden vor dem Render geladen und gehasht; interne Adressen (169.254.0.0/16, private Netze) werden abgelehnt.

### Story 4.3: Bild, Video, Sprite, SpriteSheet, GIF, AVIF

(FR-28) Video-Frame-Zuordnung ist frame-genau (Test mit nummeriertem Testvideo); Normalisierung von AVIF und GIF.

### Story 4.4: SVG und Lottie

(FR-28, FR-48) SVG-Node rendert Pfade, Formen, Verläufe, Transforms; Nicht-Unterstütztes erzeugt Diagnose. Lottie über Skottie frame-genau.

---

## Epic 5: Audio, Untertitel, Voiceover

### Story 5.1: Audio-Mix

(FR-52, FR-53) Spuren, Volume-Automation, Pan, Fade, Crossfade, Ducking, Trim, Loop, Rate; Tests für Dauer, Sync und Pegel.

### Story 5.2: Audio-Mastering

(FR-54) EQ, Compressor, Limiter, Loudness-Normalisierung (Ziel ± 0,5 LU); Ergebnis deterministisch (Hash-Test).

### Story 5.3: Untertitel-Formate

(FR-55) SRT, WebVTT, ASS lesen; programmatische Untertitel.

### Story 5.4: Untertitel-Gestaltung

(FR-56) Wort-Hervorhebung, Karaoke, Sprecher-Stile, Wort-Animation, Boxen, Position, Safe Areas; Golden Tests.

### Story 5.5: Voice- und ASR-Provider

(FR-57..FR-59) VoiceProvider (Piper, espeak-ng, Kommando), AsrProvider (whisper.cpp, Kommando); Cache-Test: zweiter Build ruft den Provider nicht auf.

---

## Epic 6: Browser-Renderer: DOM und PixiJS

### Story 6.1: Browser-Host

(AD-13) Lokale Origin, Netzblockade, virtuelle Zeit, Pixel-Rückkanal; Test: `Date.now()` im Frame 30 ist deterministisch; Anfrage an externe URL scheitert.

### Story 6.2: HTML/CSS-Layer

(FR-36, FR-37) HTML, CSS, SVG, Canvas, Web Components, WebGL, WebGPU; CSS-Animationen werden auf Composition-Zeit gesetzt; Golden Tests.

### Story 6.3: PixiJS-Renderer

(FR-31) Dieselben 2D-Nodes wie Skia; Pixel-Diff gegen Skia innerhalb dokumentierter Toleranz; Capabilities dokumentiert.

---

## Epic 7: 3D mit Three.js

### Story 7.1: Szene, Kameras, Lichter, Meshes, Materialien
(FR-38) Golden Tests je Element.

### Story 7.2: Modelle und Animation
(FR-38, FR-39) glTF, GLB, OBJ; Animation Clips, Skelett, Morph Targets frame-genau.

### Story 7.3: Partikel, eigene Materialien, Shader
(FR-40) Partikel sind zustandslos (Frame n unabhängig von n-1).

### Story 7.4: Postprocessing
(FR-41) DoF, Bloom, Motion Blur, Color Grading, Nebel, Reflexionen, transparenter Hintergrund.

### Story 7.5: WebGPU/WebGL2-Auswahl
(FR-42) Explizite Wahl; WebGPU-only-Feature unter WebGL2 wird vor dem Render gemeldet.

---

## Epic 8: Blender-Backend

### Story 8.1: Blender headless
(FR-43) Cycles und Eevee, Kamera, Licht, Material, glTF, Volumen, Transparenz, Motion Blur, Pässe; Test läuft, wenn Blender vorhanden ist.

### Story 8.2: Capabilities und Vorab-Prüfung
(FR-44) Nicht unterstützte Features werden vor dem Render gemeldet.

---

## Epic 9: TSX-DSL, Compiler und Sandbox

### Story 9.1: SDK und JSX-Runtime
(FR-17) Das Beispiel aus A4 kompiliert zur IR.

### Story 9.2: Compiler mit Frame-Funktionen und JSON-Export
(FR-17a, FR-18) Frame-Funktionen werden zu `$sampled`; JSON-Export rendert bitgleich.

### Story 9.3: Container-Sandbox
(FR-70..FR-72) Security-Tests: Host-Datei, Netz, Docker-Socket, Metadaten, Fork-Bombe, Speicher, Timeout.

### Story 9.4: AST-Rückschreiben
(FR-76) `setProperty` auf eine TSX-Node ändert per AST nur das Attribut; Formatierung bleibt.

---

## Epic 10: Paralleles und verteiltes Rendering

### Story 10.1: Chunk-Scheduler und lokale Worker
(FR-66, FR-67) Dynamische Verteilung; fehlgeschlagener Chunk wird einzeln wiederholt.

### Story 10.2: Docker-Worker
(FR-66) Chunks laufen in `openvideo-worker`-Containern.

### Story 10.3: Koordinator für Remote-/Kubernetes-Worker
(FR-66, FR-91) Pull-basierte Worker über HTTP, Journal, S3-Speicher.

### Story 10.4: Telemetrie
(FR-92) Alle neun Metriken; eine Trace-ID über alle Spans eines Jobs.

---

## Epic 11: Studio

### Story 11.1: Studio-Grundgerüst und Vorschau
(FR-73, FR-75) Layout aus A25; Vorschau mit Frame-Stepping und Auflösungswechsel.

### Story 11.2: Bearbeitung auf der Bühne
(FR-74) Drag & Drop, Zoom/Pan, Snapping, Guides, Rulers, Mehrfachauswahl, Gruppieren, Sperren, Verbergen, Reihenfolge, Undo/Redo, Shortcuts, Copy/Paste, Duplizieren, Ausrichten, Verteilen.

### Story 11.3: Timeline, Keyframes, Kurven, Waveform
(FR-75) Timeline-Zoom, Waveform, Keyframe- und Kurven-Editor, Marker.

### Story 11.4: Code-Panel, Diagnosen, Render Queue, Roundtrip
(FR-76, FR-80) Monaco; Fehler an Node und Codezeile; Studio-Änderung erscheint im TSX-Code.

### Story 11.5: `openvideo create` und `openvideo dev`
(FR-80) In unter 3 Minuten zur Vorschau; Hot Reload.

---

## Epic 12: Komponenten, Themes, Templates

### Story 12.1: Theme-Tokens
(FR-83) Theme-Wechsel ändert alle Farben/Schriften eines Videos (Golden-Test vorher/nachher).

### Story 12.2: 29 Komponenten
(FR-82) Je Komponente ein Golden Test und ein Theme-Test.

### Story 12.3: 15 Templates
(FR-81) Jedes Template validiert und rendert einen Kontaktbogen.

---

## Epic 13: Importe und Adapter

### Story 13.1: SVG-, Lottie-, glTF-, HTML-Import
(FR-85) Verlustbehaftete Importe erzeugen Warnungen.

### Story 13.2: Anime.js-Adapter
(FR-86) `timeline().add(...)` wird zu `$keyframes`; Easing-Namen werden abgebildet.

### Story 13.3: Motion-Canvas-Adapter
(FR-85) Generator-Szenen (`yield* tween`) werden zu Keyframes.

---

## Epic 14: Betrieb, Qualität, Verteilung

### Story 14.1: Doctor
(FR-79) Prüft alle zwölf Punkte, nennt Lösungen, `--json`.

### Story 14.2: Lizenzinventar und Quality Gates
(FR-88, NFR-6) THIRD_PARTY_NOTICES, SBOM (CycloneDX), licenses.json; CI blockiert bei Verstoß; `npm audit` ab High.

### Story 14.3: Docker-Images
(FR-90) base, render-cpu, render-gpu, blender, studio, worker; versioniert, reproduzierbar (gepinnte Basis-Digests).

### Story 14.4: Kubernetes
(FR-91) Kustomize-Manifeste, Probes, Limits, KEDA-Autoscaling nach Queue-Länge, HPA nach CPU.

### Story 14.5: Benchmarks
(FR-94) Szenarien und Auflösungen aus A38; Regressionserkennung gegen gespeicherte Basis.

### Story 14.6: CI
(NFR-6, NFR-11) GitHub Actions: build, lint, test, golden, security, benchmark, Lizenz.

---

## Epic 15: Agent-Dokumentation, Definition of Done, Veröffentlichung

### Story 15.1: Agent-Dokumentation
(FR-93) AGENTS.md, llms.txt, JSON Schema, API-Referenz, Beispiele, Rezepte, Capability-Manifest.

### Story 15.2: Definition-of-Done-Test
(SM-1, SM-2) Ein Agent-Skript erzeugt über die API das 60-Sekunden-4K-Video mit allen 21 Bestandteilen, patcht, rendert neu und reproduziert es auf einem zweiten Worker.

### Story 15.3: Veröffentlichung
Öffentliches Repo `deltatree/agentic-video-engine`, README, CONTRIBUTING, SECURITY, CI grün.
