# Auftrag: Baue die weltweit beste Open-Source-Plattform für programmatische Videogenerierung durch Coding Agents

## 1. Mission

Entwickle eine vollständig Open-Source-basierte, produktionsreife Plattform für **Video-as-Code**, die primär dafür optimiert ist, von AI Coding Agents benutzt zu werden.

Das Produkt soll Coding Agents in die Lage versetzen, aus Code hochwertige Videos zu erzeugen, visuell zu überprüfen, iterativ zu verändern und reproduzierbar zu rendern.

Das System muss gleichzeitig beherrschen:

- professionelle 2D Motion Graphics
- SVG und Vektorgrafik
- Text und Typografie
- HTML/CSS/DOM-basierte Szenen
- Canvas-basierte Grafik
- GPU-beschleunigte 2D-Grafik
- 3D-Szenen
- Kameras, Licht, Materialien und Shader
- Partikelsysteme
- Bilder
- bestehende Videos
- Audio
- Voiceover
- Musik
- Soundeffekte
- Untertitel
- Diagramme und Datenvisualisierungen
- Code-Darstellungen und Syntax Highlighting
- mathematische Visualisierungen
- Lottie
- glTF/GLB
- Postprocessing
- Masken
- Blend Modes
- Compositing
- transparente Videos und Bildsequenzen
- professionelle Video- und Audioformate

Das Ergebnis darf kein Demo-Projekt, kein Proof of Concept und kein Wrapper um eine einzelne bestehende Library sein.

Es soll eine **eigenständige Video-Generation-Plattform** entstehen.

Arbeitstitel:

**OpenVideo**

Der Name muss technisch austauschbar bleiben.

---

# 2. Oberstes Architekturprinzip

Das wichtigste Designprinzip lautet:

> Video ist eine deterministische Funktion von Composition + Assets + Frame + Seed.

Für einen Frame `f` muss gelten:

`frame = render(composition, assets, f, seed)`

Ein Render darf niemals davon abhängen von:

- `requestAnimationFrame`
- Wall Clock
- Rendering-Geschwindigkeit
- Netzwerk-Latenz
- `Date.now()`
- nicht deterministischem `Math.random()`
- UI-Zustand
- vorherigen Frames, sofern dies nicht explizit modelliert ist

Frame 471 muss unabhängig davon identisch renderbar sein, ob vorher Frame 470 berechnet wurde.

Das ermöglicht:

- reproduzierbare Builds
- paralleles Rendering
- Distributed Rendering
- Frame-Caching
- Render Farms
- zuverlässige AI-Agent-Interaktion
- Pixel-Diff-Tests
- exaktes Seeking
- deterministische Tests

---

# 3. Keine Library darf das Produktmodell definieren

OpenVideo benötigt ein eigenes, stabiles Intermediate Representation Model:

**OpenVideo Composition IR**

Dieses IR ist die eigentliche Plattform.

Nicht React.

Nicht Three.js.

Nicht PixiJS.

Nicht Anime.js.

Nicht Motion Canvas.

Nicht Blender.

Nicht Chromium.

Alle diese Systeme sind Renderer, Adapter oder Integrationen.

Das Composition IR muss versioniert, vollständig validierbar und serialisierbar sein.

Mindestens:

```text
Project
 ├── metadata
 ├── settings
 ├── compositions[]
 │    ├── dimensions
 │    ├── fps
 │    ├── duration
 │    ├── background
 │    ├── tracks[]
 │    ├── markers[]
 │    └── nodes[]
 ├── assets[]
 ├── fonts[]
 ├── audio[]
 └── renderProfiles[]
```

Jeder Node besitzt eine stabile ID.

Dadurch können Agents einzelne Elemente verändern, ohne komplette Dateien neu schreiben zu müssen.

---

# 4. Zwei APIs gleichzeitig

OpenVideo muss zwei gleichwertige Authoring-Modelle anbieten.

## TypeScript/JSX DSL

Für Menschen und Coding Agents:

```tsx
export default composition({
  width: 1920,
  height: 1080,
  fps: 60,
  duration: "12s",

  scene: ({frame, time}) => (
    <Scene background="#080A10">

      <Camera3D
        id="camera"
        position={animate(
          [0, 2, 8],
          [0, 1, 5],
          {from: 0, to: 4, ease: "easeInOutCubic"}
        )}
      />

      <ThreeScene camera="camera">
        <AmbientLight intensity={0.3} />

        <DirectionalLight
          position={[5, 8, 3]}
          intensity={3}
        />

        <Model
          src="./assets/product.glb"
          rotationY={time * 0.4}
        />
      </ThreeScene>

      <Text
        id="headline"
        text="The future is programmable."
        font="Inter"
        fontSize={92}
        x={120}
        y={760}
        opacity={spring({frame, from: 20})}
      />

      <SubtitleTrack src="./audio/voiceover.srt" />

    </Scene>
  )
});
```

