---
title: 'Komponentenbibliothek und Theme-Tokens (Stories 12.1, 12.2)'
type: 'feature'
created: '2026-09-28'
status: 'ready-for-dev'
route: 'dispatch'
context:
  - '{project-root}/_bmad-output/implementation-artifacts/agent-rules.md'
  - '{project-root}/docs/reference/node-semantics.md'
  - '{project-root}/packages/core/src/registry.ts'
  - '{project-root}/packages/core/src/evaluate.ts'
  - '{project-root}/packages/schema/src/nodes.ts'
  - '{project-root}/docs/adr/0011-komponenten-sind-ir-makros.md'
---

## Intent

**Problem:** Agents sollen professionelle Bausteine mit wenigen Props nutzen können (FR-82) und ein ganzes Video über Theme-Tokens umfärben (FR-83).

**Approach:** Paket `components`: jede Komponente ist eine `ComponentDefinition` aus core (reine Funktion `expand(props, ctx) → IrNode[]`, ADR 0011). Theme-Tokens kommen aus `ctx.theme`, mit Standard-Theme als Rückfall.

## Boundaries & Constraints

**Always:**
- Paket: `packages/components` (isomorph, nur `core`). Nichts anderes ändern.
- Komponenten erzeugen nur Nodes der IR (keine neuen Node-Typen). Animationen sind `$keyframes`/`$spring`/`$expr` in **lokaler Zeit der Komponente** (`ctx.frame` ist die lokale Zeit; die erzeugten Animationen werden relativ zur Komponente ausgewertet).
- Jede Komponente hat `propsSchema` (TypeBox aus `typebox`, ist über core/schema verfügbar: importiere `Type` aus `typebox` – das Paket ist installiert; nenne es in deinem Bericht, falls die package.json-Abhängigkeit fehlt), `description`, `example` (lauffähige Props).
- Farben, Schriften, Größen, Radien, Schatten, Timing und Easing über Theme-Tokens (`ctx.theme.colors.primary` usw.) mit dokumentierten Standardwerten `DEFAULT_THEME`.
- Deterministisch; Zufall nur über `random(ctx.seed, …)`.

## Anforderungen

- Export `DEFAULT_THEME` (vollständige Tokens: colors (background, surface, primary, secondary, accent, text, muted, success, warning, danger), fonts (heading, body, mono), fontSizes, spacing, radii, shadows, motion (fast, normal, slow), easing (standard, enter, exit)), `THEMES` (mindestens `dark`, `light`, `neon`, `corporate`), `resolveTheme(partial)`.
- `registerComponents(registry)` registriert alle; `COMPONENT_NAMES`.
- Die 29 Komponenten aus Auftrag A30: Title, Subtitle, LowerThird, Callout, Badge, Card, BrowserWindow, CodeEditor, Terminal, Chart, BarChart, LineChart, PieChart, Table, Logo, DeviceFrame, Phone, Laptop, Cursor, Arrow, Connector, Grid, ParticleField, GradientBackground, Spotlight, GlassPanel, ProgressBar, Counter, Typewriter.
- Jede Komponente hat Ein-/Ausblend-Animation (`enter`, `exit`: Art und Dauer, Standard aus Theme) und ist über Props animierbar (Props werden vor dem Expandieren pro Frame ausgewertet).
- `CodeEditor`/`Terminal`: Syntax-Hervorhebung durch einen eigenen, kleinen deterministischen Tokenizer für `ts`, `js`, `json`, `python`, `bash`, `css`, `html`, `rust`, `go` (Schlüsselwörter, Strings, Zahlen, Kommentare, Typen, Funktionen), gerendert als `rich-text` mit Monospace-Schrift aus dem Theme; optional Tipp-Animation (`typing`), Zeilennummern, hervorgehobene Zeilen.
- Charts: Daten `{ label, value }[]` (LineChart: Serien), Achsen, Beschriftung, animiertes Wachsen (`progress` 0..1 oder Zeit), Farben aus Theme-Palette; PieChart über `path` mit Bögen.
- `Counter`: animierte Zahl mit Format (Dezimalstellen, Tausender, Präfix/Suffix), `Typewriter`: Text mit Cursor.
- `Cursor`: Mauszeiger folgt Punkten (`path` oder Keyframes), Klick-Welle.
- `Logo`: SVG- oder Bild-Asset mit Reveal (Maske/Trim/Scale).
- `GlassPanel`: halbtransparente Fläche, Rand, Schatten, Glanz-Verlauf (echter Hintergrund-Blur ist hier nicht möglich; dokumentiere das in der Beschreibung und nutze einen `layer` mit `blur`-Effekt nur für eigene Kinder, falls gewünscht).

## Tasks & Acceptance

**Acceptance Criteria:**
- Given jede Komponente mit `example`, when über `evaluateScene` (mit `Registry` + `registerComponents`) in einem Test-Project expandiert, then entstehen gültige Nodes (validiere die expandierten Nodes gegen die Node-Schemas) und keine Diagnosen.
- Given zwei Themes, when dieselbe Komponente expandiert, then unterscheiden sich die Farben gemäß Theme (Test je Komponente).
- Given `enter`-Animation, when Frame 0 und Frame nach der Dauer ausgewertet, then Opacity/Position verschieden bzw. am Ziel.
- Golden-Bilder: Das Skia-Paket entsteht parallel. Prüfe am Ende mit `ls packages/renderer-skia/src/index.ts`, ob es existiert und `createSkiaBackend` exportiert. Wenn ja: rendere für jede Komponente ein Golden (visuell prüfen!). Wenn nein: nenne es im Bericht.

## Verification

- `npx tsc -b packages/components`
- `npx vitest run packages/components`
- `npx eslint packages/components --max-warnings 0`
