---
title: OpenVideo
status: final
created: 2026-09-28
updated: 2026-09-28
source: "Engineering Auftrag – Open Source Agentic Video Engine.md"
---

# PRD: OpenVideo

*Arbeitstitel. Der Name bleibt austauschbar (Auftrag Abschnitt 1).*

## 0. Zweck des Dokuments

Dieses PRD übersetzt den Engineering-Auftrag in prüfbare Anforderungen.
Leser sind Architektur, Epic-Planung, Entwicklung und Test.
Jede Anforderung hat eine feste Nummer (FR-n) und nennt ihren Auftragsabschnitt (A-n).
Technikentscheidungen stehen im Architektur-Dokument, nicht hier.
Offene Fragen und ihre Klärung stehen in Abschnitt 8.

## 1. Vision

OpenVideo ist eine Open-Source-Plattform für Video-as-Code.
Ein Coding Agent beschreibt ein Video als Daten oder Code.
OpenVideo rendert daraus Frames, zeigt dem Agenten das Ergebnis und nimmt gezielte Änderungen an.
Am Ende steht ein fertiges Video, das auf jeder zweiten Maschine gleich entsteht.

Der Kern ist ein eigenes, versioniertes Datenmodell: die Composition IR.
Renderer wie Skia, PixiJS, Chromium, Three.js und Blender sind austauschbare Ausführer dieses Modells.
Kein fremdes Framework bestimmt das Produktmodell.

Die entscheidende Produktmetrik: Wie zuverlässig erzeugt ein Coding Agent ein gutes Video, versteht das Ergebnis und verbessert es mit kleinen Änderungen? (A54)

## 2. Zielnutzer

### 2.1 Jobs To Be Done

- Ein Coding Agent will aus einer Absicht („Headline bei Frame 20 einblenden“) kleine, prüfbare Code- oder JSON-Strukturen erzeugen.
- Ein Coding Agent will sein Ergebnis sehen und messen, bevor er das ganze Video rendert.
- Ein Coding Agent will einzelne Eigenschaften ändern, ohne die Szene neu zu schreiben.
- Ein Entwickler will Videos wie Software bauen: versioniert, getestet, reproduzierbar.
- Ein Entwickler will ein Video visuell im Studio feinjustieren, ohne dass Code und Studio auseinanderlaufen.
- Ein Betreiber will Rendering sicher, isoliert und skaliert betreiben, lokal oder im Cluster.

### 2.2 Nicht-Nutzer

- Endkunden ohne Programmierkenntnis, die eine Schnittsoftware suchen.
- Echtzeit-Streaming und Live-Produktion.

### 2.3 Zentrale Nutzerreisen

- **UJ-1. Ada (Coding Agent) baut ein Produktvideo aus einem Prompt.**
  Ada erhält den Auftrag „60 Sekunden, 4K, Produkt-Launch“. Sie ruft `templates.list` auf und wählt „Product Launch“. Sie erzeugt die Composition als JSON und prüft sie mit `composition.validate`. Sie rendert die Frames 0, 90, 180 und 360 als Kontaktbogen und liest die Diagnose. Die Diagnose meldet Text-Überlauf an Node `headline`. Ada sendet einen Patch `setProperty(headline, fontSize, 82)`. Der neue Kontaktbogen ist sauber. Sie startet `video.render` und erhält MP4 und `render-manifest.json`.
  **Randfall:** Eine Schrift fehlt. Die Validierung meldet sie vor dem Render mit Lösungsvorschlag.
- **UJ-2. Ben (Entwickler) startet ein Projekt in wenigen Minuten.**
  Ben führt `openvideo create hello`, `cd hello` und `openvideo dev` aus. Das Studio öffnet sich mit einer lauffähigen Composition. Er ändert im Code eine Farbe; die Vorschau aktualisiert sich sofort. Er verschiebt im Studio einen Titel; die Änderung landet als AST-Änderung im TSX-Code.
  **Randfall:** Ein Tippfehler im Code erzeugt einen Fehler an der Node und an der Codezeile.
- **UJ-3. Cem (Betreiber) rendert im Cluster.**
  Cem installiert die Kubernetes-Manifeste. Ein Agent sendet einen Render-Job an die API. Der Scheduler verteilt Chunks auf Worker. Ein Worker stürzt ab; nur sein Chunk läuft erneut. Cem verfolgt den Job über eine Trace-ID in OpenTelemetry.
- **UJ-4. Ada verifiziert Reproduzierbarkeit.**
  Ada rendert dasselbe Projekt auf einem zweiten Worker. Die Frame-Hashes im Manifest stimmen überein.

## 3. Glossar