JSX ist ausschließlich Authoring Syntax.

Es wird in das Composition IR kompiliert.

Der Renderer darf nicht von React Lifecycle Semantik abhängig sein.

## JSON Composition API

Dasselbe Video muss vollständig als JSON darstellbar sein.

Damit können LLMs und andere Systeme Videos ohne freie Codeausführung erzeugen.

Das Schema muss über JSON Schema veröffentlicht werden.

Jede Composition muss vor Rendering validiert werden.

Fehlermeldungen müssen präzise sein:

```text
composition.hero.nodes.logo.scale.x

Expected number >= 0
Received: "large"

Suggested fix:
scale: { x: 1.2, y: 1.2 }
```

---

# 5. Agent-First Design

Coding Agents sind First-Class User.

Baue deshalb zusätzlich zum SDK einen eigenen:

**OpenVideo Agent API Server**

und einen:

**OpenVideo MCP Server**

Der Agent muss mindestens folgende Operationen besitzen:

```text
project.create
project.inspect

composition.create
composition.get
composition.validate
composition.patch

asset.import
asset.inspect

frame.render
frame.inspect

preview.render
preview.contactSheet

video.render

render.status
render.cancel

diagnostics.get

fonts.list

templates.list
templates.inspect

scene.describe
scene.tree

timeline.inspect

benchmark.run
```

Besonders wichtig:

Ein Agent darf nicht gezwungen sein, jedes Mal eine komplette Composition neu zu schreiben.

Implementiere semantische Patches:

```text
setProperty(nodeId, property, value)
addNode(parentId, node)
removeNode(nodeId)
moveNode(nodeId, parentId)
addKeyframe(...)
removeKeyframe(...)
replaceAsset(...)
```

Damit kann ein Agent beispielsweise sagen:

> Ändere nur die Headline auf 82 px und verschiebe sie 40 px nach oben.

ohne die gesamte Szene neu zu generieren.

---

# 6. Visual Feedback Loop für AI Agents

Dies ist ein Kernfeature.

Coding Agents müssen das Ergebnis ihrer Arbeit visuell beurteilen können.

Implementiere:

```text
renderFrame(frame)
renderFrames([0, 30, 60, 90])
renderContactSheet(...)
renderPreview(...)
```

Zusätzlich:

- Scene Tree
- Bounding Boxes
- Safe Areas
- Overflow Detection
- Text Overflow
- Missing Fonts
- Missing Assets
- Layer Diagnostics
- GPU Diagnostics
- Render Warnings

Ein Agent soll einen Render erzeugen, visuell analysieren und danach gezielt korrigieren können.

Implementiere optionales Debug Rendering:

```text
showBounds
showAnchors
showSafeArea
showBaseline
showGrid
showNodeIds
showCameraFrustum
showLightHelpers
```

---

# 7. Timeline Engine

Entwickle eine eigene Timeline Engine.

Sie ist das Herz des Systems.

Unterstützt werden müssen:

- absolute Zeit
- Frames
- Sekunden
- SMPTE Timecode
- Keyframes
- Bezier Curves
- Springs
- Easing Functions
- Expressions
- Sequenzen
- parallele Animationen
- Stagger
- Delays
- Loops
- Ping-Pong
- Markers
- Named Events
- Transitions
- Nested Timelines
- Nested Compositions
- Time Stretch
- Time Remapping
- Reverse
- Hold Frames

Alle Animationen müssen ausschließlich aus `frame`, `fps`, `seed` und deklarierter Composition berechenbar sein.

---

# 8. Anime.js

Anime.js darf integriert werden, aber nicht die zentrale Timeline darstellen.

Baue:

`@openvideo/anime`

Der Adapter soll Anime.js-artige APIs, Easings und Timeline-Konzepte in OpenVideo Timeline IR übersetzen.

Anime.js darf niemals die globale Render Clock kontrollieren.

---

# 9. 2D Rendering

Baue eine hochwertige 2D-Abstraktion mit:

- Group
- Layer
- Rect
- RoundedRect
- Circle
- Ellipse
- Line
- Polyline
- Polygon
- Path
- SVG
- Text
- RichText
- Image
- Video
- Sprite
- SpriteSheet
- Gradient
- Shadow
- Blur
- Mask
- Clipping
- Filters
- Blend Modes
- custom shaders

Primärer GPU-2D-Renderer:

**PixiJS**

Zusätzlicher High-Fidelity-Renderer:

**Skia / CanvasKit**

Der Core darf von keinem davon abhängig sein.

Beide konsumieren dasselbe Composition IR.

---

# 10. Typografie

Textqualität ist ein kritisches Qualitätsmerkmal.

Unterstütze:

- OpenType Fonts
- Variable Fonts
- Font Weight
- Font Stretch
- Font Features
- Kerning
- Ligatures
- Tracking
- Line Height
- Text Alignment
- RTL
- Unicode
- Emoji
- Text Wrapping
- Text Along Path
- Text Masks
- Text Gradients
- Per-character animation
- Per-word animation
- Per-line animation

Fonts müssen vor Rendering geladen und validiert werden.

Kein Render darf wegen verspätetem Font Loading andere Layouts erzeugen.

Font-Dateien werden gehasht und Teil des Reproducibility Manifest.

---

# 11. DOM / HTML / CSS Renderer

OpenVideo muss vollständige HTML/CSS Motion Graphics unterstützen.

Dafür existiert:

`@openvideo/renderer-browser`

Rendering über Chromium.

Orchestrierung über Playwright.

Unterstützt:

- HTML
- CSS
- SVG
- Canvas
- Web Components
- CSS transforms
- CSS filters
- CSS masks
- gradients
- typography
- WebGL
- WebGPU

Animationen dürfen trotzdem nicht von CSS Animation Clock oder `requestAnimationFrame` abhängen.

OpenVideo setzt für jeden Frame explizit den Composition-Zeitpunkt.

---

# 12. 3D Engine

Primärer Echtzeit-3D-Renderer:

**Three.js**

Implementiere:

`@openvideo/three`

Unterstütze:

- Perspective Camera
- Orthographic Camera
- Mesh
- Instancing
- glTF
- GLB
- OBJ soweit sinnvoll
- PBR Materials
- Lights
- Shadows
- Environment Maps
- HDRI
- Animation Clips
- Skeleton Animation
- Morph Targets
- Particles
- custom materials
- shaders
- postprocessing
- depth of field
- bloom
- motion blur
- color grading
- fog
- reflections
- transparent backgrounds

Renderer-Auswahl:

```text
WebGPU preferred
WebGL2 fallback
```

Das Backend muss explizit konfigurierbar sein.

WebGPU-spezifische Features dürfen nicht stillschweigend zu inkompatiblen Ergebnissen führen.

---

# 13. Blender Backend

Für High-End-3D implementiere zusätzlich:

`@openvideo/renderer-blender`

Blender wird headless ausgeführt.

Unterstützt:

- Cycles
- Eevee
- Camera
- Lights
- Materials
- glTF
- volumetric effects
- physically based rendering
- transparent output
- motion blur
- depth passes
- normal passes
- object masks

Das Blender Backend muss dasselbe Timeline-/Composition-Konzept konsumieren.

Für nicht 1:1 übertragbare Features existieren Backend Capabilities.

Beispiel:

```ts
capabilities.blender.cycles
capabilities.three.webgpu
capabilities.browser.dom
```

Der Validator muss vor Rendering inkompatible Features erkennen.

---

# 14. Compositor

Entwickle einen eigenen Layer Compositor.

Eine Composition darf gleichzeitig enthalten:

```text
DOM
+
SVG
+
PixiJS
+
Skia
+
Three.js
+
Blender Render
+
Video
+
Image
+
Text
```

Layer besitzen:

- z-index
- opacity
- transform
- crop
- mask
- blend mode
- effects
- color space
- alpha

Zwischenergebnisse werden als RGBA Frames oder GPU Textures behandelt.

Unterstütze Alpha durch die gesamte Pipeline.

---

# 15. Asset Pipeline

Alle Assets werden vor Rendering normalisiert.

Asset Manager unterstützt:

- PNG
- JPEG
- WebP
- AVIF
- SVG
- GIF
- MP4
- WebM
- MOV
- WAV
- FLAC
- MP3
- AAC
- OGG
- glTF
- GLB
- fonts
- Lottie JSON

Jedes Asset erhält:

```text
id
type
path
hash
metadata
duration
dimensions
codec
colorSpace
licenseMetadata
```

