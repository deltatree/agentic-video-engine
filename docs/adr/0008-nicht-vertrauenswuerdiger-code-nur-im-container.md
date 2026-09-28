# ADR 0008: Nicht vertrauenswürdiger Code nur im Container

- Status: angenommen
- Datum: 2026-09-28

## Kontext

A24 verbietet Ausführung von Agent-Code auf dem Host.

## Entscheidung

TSX-Auswertung und Browser-Rendering mit Skripten laufen in Containern ohne Netz, read-only, ohne Capabilities, mit Limits, ohne Host-Mounts. Agent API und MCP erzwingen das. Nur die CLI erlaubt mit `--trusted` Host-Ausführung für eigene Projekte; das Manifest vermerkt es.

## Folgen

Docker ist für TSX über die Agent API Pflicht. JSON-Compositions ohne HTML-Skripte laufen überall.
