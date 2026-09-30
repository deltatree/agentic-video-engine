# Audit Agent-DX (John, PM) – 2026-09-30

Zahlen (24 Ops, 30 Node-Typen, 29 Komponenten, 15 Templates, 17 Blend Modes) stimmen. Alle §5-Operationen und 7 Patch-Typen (+4) vorhanden. Schema-Diagnosen erfüllen §40.

| # | Befund | Beleg | Schwere |
|---|---|---|---|
| 1 | `npx @agentic-video/cli` 404 auf npm; kein publishConfig access public, kein Release-Workflow | .github/workflows; packages/*/package.json | P0 |
| 2 | Studio nicht im CLI-Paket enthalten (files nur dist) | packages/cli/src/cli.ts:115-118 | P0 |
| 3 | MCP-Patch-Schema untypisiert (Record<string, unknown>) → Agents raten Felder | packages/agent/src/operations.ts:360 | P0 |
| 4 | CLI ohne patch/contact-sheet/op, widerspricht ADR 0009 | packages/cli/src/cli.ts | P1 |
| 5 | docs/guide/cli.md veraltet trotz „generiert“; kein Drift-Gate | cli.ts:52-80 | P1 |
| 6 | Link docs/api/README.md kaputt (nicht eingecheckt) | README.md, llms.txt | P1 |
| 7 | Keine Selbstbeschreibung über MCP/HTTP (capabilities.get, Resources) | packages/mcp/src/index.ts | P1 |
| 8 | Keine JSON-Beispiele je Node-Typ; examples/ nur dod | docs/ai/capabilities.json | P1 |
| 9 | MCP-Workspace kann bestehendes CLI-Projekt nicht öffnen | cli.ts:552 | P1 |
| 10 | Patch-Fehler ohne Index, suggestions leer, kein Did-you-mean für Node-IDs; parentId-Nichtstring fällt still auf Root | operations.ts:377,386,390,431; core/src/patches.ts:124 | P2 |
| 11 | 12 Stellen mit suggestions: [] | diverse | P2 |
| 12 | AGENTS.md ohne $sampled/TSX; api.md ohne Ausgabebeispiele; README nennt `openvideo doctor` ohne npx | docs | P2 |
| 13 | .gitignore ignoriert AGENTS.md/CLAUDE.md/.mcp.json ohne Anker; kein Root-AGENTS.md, kein examples/mcp.json | .gitignore | P2 |
| i18n | Agent-Doku deutsch, Ops/Fehler englisch → English-first Agent-Doku, deutsche Fassung *.de.md | docs | P1 |