Implementiere Content Addressable Storage.

Hash-basierter Cache.

Ein identisches Asset darf nie zweimal verarbeitet werden.

---

# 16. Audio Engine

Audio darf nicht als Nebenthema behandelt werden.

Unterstütze:

- mehrere Audio Tracks
- Voiceover
- Musik
- Sound Effects
- Volume Automation
- Pan
- Fade
- Crossfade
- Ducking
- Trim
- Loop
- Playback Rate
- EQ
- Compressor
- Limiter
- Loudness Normalization

Finale Audio-Verarbeitung erfolgt offline und deterministisch.

FFmpeg ist die zentrale Media Engine.

---

# 17. Untertitel

Native Subtitle Engine:

- SRT
- WebVTT
- ASS
- programmatic captions

Unterstütze:

- Word Highlighting
- Karaoke Timing
- Speaker Styles
- per-word animation
- background boxes
- dynamic positioning
- safe areas

Automatische Transkription kann über einen Open-Source-ASR-Adapter erfolgen.

Die ASR-Engine darf nicht fest mit dem Core gekoppelt werden.

---

# 18. Voiceover

Implementiere eine Provider-Abstraktion:

```text
VoiceProvider
```

mit lokal ausführbaren Open-Source-Adaptern.

Voice Assets werden nach Erzeugung wie normale Audio Assets behandelt und gecacht.

Das Rendern eines Videos darf niemals bei jedem Build eine Voice erneut erzeugen.

---

# 19. FFmpeg Pipeline

Implementiere FFmpeg als klar isolierte Media-Schicht.

Aufgaben:

- Encoding
- Decoding
- Resampling
- Audio Mixing
- Muxing
- Video Composition
- Codec Inspection
- Metadata
- Thumbnail Extraction

Unterstützte Outputs mindestens:

- MP4
- MOV
- WebM
- GIF
- animated WebP
- PNG sequence
- JPEG sequence
- WebP sequence

Codecs:

- H.264
- H.265/HEVC
- VP9
- AV1
- ProRes soweit verfügbar
- lossless intermediate formats

Unterstütze Hardware Encoding, wenn vorhanden:

- NVENC
- VAAPI
- VideoToolbox
- weitere über Capability Detection

CPU-Fallback ist zwingend.

FFmpeg-Build und verwendete Codec-Lizenzen müssen im Build Manifest dokumentiert werden.

---

# 20. Reproducibility

Jeder Render erzeugt:

`render-manifest.json`

mit mindestens:

```text
OpenVideo version
Composition hash
Asset hashes
Font hashes
dependency versions
renderer versions
Chromium version
FFmpeg version
Three.js version
PixiJS version
Skia version
Blender version
OS/container image
GPU
render backend
resolution
fps
codec
seed
color space
timestamp
```

Bei identischen Inputs muss das System soweit technisch möglich identische Frames erzeugen.

---

# 21. Rendering Architecture

Pipeline:

```text
Agent / Developer
        ↓
TypeScript / JSX / JSON
        ↓
Parser / Compiler
        ↓
Schema Validation
        ↓
OpenVideo Composition IR
        ↓
Dependency Graph
        ↓
Asset Resolver
        ↓
Timeline Evaluator
        ↓
Frame Plan
        ↓
Renderer Scheduler
        ↓
2D / DOM / Three / Blender
        ↓
Layer Compositor
        ↓
Frame Cache
        ↓
Audio Pipeline
        ↓
FFmpeg
        ↓
Final Video
```

---

# 22. Parallel Rendering

Frames müssen unabhängig renderbar sein.

Beispiel:

```text
Worker 1 → Frames 0–299
Worker 2 → Frames 300–599
Worker 3 → Frames 600–899
Worker 4 → Frames 900–1199
```

Noch besser:

Chunk Scheduling mit dynamischer Work Distribution.

Implementiere:

- local workers
- process workers
- Docker workers
- Kubernetes workers

Jobs müssen idempotent sein.

Fehlgeschlagene Chunks können einzeln erneut gerendert werden.

---

# 23. Cache

Implementiere mehrere Cache-Ebenen:

```text
Asset Cache
Font Cache
Compiled Composition Cache
Frame Cache
Layer Cache
3D Geometry Cache
Shader Cache
Audio Cache
Encoding Cache
```

Cache Keys müssen Content Hashes verwenden.

Wenn nur Frames 800–900 verändert wurden, darf das System nicht unnötig das gesamte Video neu rendern.