- **Project** — Oberste Einheit. Enthält Metadaten, Einstellungen, Compositions, Assets, Fonts, Audio und Render-Profile.
- **Composition** — Ein renderbares Video mit Maßen, fps, Dauer, Hintergrund, Tracks, Markern und Nodes.
- **Composition IR** — Das versionierte, serialisierbare Datenmodell aller Projects. Die eigentliche Plattform.
- **Node** — Ein Element im Szenenbaum mit stabiler ID, Typ und Eigenschaften.
- **Property** — Ein Wert einer Node. Statisch oder animiert.
- **Animation** — Eine Beschreibung, wie sich eine Property über die Zeit ändert (Keyframes, Spring, Expression, Sequenz …).
- **Frame** — Ein ganzzahliger Zeitpunkt einer Composition. Frame 0 ist der Anfang.
- **Seed** — Zahl, aus der alle Zufallswerte deterministisch folgen.
- **Evaluated Scene** — Alle Nodes einer Composition mit aufgelösten Property-Werten für genau einen Frame.
- **Renderer** — Ein Backend, das Nodes einer Evaluated Scene in Pixel übersetzt.
- **Layer** — Ein Zwischenergebnis eines Renderers als RGBA-Bild, das der Compositor verrechnet.
- **Compositor** — Verrechnet Layers zu einem Frame (Transform, Maske, Blend Mode, Farbe).
- **Asset** — Eine externe Datei (Bild, Video, Audio, Modell, Schrift, Lottie) mit Content-Hash.
- **Patch** — Eine semantische Änderung an der Composition IR (z. B. `setProperty`).
- **Capability** — Eine benannte Fähigkeit eines Renderers (z. B. `three.webgpu`).
- **Render Job** — Ein Auftrag, eine Composition ganz oder teilweise zu rendern.
- **Chunk** — Ein zusammenhängender Frame-Bereich eines Render Jobs.
- **Worker** — Ein Prozess, der Chunks rendert.
- **Render Manifest** — Datei `render-manifest.json` mit allen Eingaben und Versionen eines Renders.
- **Diagnostic** — Eine strukturierte Meldung (Fehler, Warnung, Hinweis) zu Node, Frame und Ursache.
- **Sandbox** — Isolierte Umgebung für nicht vertrauenswürdigen Code.
- **Studio** — Die visuelle Oberfläche zum Bearbeiten von Compositions.
- **Template** — Ein vollständiges Beispielprojekt als Quellcode.
- **Component** — Eine wiederverwendbare, animierbare Node-Gruppe (z. B. `LowerThird`).
- **Theme** — Ein Satz Design-Tokens (Farben, Schriften, Abstände …).
- **Plugin** — Eine Erweiterung, die Node-Typen, Renderer, Loader oder Werkzeuge hinzufügt.

## 4. Features

### 4.1 Composition IR und Schema (A3, A4)

**Beschreibung:** Die Composition IR beschreibt ein Project vollständig als Daten. JSON und TSX erzeugen dieselbe IR. Realisiert UJ-1, UJ-4.

#### FR-1: Versionierte IR-Struktur
Das System stellt die IR mit Project, metadata, settings, compositions (dimensions, fps, duration, background, tracks, markers, nodes), assets, fonts, audio und renderProfiles bereit.
- Jede IR-Datei trägt eine Schema-Version.
- Eine IR ohne Version wird mit Diagnose abgelehnt.

#### FR-2: Stabile Node-IDs
Jede Node besitzt eine im Project eindeutige, stabile ID.
- Doppelte IDs führen zu einem Validierungsfehler mit beiden Pfaden.
- Serialisieren und erneutes Laden ändert keine ID.

#### FR-3: Veröffentlichtes JSON Schema
Das System veröffentlicht die IR als JSON Schema.
- Das Schema liegt im Paket und im Repository.
- Jedes Beispielprojekt validiert gegen das Schema.

#### FR-4: Präzise Validierung
Das System validiert jede Composition vor dem Render.
- Eine Meldung nennt Pfad (z. B. `composition.hero.nodes.logo.scale.x`), Erwartung, erhaltenen Wert und einen Korrekturvorschlag.
- Ein Render mit ungültiger Composition startet nicht.

#### FR-5: Migration zwischen IR-Versionen
Das System migriert ältere IR-Versionen auf die aktuelle Version.
- Migration ist verlustfrei oder meldet jeden Verlust als Diagnose.

### 4.2 Determinismus und Reproduzierbarkeit (A2, A20)

#### FR-6: Frame als reine Funktion
Das System berechnet jeden Frame nur aus Composition, Assets, Frame-Nummer und Seed.
- Frame 471 ist bitgleich, egal ob Frame 470 vorher gerendert wurde.
- Zwei Renders desselben Frames in beliebiger Reihenfolge sind bitgleich.

#### FR-7: Verbotene Zeit- und Zufallsquellen
Renderer und Nutzer-Code erhalten keine Wall Clock, kein `requestAnimationFrame`, kein ungeseedetes `Math.random`.
- `Date.now()`, `performance.now()` und `Math.random()` liefern im Render-Kontext deterministische Werte.
- CSS-Animationen und Transitions laufen nicht auf der Browser-Uhr.

