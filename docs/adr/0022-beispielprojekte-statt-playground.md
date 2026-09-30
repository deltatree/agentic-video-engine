# ADR 0022: Beispielprojekte in `examples/` statt `apps/playground` und `apps/docs`

- Status: angenommen
- Datum: 2026-09-30

## Kontext

Der Auftrag nennt in §34 „beispielsweise“ die Apps `apps/playground` und `apps/docs`. Das Audit vom 2026-09-30 (pm-agent-dx.md, Punkt 8) fand keine JSON-Beispiele je Node-Typ und unter `examples/` nur den Definition-of-Done-Test. Agents lernen am schnellsten aus vollständigen, gültigen Projekten, die sie kopieren, prüfen und rendern können. Ein Playground im Browser wiederholt, was das Studio (`openvideo dev`) schon kann: Projekt öffnen, Vorschau, Patches, Render. Entscheidung T11 im Epic-Plan.

## Entscheidung

- **Kein `apps/playground`, kein `apps/docs`.** Die Doku bleibt in `docs/` (Markdown im Repository, API-Referenz mit TypeDoc). Zum Ausprobieren dient das Studio.
- **Fünf durchgehende Beispielprojekte unter `examples/`:** `product-launch` (JSON-IR mit Bild, Text, Chart, Übergängen, Musik), `explainer-tsx` (TSX-SDK mit eigener Komponente und Theme), `data-story` (Charts und Untertitel aus SRT), `3d-showcase` (`scene3d` mit glTF, Licht, Kamera, Partikeln), `social-vertical` (9:16, `sequence`, Karaoke-Untertitel). Jedes hat eine README mit Zweck und den Befehlen `openvideo validate`, `render-frame`, `render`.
- **Assets entstehen selbst:** Binäre Assets erzeugt je Beispiel ein `generate-assets.mjs` nur mit Node.js (PNG über `node:zlib`, WAV, GLB); sie sind nicht eingecheckt. Kleine Textdateien (SVG, SRT) sind eingecheckt. Alle Assets sind eigene Inhalte unter CC0-1.0 und im Projekt als `license` vermerkt.
- **Jedes Beispiel hat einen Test** (`examples/<name>/<name>.test.ts`): kopiert das Projekt in einen temporären Ordner, erzeugt die Assets, ruft die CLI wie in der README auf und rendert 1–3 Frames. 3D-Frames brauchen Chromium und werden sonst mit `skipUnless` benannt übersprungen.
- **Ein Beispiel je Node-Typ:** `NODE_EXAMPLES` in `@agentic-video/schema` hält ein kleines, gültiges JSON-Beispiel je Node-Typ. Es steht in `capabilities.get` (Feld `example`, dazu `propertyTypes`), im JSON Schema (`examples` je `Node_<typ>`), in `docs/ai/capabilities.json` und in `docs/reference/node-semantics.md`. Die Beispiele liegen nicht als `examples` im TypeBox-Schema, weil der Validator `examples` für Vorschläge in Diagnosen nutzt.
- `examples/mcp.json` zeigt die MCP-Konfiguration für Clients.

## Folgen

- Kein weiteres Frontend zu pflegen; Beispiele laufen in CI mit und veralten nicht still.
- Neue Node-Typen brauchen ein Beispiel in `NODE_EXAMPLES`: Der Typ des Registers verlangt genau eines je eingebautem Typ, und ein Test validiert und rendert es.
- `scripts/generate-docs.mjs` schreibt die Beispiele in Manifest und Referenz; die Doku wird damit aus dem Code erzeugt statt von Hand gepflegt.
