# @agentic-video/agent

Agent API: Operationsregister (`OPERATIONS`), typisiertes Patch-Schema (`PatchSchema`, `PATCH_EXAMPLES`), Selbstbeschreibung (`capabilities.get`, `schema.get`), Workspace, Render-Jobs, HTTP-Server.

## HTTP-Server (`startAgentServer`)

| Route | Zweck |
|---|---|
| `POST /v1/<operation>` | Operation mit JSON-Eingabe |
| `GET /v1/operations` | Alle Operationen mit Schemas und Beispielen |
| `GET /v1/files/<projectId>/<pfad>` | Projektdateien; `ETag` = Inhaltsrevision (SHA-256, 16 Hex-Zeichen) |
| `GET /v1/events?projectId=<id>` | Server-Sent Events `revision` bei jeder Änderung von `project.json`, egal von wem (ADR 0025); höchstens `maxEventStreams` (Standard 32) gleichzeitig |
| `GET /v1/health` | Lebenszeichen ohne Token |

`frame.render` nimmt optional `patches`: Sie gelten nur für diesen Render und werden nie gespeichert
(Live-Vorschau im Studio). `render.status` ohne `jobId` listet alle Jobs, mit `projectId` die eines Projekts.
Eingebundene Projekte (Symlinks von `project.open`) prüft jeder Zugriff erneut gegen `projectRoots` und
`hostProjectDirs`.