#### FR-8: Render Manifest
Jeder Render schreibt `render-manifest.json` mit: OpenVideo-Version, Composition-Hash, Asset-Hashes, Font-Hashes, Dependency-Versionen, Renderer-Versionen, Chromium-, FFmpeg-, Three.js-, PixiJS-, Skia- und Blender-Version, OS/Container-Image, GPU, Render-Backend, Auflösung, fps, Codec, Seed, Farbraum, Zeitstempel.
- Das Manifest validiert gegen ein veröffentlichtes JSON Schema.
- Fehlt eine Komponente (z. B. Blender), steht dort `null` mit Grund.
- Das Manifest enthält Frame-Hashes je Chunk.

#### FR-9: Reproduzierbarkeit auf zweitem Worker
Ein zweiter Worker erzeugt aus demselben Project dieselben Frames.
- Ein Test rendert auf zwei Workern und vergleicht Frame-Hashes.

### 4.3 Timeline Engine (A7)

#### FR-10: Zeiteinheiten
Autoren geben Zeit in Frames, Sekunden, Millisekunden oder SMPTE-Timecode an.
- `"2s"`, `"500ms"`, `48`, `"00:00:02:00"` bei 24 fps ergeben denselben Frame.

#### FR-11: Keyframes, Kurven, Easing, Springs
Properties animieren über Keyframes mit Bezier-Kurven, benannten Easings und Springs.
- Interpolation trifft jeden Keyframe exakt.
- Springs sind analytisch oder in festen Schritten berechnet, nie framerate-abhängig.

#### FR-12: Expressions
Properties dürfen sichere Ausdrücke (z. B. `sin(time * 2) * 40`) enthalten.
- Ausdrücke haben nur Zugriff auf `frame`, `time`, `fps`, `seed`, deklarierte Werte und Mathe-Funktionen.
- Ein Ausdruck ohne Zugriff auf Code-Ausführung ist in JSON erlaubt.

#### FR-13: Komposition von Animationen
Das System unterstützt Sequenzen, parallele Animationen, Stagger, Delays, Loops und Ping-Pong.

#### FR-14: Marker und Named Events
Compositions tragen Marker und benannte Ereignisse. Animationen referenzieren sie als Zeitpunkt.

#### FR-15: Transitions
Das System bietet Übergänge zwischen Szenen (z. B. Blende, Wipe, Slide).

#### FR-16: Verschachtelte Zeit
Das System unterstützt verschachtelte Timelines und Compositions, Time Stretch, Time Remapping, Reverse und Hold Frames.
- Eine verschachtelte Composition mit Remapping zeigt exakt den abgebildeten Frame.

### 4.4 TypeScript/JSX DSL (A4)

#### FR-17: TSX kompiliert zur IR
Autoren beschreiben Compositions in TSX. Das System kompiliert TSX zur IR.
- JSX ist reine Syntax; kein React-Lifecycle beeinflusst den Render.
- JSON und TSX desselben Videos erzeugen gleiche Frames.

#### FR-17a: JSON-Vollständigkeit
Jede TSX-Composition lässt sich als JSON exportieren. Das JSON rendert ohne Code-Ausführung bitgleiche Frames.
- Werte aus Frame-Funktionen landen als Keyframes (`$sampled`) im JSON.

#### FR-18: Frame-Funktionen
Szenen dürfen als Funktion von `frame` und `time` geschrieben sein.
- Der Compiler wertet die Funktion pro Frame aus und überführt veränderliche Werte in die IR.
- Werte, die dadurch nicht semantisch editierbar sind, meldet der Compiler als Hinweis.

### 4.5 Semantische Patches (A5, A27)

#### FR-19: Patch-Operationen
Das System bietet `setProperty`, `addNode`, `removeNode`, `moveNode`, `addKeyframe`, `removeKeyframe`, `replaceAsset`.
- Ein Patch ändert nur die genannten Stellen; alle anderen Bytes der IR bleiben gleich.

#### FR-20: Atomare, validierte Patches
Eine Patch-Liste wird ganz oder gar nicht angewendet.
- Ein ungültiger Patch liefert eine Diagnose und ändert nichts.
- Jeder Patch hat eine Umkehrung (Undo).

### 4.6 Agent API und MCP (A5)

#### FR-21: Agent API Server
Ein HTTP-Server bietet genau diese Operationen: `project.create`, `project.inspect`, `composition.create`, `composition.get`, `composition.validate`, `composition.patch`, `asset.import`, `asset.inspect`, `frame.render`, `frame.inspect`, `preview.render`, `preview.contactSheet`, `video.render`, `render.status`, `render.cancel`, `diagnostics.get`, `fonts.list`, `templates.list`, `templates.inspect`, `scene.describe`, `scene.tree`, `timeline.inspect`, `benchmark.run`.
- Ein Test ruft jede Operation einmal erfolgreich und einmal mit ungültiger Eingabe auf.
- Jede Operation hat ein Ein- und Ausgabe-Schema.