---

# 24. Security

Agent-generierter Code ist grundsätzlich **untrusted code**.

Keine Ausführung direkt auf dem Host.

Rendering Worker laufen:

- rootless
- isoliert
- mit Read-only Base Filesystem
- ohne Host Mounts
- mit Resource Limits
- CPU Limit
- RAM Limit
- GPU Quota
- Execution Timeout
- Process Limit
- seccomp
- eingeschränkten Linux Capabilities

Netzwerkzugriff während des Renderings:

**standardmäßig deaktiviert.**

Remote Assets werden vor der Codeausführung von einem kontrollierten Asset Fetcher heruntergeladen.

Agent-Code erhält keinen direkten Zugriff auf:

- Host Filesystem
- Credentials
- Docker Socket
- Kubernetes Credentials
- Cloud Metadata Endpoints
- interne Netzwerke

---

# 25. Studio

Baue zusätzlich ein erstklassiges visuelles Studio.

Kein reiner Code Editor.

Layout:

```text
┌───────────────────────────────────────────────────┐
│ Toolbar                                           │
├──────────────┬──────────────────────┬─────────────┤
│ Scene Tree   │                      │ Inspector   │
│ Assets       │      Preview         │ Properties  │
│ Components   │                      │ Effects     │
│              │                      │             │
├──────────────┴──────────────────────┴─────────────┤
│ Timeline / Audio / Keyframes / Curves             │
├───────────────────────────────────────────────────┤
│ Code / Diagnostics / Render Queue                 │
└───────────────────────────────────────────────────┘
```

Technologie:

- React
- TypeScript
- Monaco Editor

---

# 26. Studio UX

Die UX muss sich an professionellen Kreativwerkzeugen orientieren, aber radikal einfacher sein.

Unterstütze:

- Drag & Drop
- Zoom/Pan
- snapping
- guides
- rulers
- safe areas
- multi-select
- grouping
- locking
- hiding
- layer ordering
- undo/redo
- keyboard shortcuts
- copy/paste
- duplicate
- alignment
- distribution
- responsive inspector
- timeline zoom
- waveform display
- keyframe editor
- graph/curve editor
- markers
- frame stepping
- realtime preview
- resolution switching

Änderungen im visuellen Editor müssen denselben Composition State verändern wie Änderungen im Code.

Kein zweites proprietäres Projektformat.

---

# 27. Code ↔ Visual Roundtrip

Dies ist zwingend.

Code und Studio dürfen nicht auseinanderlaufen.

Architektur:

```text
TypeScript
      ↓
Composition IR
      ↕
Studio
      ↓
Semantic Patch
```

Der Editor manipuliert primär IR/Patches.

Wenn Änderungen zurück in TypeScript geschrieben werden können, verwende AST-basierte Transformationen.

Keine String-Replacements.

---

# 28. CLI

Erstelle eine ausgezeichnete CLI.

Beispiele:

```text
openvideo create
openvideo dev
openvideo studio
openvideo validate
openvideo render
openvideo render-frame
openvideo inspect
openvideo doctor
openvideo benchmark
openvideo cache
openvideo fonts
openvideo assets
```

Beispiel:

```text
openvideo render src/video.tsx \
  --composition hero \
  --format mp4 \
  --codec h264 \
  --width 3840 \
  --height 2160 \
  --fps 60
```

CLI-Ausgaben müssen sowohl human-readable als auch maschinenlesbar sein:

```text
--json
```

---

# 29. Templates

Liefere hochwertige Templates mit:

- Product Launch
- SaaS Explainer
- Logo Reveal
- Social Video
- YouTube Intro
- Presentation
- Data Visualization
- Code Tutorial
- Architecture Diagram
- 3D Product Showcase
- Lower Third
- Subtitle Video
- Podcast Clip
- Cinematic Title
- Comparison Video

Templates sind echter Source Code.

Keine Black Boxes.

---

# 30. Component Library

Liefere wiederverwendbare professionelle Komponenten:

```text
Title
Subtitle
LowerThird
Callout
Badge
Card
BrowserWindow
CodeEditor
Terminal
Chart
BarChart
LineChart
PieChart
Table
Logo
DeviceFrame
Phone
Laptop
Cursor
Arrow
Connector
Grid
ParticleField
GradientBackground
Spotlight
GlassPanel
ProgressBar
Counter
Typewriter
```

Alle Komponenten müssen animierbar und themefähig sein.

---

# 31. Theme System

Implementiere Design Tokens:

