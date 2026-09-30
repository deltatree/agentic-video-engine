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
| `POST /v1/plugin.<name>` | Agent Tool aus einem Plugin des Projekts (Eingabe `projectId` plus Tool-Schema; `plugins.list` zeigt alle) |
| `GET /plugin-panels/<projectId>/<panelId>/<signatur>/` | Studio-Panel eines Plugins: Seite (Sandbox-CSP) und `module.js`; ohne Token, die signierte URL aus `plugins.list` ist die Berechtigung |

Die CSP einer Panel-Seite erlaubt als Skript nur die Nonce und die absolute URL ihres `module.js`. Die Origin
dafür bildet der Server aus dem geprüften `Host`-Kopf; das Schema ist `https`, wenn die Verbindung TLS ist oder
ein vertrauter Proxy `X-Forwarded-Proto: https` sendet (Option `trustProxy: true`, ohne sie nur von Loopback-Adressen).

Endet die Beobachtung eines Projektordners von selbst (Ordner gelöscht oder ersetzt, Watcher-Fehler), schließt
der Server die betroffenen `/v1/events`-Ströme; Clients verbinden neu und beobachten den aktuellen Ordner.

`frame.render` nimmt optional `patches`: Sie gelten nur für diesen Render und werden nie gespeichert
(Live-Vorschau im Studio). `render.status` ohne `jobId` listet alle Jobs, mit `projectId` die eines Projekts.
Eingebundene Projekte (Symlinks von `project.open`) prüft jeder Zugriff erneut gegen `projectRoots` und
`hostProjectDirs`.