#### FR-22: MCP Server
Ein MCP-Server bietet dieselben Operationen als Tools.
- API und MCP nutzen eine gemeinsame Operationsdefinition.

#### FR-23: Render-Jobs steuern
Agents fragen den Status eines Render Jobs ab und brechen ihn ab.

### 4.7 Visual Feedback Loop (A6)

#### FR-24: Frames und Vorschauen
Agents rendern einzelne Frames, Frame-Listen, Kontaktbögen und Low-Res-Vorschauen.
- Ein Kontaktbogen zeigt Frame-Nummer und Zeit unter jedem Bild.

#### FR-25: Szenenbaum und Bounding Boxes
Das System liefert Szenenbaum und Bounding Box jeder Node für einen Frame.

#### FR-26: Diagnosen
Das System meldet Safe-Area-Verletzung, Überlauf, Text-Überlauf, fehlende Fonts, fehlende Assets, Layer-Probleme, GPU-Zustand und Render-Warnungen.

#### FR-27: Debug-Rendering
Optional zeichnet das System `showBounds`, `showAnchors`, `showSafeArea`, `showBaseline`, `showGrid`, `showNodeIds`, `showCameraFrustum`, `showLightHelpers`.

### 4.8 2D-Rendering (A9)

#### FR-28: 2D-Primitive
Das System rendert Group, Layer, Rect, RoundedRect, Circle, Ellipse, Line, Polyline, Polygon, Path, SVG, Text, RichText, Image, Video, Sprite, SpriteSheet.

#### FR-29: 2D-Effekte
Das System rendert Gradients, Shadows, Blur, Masken, Clipping, Filter und Blend Modes.

#### FR-30: Eigene Shader
Autoren dürfen eigene Shader für 2D-Nodes angeben.

#### FR-31: Zwei 2D-Backends
Ein GPU-2D-Backend (PixiJS) und ein High-Fidelity-Backend (Skia/CanvasKit) konsumieren dieselbe IR.
- Der Kern hängt von keinem der beiden ab.
- Unterschiede zwischen den Backends sind als Capabilities dokumentiert.

### 4.9 Typografie (A10)

#### FR-32: Fonts vor dem Render
Fonts werden vor dem Render geladen, validiert und gehasht.
- Kein Frame entsteht mit Ersatzschrift, ohne dass eine Diagnose das meldet.

#### FR-33: Textsatz
Das System unterstützt OpenType, Variable Fonts, Gewicht, Stretch, Font Features, Kerning, Ligaturen, Tracking, Zeilenhöhe, Ausrichtung, RTL, Unicode, Emoji und Umbruch.

#### FR-34: Text-Effekte
Das System unterstützt Text entlang eines Pfads, Text als Maske und Text mit Verlauf.

#### FR-35: Text-Animation
Das System animiert Text pro Zeichen, pro Wort und pro Zeile.

### 4.10 DOM/HTML/CSS (A11)

#### FR-36: HTML-Layer
Das System rendert HTML, CSS, SVG, Canvas, Web Components, WebGL und WebGPU in Chromium.
- Die Seite wird pro Frame auf den Composition-Zeitpunkt gesetzt.

#### FR-37: Keine Browser-Uhr
CSS-Animationen und `requestAnimationFrame` bestimmen nie den Frame-Inhalt.

### 4.11 3D-Engine (A12)

#### FR-38: 3D-Szenen
Das System rendert perspektivische und orthografische Kameras, Meshes, Instancing, glTF, GLB, OBJ, PBR-Materialien, Lichter, Schatten, Environment Maps und HDRI.

#### FR-39: 3D-Animation
Das System spielt Animation Clips, Skelett-Animation und Morph Targets frame-genau ab.

#### FR-40: Partikel, Materialien, Shader
Das System unterstützt Partikelsysteme, eigene Materialien und Shader.

#### FR-41: 3D-Postprocessing
Das System bietet Depth of Field, Bloom, Motion Blur, Color Grading, Nebel, Reflexionen und transparenten Hintergrund.

#### FR-42: Explizites Grafik-Backend
Autoren wählen WebGPU oder WebGL2 explizit; Standard ist „WebGPU bevorzugt, WebGL2 als Rückfall“.
- Ein Feature, das nur unter WebGPU existiert, wird vor dem Render gemeldet, wenn WebGL2 aktiv ist.

### 4.12 Blender-Backend (A13)

#### FR-43: Blender headless
Das System rendert 3D-Nodes mit Blender headless in Cycles oder Eevee, inklusive Kamera, Licht, Material, glTF, Volumen, PBR, Transparenz, Motion Blur, Depth-, Normal- und Objektmasken-Pässen.

