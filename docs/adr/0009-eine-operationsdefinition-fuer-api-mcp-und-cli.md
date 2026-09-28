# ADR 0009: Eine Operationsdefinition für API, MCP und CLI

- Status: angenommen
- Datum: 2026-09-28

## Kontext

Drei Schnittstellen könnten auseinanderlaufen.

## Entscheidung

Jede Operation ist einmal in `@agentic-video/agent` definiert (Name, Schemas, Handler). HTTP, MCP und CLI `--json` nutzen sie.

## Folgen

Neue Operationen erscheinen automatisch überall.
