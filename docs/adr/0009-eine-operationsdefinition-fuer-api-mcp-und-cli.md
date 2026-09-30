# ADR 0009: Eine Operationsdefinition für API, MCP und CLI

- Status: angenommen
- Datum: 2026-09-28 (ergänzt 2026-09-30)

## Kontext

Drei Schnittstellen könnten auseinanderlaufen.

## Entscheidung

Jede Operation ist einmal in `@agentic-video/agent` definiert (Name, Schemas, Beispiel, Handler) und steht im Register `OPERATIONS`. Alle drei Schnittstellen rufen sie über `invokeOperation` auf:

- HTTP: `POST /v1/<name>`, Liste unter `GET /v1/operations`.
- MCP: Tool `<name>` mit `_` statt `.`; dazu die Resources `openvideo://agents.md`, `openvideo://schema.json`, `openvideo://capabilities.json`.
- CLI: `openvideo op <name> --input <json|@datei>` (Liste: `openvideo op --list`). Workspace und Projekt kommen wie bei `serve` und `mcp` aus `--workspace` bzw. `--project`; im Projektordner ergänzt die CLI `projectId`. Job-Operationen warten auf das Ende des Jobs.

Die Kurzbefehle `patch` (`composition.patch`), `contact-sheet` (`preview.contactSheet`) und `import` (`project.import`) bauen nur die Eingabe und rufen dieselben Operationen. Ältere Direktbefehle (`validate`, `render`, `render-frame`, `inspect`) bleiben für Menschen erhalten; für Agents ist `op` der vollständige Weg.

## Folgen

Neue Operationen erscheinen ohne weitere Arbeit in HTTP, MCP und CLI. Eingabeprüfung und Fehlerdiagnosen sind überall gleich.

## Nachtrag 2026-09-30

Story 19.2 hat die CLI-Seite nachgezogen: Bis dahin fehlten `op`, `patch` und `contact-sheet`, die CLI entsprach der Entscheidung nicht.