#### FR-44: Capabilities und Vorab-Prüfung
Jeder Renderer veröffentlicht Capabilities. Der Validator meldet inkompatible Features vor dem Render.

### 4.13 Compositor und Farbe (A14, A39)

#### FR-45: Gemischte Layer
Eine Composition mischt DOM, SVG, PixiJS, Skia, Three.js, Blender, Video, Bild und Text.

#### FR-46: Layer-Eigenschaften
Jeder Layer hat z-Index, Opacity, Transform, Crop, Maske, Blend Mode, Effekte, Farbraum und Alpha.

#### FR-47: Color Management
Das System unterstützt sRGB, lineares RGB, Rec.709, definierte Transferfunktionen, Alpha und Premultiplied Alpha.
- Jede Farbraum-Umwandlung ist explizit in der IR oder im Render-Profil benannt.

### 4.14 Asset Pipeline (A15)

#### FR-48: Formate
Das System importiert PNG, JPEG, WebP, AVIF, SVG, GIF, MP4, WebM, MOV, WAV, FLAC, MP3, AAC, OGG, glTF, GLB, Fonts und Lottie JSON und normalisiert sie vor dem Render.

#### FR-49: Asset-Datensatz
Jedes Asset hat id, type, path, hash, metadata, duration, dimensions, codec, colorSpace, licenseMetadata.

#### FR-50: Content Addressable Storage
Assets liegen nach Hash gespeichert. Ein identisches Asset wird nie zweimal verarbeitet.

#### FR-51: Kontrollierter Asset-Fetcher
Remote-Assets lädt ein Fetcher vor jeder Code-Ausführung herunter.

### 4.15 Audio (A16)

#### FR-52: Audio-Spuren
Das System mischt mehrere Spuren: Voiceover, Musik, Soundeffekte.

#### FR-53: Audio-Bearbeitung
Das System unterstützt Volume-Automation, Pan, Fade, Crossfade, Ducking, Trim, Loop und Playback Rate.

#### FR-54: Audio-Mastering
Das System unterstützt EQ, Compressor, Limiter und Loudness-Normalisierung.
- Die Audio-Verarbeitung läuft offline und deterministisch.

### 4.16 Untertitel (A17)

#### FR-55: Untertitel-Formate
Das System liest SRT, WebVTT und ASS und erlaubt programmatische Untertitel.

#### FR-56: Untertitel-Gestaltung
Das System unterstützt Wort-Hervorhebung, Karaoke-Timing, Sprecher-Stile, Wort-Animation, Hintergrundboxen, dynamische Position und Safe Areas.

#### FR-57: ASR-Adapter
Transkription läuft über einen austauschbaren Open-Source-Adapter ohne feste Kopplung an den Kern.

### 4.17 Voiceover (A18)

#### FR-58: VoiceProvider
Das System bietet eine VoiceProvider-Schnittstelle mit lokal ausführbaren Open-Source-Adaptern.

#### FR-59: Voice-Cache
Erzeugte Stimmen sind Audio-Assets im Cache. Ein Build erzeugt eine vorhandene Stimme nie neu.

### 4.18 FFmpeg und Ausgabe (A19)

#### FR-60: Ausgabeformate
MP4, MOV, WebM, GIF, animiertes WebP, PNG-, JPEG- und WebP-Sequenz.

#### FR-60a: Alpha-Ausgabe
Das System exportiert Video mit Alpha-Kanal (ProRes 4444, WebM/VP9 mit Alpha) und Bildsequenzen mit Alpha.
- Ein Pixel mit Opacity 0,5 über transparentem Hintergrund hat im Export Alpha 128 ± 1.

#### FR-61: Codecs
H.264, H.265, VP9, AV1, ProRes (wenn verfügbar), verlustfreie Zwischenformate.

#### FR-62: Hardware-Encoding
Das System erkennt NVENC, VAAPI, VideoToolbox und weitere Encoder. CPU-Encoding ist immer verfügbar.

#### FR-63: Medien-Inspektion
Das System liest Codec, Metadaten und Thumbnails.

#### FR-64: Lizenz im Manifest
FFmpeg-Build und Codec-Lizenzen stehen im Build- und Render-Manifest.

### 4.19 Pipeline, paralleles Rendering, Cache (A21, A22, A23)

#### FR-65: Pipeline-Stufen
Der Render durchläuft die Stufen Parser/Compiler, Schema-Validierung, Composition IR, Dependency Graph, Asset Resolver, Timeline Evaluator, Frame Plan, Renderer Scheduler, Renderer, Layer Compositor, Frame Cache, Audio Pipeline, FFmpeg. Jede Stufe meldet Dauer und Fehler mit Stufenname.

#### FR-66: Chunk-Scheduling
Das System verteilt Chunks dynamisch auf lokale, Prozess-, Docker- und Kubernetes-Worker.

#### FR-67: Idempotente Jobs
Chunks sind idempotent. Ein fehlgeschlagener Chunk wird einzeln neu gerendert.

