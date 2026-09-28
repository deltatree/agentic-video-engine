---
title: 'Importe und Adapter: SVG, Lottie, glTF, HTML, Anime.js, Motion Canvas (Epic 13)'
type: 'feature'
created: '2026-09-28'
status: 'ready-for-dev'
route: 'dispatch'
context:
  - '{project-root}/_bmad-output/implementation-artifacts/agent-rules.md'
  - '{project-root}/docs/reference/node-semantics.md'
  - '{project-root}/packages/schema/src/nodes.ts'
  - '{project-root}/packages/timeline/src/builders.ts'
  - '{project-root}/packages/core/src/patches.ts'
---

## Intent

**Problem:** Bestehende offene Formate und Ökosysteme sollen in OpenVideo nutzbar sein (FR-85, FR-86). Verlustbehaftete Importe dürfen die Bedeutung nie still ändern.

**Approach:** Drei Pakete, alle reine Umwandler in IR (keine Renderer):
`importers` (SVG, Lottie, glTF, HTML/CSS), `anime` (Anime.js-artige API), `motion-canvas-adapter` (Generator-Szenen).

## Boundaries & Constraints

**Always:**
- Pakete: `packages/importers`, `packages/anime`, `packages/motion-canvas-adapter`. Nichts anderes ändern. Nur `core` als Abhängigkeit.
- Jedes Ergebnis ist `{ nodes | project | animations, diagnostics }`. Jeder Informationsverlust erzeugt eine Diagnose `OV_IMPORT_LOSSY` (severity `warning`) mit Pfad/Element und Vorschlag. Nie still verwerfen.
- Ausgabe validiert gegen das Schema (Test mit `validateProject`).
- Anime.js und Motion Canvas werden **nicht** als Bibliothek eingebunden; die Adapter bilden deren API-Konzepte nach. OpenVideo besitzt die Zeit (A8): kein Adapter steuert eine Uhr.

## Anforderungen

### importers
- `importSvg(markup, options)` → Nodes: `svg`, `g`, `path`, `rect` (rx/ry → cornerRadius), `circle`, `ellipse`, `line`, `polyline`, `polygon`, `text`/`tspan` (einfach), `image` (data-URI → Asset-Bytes im Ergebnis), `use`/`defs`, `linearGradient`/`radialGradient` (userSpaceOnUse → `units: 'pixels'`), `clipPath` → Maske, Transforms (Matrix → x, y, rotation, scale, skew, origin `{0,0}` per Zerlegung; nicht zerlegbare Fälle → Pfad-Transformation mit Diagnose), `style`-Attribut und einfache `<style>`-Klassen, Opacity, Stroke-Attribute, `viewBox` → Gruppenskalierung. Nicht unterstützt (Filter, Pattern, Marker, Masken mit Luminanz …) → Diagnose.
- `importLottie(json, { mode: 'native' | 'embed' })`: `embed` → eine `lottie`-Node (verlustfrei) plus Asset. `native` → Shape-Layer in IR: Rechteck, Ellipse, Pfad (Bezier aus `v/i/o`), Fill, Stroke, Gradient Fill (linear/radial), Trim Paths, Transform (Anker, Position, Skalierung, Rotation, Opacity) mit Keyframes → `$keyframes` mit `cubic-bezier`-Easing aus den Lottie-Tangenten, Hold-Keyframes → `hold`, Layer-Zeiten (`ip`, `op`, `st`) → `timing`, Precomps → Gruppen mit Timing, Parenting. Nicht unterstützt (Expressions, Effekte, Text-Layer-Animatoren, Mattes teilweise) → Diagnose.
- `importGltf(bytes | json, { assetId })` → `scene3d` mit `model3d` (Asset), aus dem glTF übernommene Kameras (`camera3d`) und KHR_lights_punctual (`light3d`), Liste der Animation Clips in `metadata`. GLB-Parser für JSON-Chunk selbst schreiben.
- `importHtml(html, css?)` → `html`-Node (verlustfrei), eingebettete Bilder (data-URI) als Assets; externe URLs → Diagnose (werden beim Rendern blockiert) mit Vorschlag, die Datei als Asset zu importieren.