```text
colors
fonts
fontSizes
spacing
radii
shadows
motion
easing
```

Ein gesamtes Video muss über Theme Tokens rebrandbar sein.

---

# 32. Plugin API

OpenVideo benötigt eine stabile Plugin API.

Plugins können hinzufügen:

- Node Types
- Renderers
- Asset Loaders
- Effects
- Codecs
- Voice Providers
- ASR Providers
- Exporters
- Studio Panels
- Agent Tools

Plugins erhalten klar definierte Capability Boundaries.

---

# 33. Import / Compatibility

Implementiere Importmöglichkeiten für relevante offene Formate und Ökosysteme, soweit semantisch möglich:

- SVG
- Lottie
- glTF
- standard HTML/CSS
- Motion-Canvas-artige Szenenkonzepte
- Anime.js-artige Timelines

Bei verlustbehafteten Imports muss das System Warnungen ausgeben.

Keine stille Semantikänderung.

---

# 34. Projektstruktur

Verwende einen TypeScript Monorepo-Aufbau.

Beispielsweise:

```text
/apps
  /studio
  /docs
  /playground

/packages
  /core
  /schema
  /compiler
  /timeline
  /sdk
  /jsx
  /layout

  /renderer-browser
  /renderer-pixi
  /renderer-skia
  /renderer-three
  /renderer-blender

  /compositor
  /assets
  /fonts
  /audio
  /subtitles
  /ffmpeg

  /anime-adapter
  /motion-canvas-adapter

  /agent
  /mcp
  /cli

  /sandbox
  /worker
  /scheduler
  /cache

  /studio-components
  /templates

  /testing
  /benchmarks
```

Abhängigkeiten müssen gerichtet sein.

`core` darf niemals von einem konkreten Renderer abhängen.

---

# 35. Engineering Standards

Aktiviere maximal striktes TypeScript.

Keine:

```text
any
@ts-ignore
unchecked casts
silent catches
```

außer wenn technisch unvermeidbar und dokumentiert.

Public APIs benötigen:

- TypeScript Types
- TSDoc
- Beispiele
- Tests

Architekturentscheidungen werden als ADRs dokumentiert.

---

# 36. Tests

Erforderlich:

### Unit Tests

Core, Timeline, Math, Schema, Asset Pipeline.

### Property-Based Tests

Besonders Timeline und Interpolation.

### Integration Tests

Composition → Renderer → Frame.

### Golden Image Tests

Referenzframes vergleichen.

### Pixel Diff Tests

Mit definierten Toleranzen.

### Audio Tests

Duration, Sync, Mix.

### End-to-End Tests

Composition → MP4.

### Determinism Tests

Derselbe Frame wird mehrfach und auf unterschiedlichen Workern gerendert.

### Security Tests

Sandbox Escape, Netzwerk, Filesystem und Resource Limits.

### Performance Tests

2D, 3D, DOM, 4K, große Asset-Mengen.

---

# 37. Quality Gates

Kein Merge bei:

- TypeScript Error
- Lint Error
- Unit Test Failure
- E2E Failure
- Golden Test Regression ohne explizite Freigabe
- Dependency Vulnerability oberhalb definierter Severity
- License Violation
- API Schema Violation

---

# 38. Performanceziele

Definiere reproduzierbare Benchmarks.

Testvideos:

- 1080p30
- 1080p60
- 4K30
- 4K60

Szenarien:

- text-heavy
- vector-heavy
- image-heavy
- video-heavy
- 3D-heavy
- mixed DOM + 2D + 3D
- audio-heavy

Messe:

```text
frames/sec
render time/frame
GPU utilization
CPU utilization
peak RAM
VRAM
cache hit ratio
encoding throughput
startup time
```

Performance Regressionen werden automatisch erkannt.

---

# 39. Color Management

Professionelles Color Management ist Pflicht.

Unterstütze mindestens:

- sRGB
- linear RGB
- Rec.709
- definierte Transfer Functions
- Alpha
- Premultiplied Alpha Handling

Color-Space-Konvertierungen müssen explizit sein.

Kein zufälliges Browser-/Renderer-abhängiges Farbverhalten.

---

# 40. Error Experience

Fehler müssen außergewöhnlich gut sein.

Nicht:

```text
WebGL error 1282
```

sondern:

```text
ThreeRendererError

Node:
product-model

Frame:
184

Problem:
The selected texture exceeds the GPU maximum texture size.

Asset:
hero-texture.png
16384 × 16384

GPU maximum:
8192 × 8192

Suggested actions:
1. Resize the asset to <= 8192 px.
2. Enable automatic texture downscaling.
3. Use the Blender backend.
```