#### FR-68: Cache-Ebenen
Das System cacht Assets, Fonts, kompilierte Compositions, Frames, Layer, 3D-Geometrie, Shader, Audio und Encoding. Schlüssel sind Content-Hashes.

#### FR-69: Teil-Neurender
Ändern sich nur Frames 800–900, rendert das System nur diese Frames neu.

### 4.20 Sicherheit (A24)

#### FR-70: Sandbox
Nicht vertrauenswürdiger Code läuft isoliert: rootless, read-only, ohne Host-Mounts, mit CPU-, RAM-, Prozess- und Zeitlimits, seccomp und reduzierten Capabilities.

#### FR-71: Kein Netzwerk
Netzwerk ist während des Renderns standardmäßig aus.

#### FR-72: Kein Zugriff auf Geheimnisse
Agent-Code sieht kein Host-Dateisystem, keine Credentials, keinen Docker-Socket, keine Kubernetes-Credentials, keine Cloud-Metadaten, kein internes Netz.

### 4.21 Studio (A25, A26, A27)

#### FR-73: Studio-Layout
Das Studio zeigt Toolbar, Scene Tree, Assets, Components, Preview, Inspector, Properties, Effects, Timeline, Audio, Keyframes, Curves, Code, Diagnostics und Render Queue.

#### FR-74: Bearbeitung
Drag & Drop, Zoom/Pan, Snapping, Guides, Rulers, Safe Areas, Mehrfachauswahl, Gruppieren, Sperren, Verbergen, Ebenen-Reihenfolge, Undo/Redo, Tastenkürzel, Kopieren/Einfügen, Duplizieren, Ausrichten, Verteilen.

#### FR-75: Zeit-Werkzeuge
Timeline-Zoom, Waveform, Keyframe-Editor, Kurven-Editor, Marker, Frame-Stepping, Echtzeit-Vorschau, Auflösungswechsel.

#### FR-76: Ein Zustand für Code und Studio
Studio-Änderungen sind Patches auf der IR. TSX-Code wird per AST-Transformation zurückgeschrieben, nie per Textersetzung.
- Es gibt kein zweites Projektformat.

### 4.22 CLI und Developer Experience (A28, A41, A47)

#### FR-77: CLI-Befehle
`create`, `dev`, `studio`, `validate`, `render`, `render-frame`, `inspect`, `doctor`, `benchmark`, `cache`, `fonts`, `assets`.

#### FR-78: Maschinenlesbare Ausgabe
Jeder Befehl gibt mit `--json` strukturierte Ausgabe.

#### FR-79: Doctor
`openvideo doctor` prüft Node, Browser, WebGL, WebGPU, GPU, FFmpeg, Codecs, Blender, Fonts, Dateisystem, Docker, Hardware-Encoder und nennt Lösungen.

#### FR-80: Schneller Start
`openvideo create hello && cd hello && openvideo dev` öffnet das Studio mit einer lauffähigen Composition. Code-Änderungen aktualisieren die Vorschau sofort. Fehler erscheinen an Node und Codeposition.

### 4.23 Templates, Komponenten, Themes (A29, A30, A31)

#### FR-81: Templates
15 Templates aus A29 als lesbarer Quellcode.

#### FR-82: Komponenten
29 Komponenten aus A30, alle animierbar und themefähig.

#### FR-83: Theme-Tokens
colors, fonts, fontSizes, spacing, radii, shadows, motion, easing. Ein Theme-Wechsel rebrandet das ganze Video.

### 4.24 Plugins (A32)

#### FR-84: Plugin API
Plugins fügen Node-Typen, Renderer, Asset Loader, Effekte, Codecs, Voice- und ASR-Provider, Exporter, Studio-Panels und Agent-Tools hinzu. Jedes Plugin deklariert seine Capabilities; das System verweigert nicht deklarierte Zugriffe.

### 4.25 Import und Adapter (A8, A33)

#### FR-85: Importe
Import von SVG, Lottie, glTF, HTML/CSS, Motion-Canvas-artigen Szenen und Anime.js-artigen Timelines. Jeder verlustbehaftete Import meldet Warnungen.

#### FR-86: Anime.js-Adapter
`anime`-Adapter übersetzt Anime.js-artige APIs, Easings und Timelines in die Timeline IR. Er steuert nie die Render-Uhr.

### 4.26 Fehlererlebnis (A40)

#### FR-87: Strukturierte Fehler
Jeder Fehler nennt Fehlerklasse, Node, Frame, Problem, betroffene Daten und nummerierte Lösungen.

### 4.27 Verteilung und Betrieb (A42–A46)

#### FR-88: Lizenzinventar
Build erzeugt `THIRD_PARTY_NOTICES`, SBOM und `licenses.json`. Nicht OSI-konforme Runtime-Abhängigkeiten brechen den Build.

