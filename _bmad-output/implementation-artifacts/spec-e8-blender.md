---
title: 'Blender-Backend (Epic 8)'
type: 'feature'
created: '2026-09-28'
status: 'ready-for-dev'
route: 'dispatch'
context:
  - '{project-root}/_bmad-output/implementation-artifacts/agent-rules.md'
  - '{project-root}/docs/reference/node-semantics.md'
  - '{project-root}/packages/core/src/contracts.ts'
  - '{project-root}/packages/schema/src/nodes.ts'
---

## Intent

**Problem:** High-End-3D (Cycles, Eevee, Pässe, Volumen) braucht Blender headless (FR-43, FR-44).

**Approach:** Paket `renderer-blender` implementiert `RenderBackend` (id `blender`). Node erzeugt pro Frame (oder Chunk) eine JSON-Szenenbeschreibung aus Evaluated Nodes; ein mitgeliefertes Python-Skript baut die Szene in Blender auf und rendert PNGs.

## Boundaries & Constraints

**Always:**
- Paket: `packages/renderer-blender` (Node-Code + `python/openvideo_blender.py`, im Paket unter `files` aufnehmen – `package.json` des Pakets darfst du ändern). Nichts anderes ändern.
- Blender-Suche: Option `blenderPath` → `OPENVIDEO_BLENDER` → `PATH` → `~/.local/opt/blender*/blender`. `detectBlender()` → `{ path, version }` oder Diagnose `OV_BLENDER_MISSING` mit Installationshinweis.
- Installiere für die Tests **Blender 4.2 LTS** (Linux x64, offizielles Archiv von download.blender.org, Prüfsumme prüfen) nach `~/.local/opt/` (kein sudo nötig).
- OpenVideo besitzt die Zeit: Werte aller Properties kommen aus der Evaluated Scene je Frame; für Motion Blur setzt das Skript Keyframes für Frame n und die Nachbar-Subframes aus den übergebenen Zuständen (Node rechnet `evaluateScene` für Subframes selbst, Backend-API bekommt dafür eine Liste von Zuständen).
- Determinismus: Cycles `seed` = Szenen-Seed, `use_animated_seed = False`, CPU, feste Samples, feste Tile-Größe, Denoiser aus (oder deterministisch, dokumentieren). Test: zweimal rendern → Pixel-Diff innerhalb Toleranz (Kanal ≤ 2, ≤ 0.1 % Pixel); dokumentiere das Ergebnis ehrlich.

## Anforderungen

- `createBlenderBackend({ blenderPath?, workDir, threads? })` → `RenderBackend` (`fusable: false`, `nodeTypes: ['blender']`, `capabilities` z. B. `blender.cycles`, `blender.eevee`, `blender.passes.depth`, `blender.passes.normal`, `blender.passes.object-mask`, `blender.volume`, `blender.motion-blur`, `blender.gltf`, `blender.transparent`), `versions()` → Blender-Version.
- Unterstützt: `camera3d` (perspektivisch/orthografisch, fov, target → Track-To oder berechnete Rotation), `light3d` (Sonne/Punkt/Spot/Area-Näherung für ambient über Welt-Licht, hemisphere über Welt-Gradient), `mesh3d` (alle Geometrien aus `Geometry` über bpy-Primitive), `model3d` (glTF/GLB-Import, OBJ-Import; Animation Clip auf Zeit setzen), `group3d`, Materialien Principled BSDF (color, metalness, roughness, emissive, transmission, opacity, clearcoat, Texturen über Asset-Pfade), Welt (Hintergrundfarbe, HDRI, `film_transparent` ohne Hintergrund), Nebel/Volumen (`volume`), `engine` cycles/eevee (Blender 4.2: `BLENDER_EEVEE_NEXT`), `samples`, `pass` (combined, depth normalisiert, normal, object-mask für `maskObject`), `motionBlur`.
- Nicht übertragbare Features (`instances3d` mit >10 000 Instanzen, `particles3d`, Shader-Materialien mit GLSL, Postprocessing) meldet `check()` vor dem Render als `OV_BLENDER_UNSUPPORTED` mit Vorschlag (`scene3d`/Three.js nutzen).
- Batch-API `renderFrames(requests: LayerRequest[])` rendert einen Chunk in **einem** Blender-Prozess (Szene einmal aufbauen, pro Frame Zustände setzen).
- Ausgabe: `RgbaImage` (vormultipliziert, sRGB, View Transform `Standard`) in Ausgabegröße; die Box der `blender`-Node wird mit ihrer 2D-Matrix platziert (wie scene3d).
- Assets: Pfade über `request.assets.get(id)?.path`.
- Timeout je Frame (Option), Prozessfehler → `OpenVideoError` mit den letzten Zeilen von Blender-stderr.

## Tasks & Acceptance

**Acceptance Criteria:**
- Golden-Tests (visuell geprüft, Toleranz) für Cycles und Eevee: Würfel mit Licht und Kamera, Material-Varianten, glTF-Modell (selbst erzeugt), transparenter Hintergrund, Volumen-Nebel, Depth-, Normal- und Objektmasken-Pass, Motion Blur.
- `check()` meldet nicht unterstützte Features.
- Batch-Render von 3 Frames startet Blender genau einmal (Zähler).

## Verification

- `npx tsc -b packages/renderer-blender`
- `npx vitest run packages/renderer-blender`
- `npx eslint packages/renderer-blender --max-warnings 0`