Jeder Fehler soll für Menschen und Agents gleichermaßen verständlich sein.

---

# 41. Doctor

Implementiere:

```text
openvideo doctor
```

Es prüft:

- Node
- Browser
- WebGL
- WebGPU
- GPU
- FFmpeg
- codecs
- Blender
- fonts
- filesystem
- Docker
- hardware encoders

und gibt konkrete Lösungsvorschläge.

---

# 42. Dependency- und Lizenzpolitik

Das Produkt selbst wird unter einer OSI-konformen Open-Source-Lizenz veröffentlicht.

Bevorzugt:

**Apache-2.0**

wegen des expliziten Patent Grants.

Jede Runtime Dependency wird automatisch inventarisiert.

Generiere:

```text
THIRD_PARTY_NOTICES
SBOM
licenses.json
```

Nicht OSI-konforme Runtime-Komponenten dürfen nicht stillschweigend in den Core gelangen.

Remotion darf deshalb nicht Core-Abhängigkeit werden.

Codec- und Modelllizenzen werden separat behandelt.

---

# 43. Keine versteckten Cloud-Abhängigkeiten

Die gesamte Plattform muss lokal funktionieren.

Folgendes muss offline möglich sein:

```text
create
edit
preview
render
encode
inspect
test
```

Cloud ist ausschließlich zusätzliche Skalierung.

Kein Cloud Lock-in.

---

# 44. Docker

Liefere offizielle Images:

```text
openvideo/base
openvideo/render-cpu
openvideo/render-gpu
openvideo/blender
openvideo/studio
openvideo/worker
```

Images müssen reproduzierbar gebaut und versioniert werden.

---

# 45. Kubernetes

Liefere produktionsfähige Kubernetes Deployments.

Komponenten:

```text
API
Scheduler
Render Workers
GPU Workers
Blender Workers
Object Storage
Cache
Queue
Studio
```

Unterstütze Autoscaling anhand von:

- Queue Length
- CPU
- GPU
- Render Duration

---

# 46. Observability

OpenTelemetry integrieren.

Metrics:

```text
render_duration
frame_duration
queue_wait
cache_hits
cache_misses
worker_failures
gpu_memory
cpu_usage
encoding_duration
```

Distributed Render Jobs müssen über Trace IDs vollständig nachvollziehbar sein.

---

# 47. Developer Experience

Ein Entwickler soll innerhalb weniger Minuten Folgendes schaffen:

```text
openvideo create hello
cd hello
openvideo dev
```

Danach öffnet sich Studio und eine funktionierende Composition ist sichtbar.

Änderungen an Code führen unmittelbar zu Preview Updates.

Fehlermeldungen erscheinen direkt an der betroffenen Node und Codeposition.

---

# 48. AI Documentation

Dokumentation muss speziell für Coding Agents optimiert werden.

Erzeuge:

```text
AGENTS.md
llms.txt
JSON Schema
API reference
examples
recipes
capability manifest
```

Jede API benötigt kleine, eindeutige Beispiele.

Agenten sollen möglichst wenig Kontext benötigen, um korrekten OpenVideo-Code zu erzeugen.

Bevorzuge wenige orthogonale Primitive gegenüber hunderten Spezialfunktionen.

---

# 49. Entscheidendes API-Prinzip

Die API muss:

- deklarativ
- composable
- strongly typed
- discoverable
- deterministic
- serializable
- patchable
- versionable
- agent-friendly

sein.

Vermeide versteckte Zustände.

Vermeide magisches Verhalten.

Vermeide globale Singletons.

---

# 50. Definition of Done

Das Produkt gilt erst als fertig, wenn ein Coding Agent ausschließlich über dokumentierte APIs Folgendes erzeugen kann:

Ein 60 Sekunden langes 4K-Video mit:

- animiertem Intro
- professioneller Typografie
- SVG Logo
- 2D Motion Graphics
- Datenvisualisierung
- HTML/CSS UI Animation
- Three.js 3D Szene
- glTF Modell
- Kameraanimation
- Licht
- Partikeln
- Shader/Postprocessing
- eingebettetem Video
- Bildern
- Voiceover
- Musik
- Soundeffekten
- animierten Untertiteln
- Übergängen
- Color Grading
- Outro

Der Agent muss anschließend:

1. einzelne Frames rendern,
2. das Ergebnis inspizieren,
3. gezielt Nodes verändern,
4. erneut rendern,
5. das vollständige Video erzeugen können.

Das Ergebnis muss auf einem zweiten Worker aus demselben Projekt reproduzierbar sein.

---

# 51. Keine Feature-Zurückstellung

Es gibt für diesen Auftrag kein „später“, „Phase 2“, „nice to have“ oder „MVP reicht zunächst“.

Alle hier beschriebenen Funktionen gehören zum Zielprodukt.

Die Implementierung darf selbstverständlich nach technischen Abhängigkeiten geordnet werden, aber diese Reihenfolge ist **keine Reduktion des Scopes**.

Keine:

- TODO-Platzhalter
- Fake Implementations
- Mock Features im Produktcode
- deaktivierten Buttons für geplante Features
- nicht implementierten Interface-Methoden
- dokumentierten Features ohne funktionierende Implementierung

Wenn ein Ansatz technisch nicht tragfähig ist, ersetze ihn durch einen besseren Ansatz und dokumentiere die Entscheidung als ADR.

---

# 52. Engineering-Vorgehen

Arbeite nicht blind Feature für Feature.

Beginne mit den invarianten Architekturgrenzen:

```text
Composition IR
Timeline
Frame Evaluation
Renderer Interface
Asset Model
Plugin Interface
Agent Interface
```

Diese APIs müssen außergewöhnlich sauber sein.

Danach implementiere vertikale End-to-End-Slices, bis sämtliche Anforderungen dieses Auftrags vollständig abgedeckt sind.

Nach jedem Slice:

```text
build
lint
test
render test compositions
compare golden frames
benchmark
security checks
```

Halte das Repository zu jedem Zeitpunkt buildbar.

---

# 53. Architekturentscheidung

Die strategische Architektur lautet ausdrücklich:

**Nicht:**

Remotion als Plattform.

**Nicht:**

Anime.js als Timeline Engine.

**Nicht:**

Motion Canvas als gesamtes Produktfundament.

**Sondern:**

```text
OpenVideo Composition IR
        +
OpenVideo deterministic Timeline
        +
TypeScript/JSX SDK
        +
JSON Schema
        +
Agent/MCP API
        +
PixiJS
        +
Skia/CanvasKit
        +
DOM/SVG/CSS
        +
Three.js
        +
WebGPU/WebGL2
        +
optional Blender Rendering
        +
FFmpeg
        +
Chromium/Playwright
```

Motion Canvas dient als wichtige Referenz für Video-as-Code UX und programmatische Animation.

Anime.js dient als hervorragende optionale Animation-/Easing-Integration.

Three.js ist das primäre interaktive 3D-Backend.

PixiJS und Skia bilden die 2D-Rendering-Schicht.

Chromium ermöglicht HTML/CSS/SVG/WebGL/WebGPU-Kompositionen.

Blender ermöglicht High-End-Offline-3D.

FFmpeg bildet die Media- und Encoding-Schicht.

Aber:

**OpenVideo selbst besitzt Timeline, Scene Model, Composition Model, Agent API und Renderer-Abstraktion.**

Genau dadurch entsteht kein weiterer Wrapper, sondern eine langfristig eigenständige Plattform.

---

# 54. Produktphilosophie

Behandle AI Agents nicht als Add-on.

Das Produkt soll sich anfühlen, als wäre ein Videoformat erstmals **speziell für Softwareentwickler und AI Coding Agents** entworfen worden.

Ein Agent soll nicht lernen müssen, wie After Effects funktioniert.

Er soll ausdrücken können:

```text
Erzeuge eine Headline.
Blende sie zwischen Frame 20 und 45 ein.
Bewege die Kamera langsam auf das Produkt zu.
Ab Sekunde 4 erscheint links eine Feature-Liste.
Synchronisiere die Punkte mit dem Voiceover.
Setze bei Sekunde 8 einen Übergang zur Diagramm-Szene.
```

und diese Absicht muss sich in kleinen, deterministischen, verständlichen und editierbaren Code-Strukturen widerspiegeln.

Die entscheidende Produktmetrik lautet:

> Wie zuverlässig kann ein Coding Agent ein visuell hervorragendes Video erzeugen, das Ergebnis verstehen und anschließend mit minimalen Änderungen verbessern?

Optimiere jede Architekturentscheidung auf diese Frage.

Baue keine Kopie existierender Video-Frameworks.

Baue die Referenzplattform für **Agentic Video Engineering**.