#### FR-89: Offline-Betrieb
create, edit, preview, render, encode, inspect und test laufen ohne Internet.

#### FR-90: Docker-Images
Images `base`, `render-cpu`, `render-gpu`, `blender`, `studio`, `worker`, reproduzierbar gebaut und versioniert.

#### FR-91: Kubernetes
Manifeste für API, Scheduler, Render-, GPU- und Blender-Worker, Object Storage, Cache, Queue und Studio; Autoscaling nach Queue-Länge, CPU, GPU und Render-Dauer.
- Jeder Dienst hat Liveness- und Readiness-Probes sowie Resource Requests und Limits.
- Ein Test erzeugt künstliche Queue-Last und prüft das Hochskalieren.

#### FR-92: Observability
OpenTelemetry-Metriken `render_duration`, `frame_duration`, `queue_wait`, `cache_hits`, `cache_misses`, `worker_failures`, `gpu_memory`, `cpu_usage`, `encoding_duration` und Traces über verteilte Jobs.
- Alle Spans eines verteilten Render Jobs tragen dieselbe Trace-ID.

### 4.28 Dokumentation für Agents (A48)

#### FR-93: Agent-Dokumentation
AGENTS.md, llms.txt, JSON Schema, API-Referenz, Beispiele, Rezepte, Capability-Manifest. Jede API hat ein kleines Beispiel.

### 4.29 Benchmarks (A38)

#### FR-94: Benchmark-Suite
Reproduzierbare Benchmarks für 1080p30, 1080p60, 4K30, 4K60 und die Szenarien aus A38. Gemessen werden die Werte aus A38. Regressionen werden automatisch erkannt.

### 4.30 Qualität und Engineering (A34–A37, A42, A49, A51, A52)

Diese Anforderungen gelten systemweit.

- **NFR-1 Architekturgrenzen:** Paketabhängigkeiten sind gerichtet und zyklenfrei. `core`, `schema` und `timeline` importieren kein Renderer-, Studio- oder FFmpeg-Paket. Ein Build-Check bricht bei Verstoß.
- **NFR-2 Striktes TypeScript:** Strengster Compiler-Modus. `any`, `@ts-ignore`, ungeprüfte Casts und leere `catch`-Blöcke brechen den Lint. Ausnahmen brauchen eine begründete Kommentarzeile.
- **NFR-3 Öffentliche API:** Jede exportierte API hat Typen, TSDoc, ein Beispiel und einen Test.
- **NFR-4 ADRs:** Jede Architekturentscheidung steht als ADR in `docs/adr/`.
- **NFR-5 Testarten:** Unit (Core, Timeline, Math, Schema, Asset Pipeline), Property-Based (Timeline, Interpolation), Integration (Composition → Renderer → Frame, je Renderer), Golden Image, Pixel Diff mit Toleranz, Audio (Dauer ± 1 Frame, Sync ± 1 Frame, Pegel ± 0,5 LU), End-to-End (Composition → MP4), Determinismus (Frame mehrfach, auf zwei Workern), Security (Host-Datei, Netzwerk, Docker-Socket, Metadaten-Endpunkt, Fork-Bombe, Speicher-Überlauf), Performance (2D, 3D, DOM, 4K, ≥ 1000 Assets).
- **NFR-6 Quality Gates:** Merge gesperrt bei TypeScript-Fehler, Lint-Fehler, Unit-Test-Fehler, E2E-Fehler, Golden-Regression ohne Freigabe, Schwachstelle ab Severity High, Lizenzverstoß, Schema-Bruch ohne Versionssprung.
- **NFR-7 Lizenz:** OpenVideo steht unter Apache-2.0. Jedes Paket trägt die Lizenz.
- **NFR-8 API-Prinzipien:** Jede öffentliche API ist deklarativ, kombinierbar, stark typisiert, auffindbar, deterministisch, serialisierbar, patchbar, versionierbar und agent-freundlich. Keine versteckten Zustände, keine Magie, keine globalen Singletons.
- **NFR-9 Vollständigkeit:** Produktcode enthält keine TODO-Platzhalter, keine Fake- oder Mock-Features, keine deaktivierten Buttons für geplante Funktionen, keine unimplementierten Interface-Methoden. Die Doku beschreibt nur Funktionierendes.
- **NFR-10 Vorgehen:** Zuerst entstehen die sieben Grenzen Composition IR, Timeline, Frame Evaluation, Renderer Interface, Asset Model, Plugin Interface, Agent Interface. Danach folgen vertikale End-to-End-Slices.
- **NFR-11 Slice-Checks:** Nach jedem Slice laufen build, lint, test, Render der Test-Compositions, Golden-Vergleich, Benchmark und Security-Checks. Der Hauptzweig ist nach jedem Commit baubar.
- **NFR-12 Alpha:** Alpha bleibt vom Renderer über den Compositor bis zum Encoder erhalten.
- **NFR-13 Abnahme für Aufzählungen:** Jedes in einer FR aufgezählte Element hat mindestens einen automatisierten Test: Golden Test für Bilder, ffprobe-Test für Medien, UI-Test für Studio-Funktionen.