### anime
- API nach Anime.js v4-Konzepten: `animate(targets, params)`, `createTimeline(defaults?)` mit `.add(targets, params, position?)` (Position: absolut ms, `'+=100'`, `'-=100'`, `'<'`, `'<<'`, Label), `.label(name, position?)`, `stagger(value, { start, from: 'first' | 'last' | 'center' | index })`, `utils.random` (seeded!).
- Targets sind Node-IDs (String, Array, Selektor `#id`). Params: Properties mit Wert, `[from, to]`, `{ from, to }`, Keyframe-Arrays, Funktionswerte `(target, index, total) => value`; `duration`, `delay`, `ease`, `loop`, `alternate`, `reversed`, `autoplay` (ignoriert, Diagnose `info`).
- Easing-Abbildung: `linear`, `in/out/inOut` + `Quad…Bounce` → OpenVideo-Namen, `cubicBezier(a,b,c,d)`, `steps(n)`, `spring(...)` → spring-Easing; `out(3)` → `easeOutCubic`-Approximation mit Diagnose; unbekannt → Diagnose + `linear`.
- Property-Abbildung: `x`/`translateX` → `x` (relativ zum Basiswert der Node, falls vorhanden), `y`, `rotate` → `rotation` (Grad; `'1turn'` → 360), `scale`/`scaleX`/`scaleY` → `scale`, `opacity`, Farben, sonstige gleichnamige Properties; Einheiten `px`, `deg`, `turn`, `%` (Diagnose).
- Ergebnis: `timeline.toPatches(project)` → Liste von `Patch` (`setProperty` mit `$keyframes`), und `applyTimeline(project, timeline)` über `applyPatches` aus core.

### motion-canvas-adapter
- `makeScene(name, function* (view) { … })` mit Knoten-Fabriken `Rect`, `Circle`, `Txt`, `Line`, `Img`, `Node` (Gruppe) und Signal-Eigenschaften (`node.x(300, 1, easeInOutCubic)` liefert einen Tween-Task; `node.x(300)` setzt sofort; `node.position.x(…)`, `node.scale(…)`, `node.opacity(…)`, `node.fill(…)`, `node.rotation(…)`), Flusssteuerung `all`, `any`, `chain`, `sequence(delay, …)`, `loop(n, factory)`, `waitFor(s)`, `waitUntil(eventName)` (Marker), `delay(s, task)`.
- Symbolische Ausführung: Der Generator läuft ohne Uhr, sammelt Tween-Segmente mit Start/Ende und erzeugt `$keyframes` pro Property. Standard-Easing `easeInOutCubic` (wie Motion Canvas).
- Koordinaten: Motion Canvas nutzt Ursprung Bildmitte und y nach unten → Umrechnung auf OpenVideo (links oben) mit Composition-Größe; Knoten sind in Motion Canvas mittig verankert → `origin` und Position umrechnen. Layout-Engine (Flexbox) nicht unterstützt → Diagnose.
- `toProject(scenes, { width, height, fps })` → IR-Project (Szenen hintereinander als Gruppen mit `timing`).

## Tasks & Acceptance

**Acceptance Criteria:**
- Je Format mindestens ein realistisches Beispiel (selbst geschrieben, im Test) mit erwarteter IR und Diagnosen für jeden Verlust.
- Anime: Timeline mit drei Einträgen und relativen Positionen ergibt die erwarteten Keyframe-Zeiten; Stagger verteilt Delays.
- Motion Canvas: `yield* all(rect.x(300, 1), rect.opacity(0, 1)); yield* waitFor(0.5); yield* rect.x(0, 1)` ergibt Keyframes bei 0 s, 1 s, 1.5 s, 2.5 s.

## Verification

- `npx tsc -b packages/importers packages/anime packages/motion-canvas-adapter`
- `npx vitest run packages/importers packages/anime packages/motion-canvas-adapter`
- `npx eslint packages/importers packages/anime packages/motion-canvas-adapter --max-warnings 0`