## 5. Nicht-Ziele

- Kein Wrapper um ein einzelnes Framework. Remotion ist keine Abhängigkeit.
- Kein eigenes Cloud-Angebot; Cloud ist nur Skalierung.
- Kein proprietäres zweites Projektformat für das Studio.
- Keine Echtzeit-Übertragung (Streaming).

## 6. Umfang

Es gibt keine Rückstellung (A51). Alle FR-1 bis FR-94 gehören zum Zielprodukt. Die Reihenfolge folgt technischen Abhängigkeiten (A52).

## 7. Erfolgsmetriken

**Primär**
- **SM-1**: Definition of Done aus A50 — ein Agent erzeugt über dokumentierte APIs ein 60-Sekunden-4K-Video mit allen 21 Bestandteilen, rendert Frames, inspiziert, patcht, rendert neu und erzeugt das Video. Ein zweiter Worker reproduziert es. Ziel: automatisierter End-to-End-Test grün. Validiert FR-1 bis FR-64 und NFR-5.
- **SM-2**: Frame-Determinismus — Anteil bitgleicher Frames bei Doppel-Render. Ziel: 100 % für Skia, Chromium/SwiftShader und Compositor. Validiert FR-6, FR-9.

**Sekundär**
- **SM-3**: Zeit bis zur ersten Vorschau nach `openvideo create` — Ziel: unter 3 Minuten bei vorhandenem Browser. Validiert FR-80.
- **SM-4**: Durchsatz 1080p30 Text-/Vektor-Szene auf 16 CPU-Kernen ohne GPU — Ziel: mindestens 30 Frames pro Sekunde mit parallelen Workern. Validiert FR-66, FR-94.

**Gegenmetriken**
- **SM-C1**: Anzahl API-Primitive. Nicht maximieren; wenige orthogonale Primitive (A48). Gleicht SM-1 aus.
- **SM-C2**: Render-Geschwindigkeit auf Kosten des Determinismus. Nie gegen SM-2 tauschen.

## 8. Offene Fragen und Klärung

Alle Fragen sind im Modus „fully autonomous“ entschieden. Jede Entscheidung ist umkehrbar und in `.memlog.md` protokolliert.

1. **Paketname?** `openvideo` ist auf npm vergeben. → Scope `@agentic-video/*`, CLI `openvideo`, Name über eine Konstante austauschbar.
2. **Wie läuft TSX-Code ohne Host-Ausführung?** → Nicht vertrauenswürdiger Code (TSX, Skripte in HTML-Layern) läuft immer in einem Container ohne Netz (A24). Agent API und MCP erzwingen das. Nur für eigene Projekte darf ein Entwickler mit dem ausdrücklichen Schalter `--trusted` auf dem Host rendern; das Render Manifest vermerkt das. JSON-Compositions ohne HTML-Skripte führen keinen Code aus.
3. **Keine GPU auf der Entwicklungsmaschine?** → WebGL2 und WebGPU laufen über SwiftShader. GPU-Pfade (NVENC, CUDA-Image) sind über Capability-Erkennung abgedeckt und in CI ohne GPU nur auf Erkennung getestet.
4. **Welche lokale TTS/ASR?** → Adapter für Piper und espeak-ng (TTS), whisper.cpp (ASR) sowie ein generischer Kommando-Adapter. Alle laufen als externe Prozesse.
5. **Toleranz für Golden-Tests?** → Maximale Kanalabweichung 2 von 255, höchstens 0,1 % abweichende Pixel. Standard-Renderer müssen bitgleich sein.
6. **Standard-Arbeitsfarbraum?** → sRGB mit Blending im sRGB-Raum (wie CSS). Lineares Blending ist pro Composition wählbar.
7. **Object Storage im Cluster?** → S3-kompatibel (MinIO im Manifest). Lokal: Dateisystem.
8. **Queue im Cluster?** → Der Scheduler hält die Queue selbst mit Journal auf dem Volume. Keine zusätzliche Queue-Software.
9. **Container-Registry?** → GitHub Container Registry `ghcr.io/deltatree/openvideo-*`, weil `openvideo` auf Docker Hub nicht uns gehört.
10. **Dokumentationssprache?** → Deutsch, gemäß AGENTS.local.md. Bezeichner und Code bleiben Englisch.

## 9. Annahmen

- Nutzer haben Node 22.13 oder neuer.
- Chromium wird von Playwright heruntergeladen oder liegt im Docker-Image.
- FFmpeg ist installiert oder liegt im Docker-Image; OpenVideo bündelt FFmpeg nicht.
- Blender ist optional; ohne Blender meldet der Validator Blender-Nodes als nicht renderbar.
