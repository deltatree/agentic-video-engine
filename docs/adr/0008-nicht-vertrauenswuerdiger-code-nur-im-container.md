# ADR 0008: Nicht vertrauenswürdiger Code nur im Container

- Status: angenommen
- Datum: 2026-09-28

## Kontext

A24 verbietet Ausführung von Agent-Code auf dem Host.

## Entscheidung

TSX-Auswertung und Browser-Rendering mit Skripten laufen in Containern ohne Netz, read-only, ohne Capabilities, mit Limits, ohne Host-Mounts. Agent API und MCP erzwingen das. Nur die CLI erlaubt mit `--trusted` Host-Ausführung für eigene Projekte; das Manifest vermerkt es.

`trusted-host` ist **keine Isolation**. Der Modus ist nur für eigenen, vertrauenswürdigen Code gedacht:

- Der Code läuft in einem Node-Kindprozess mit Permission-Modell (`--permission`, Lesen nur im eigenen Temp-Ordner).
- Der `node:vm`-Kontext darin ist keine Sicherheitsgrenze. Code kann ihn verlassen, zum Beispiel über `this.constructor.constructor("return process")()`.
- Der Kindprozess erhält deshalb eine leere Umgebung. Er sieht keine Tokens wie `OPENVIDEO_API_TOKEN` und keine Zugangsdaten wie `OPENVIDEO_S3_*`.
- Das Permission-Modell sperrt kein Netz. Fremder Code darf diesen Modus nie erreichen.

## Folgen

Docker ist für TSX über die Agent API Pflicht. Text aus ausgeführtem Code (Fehlermeldungen, Stacks, eigene Diagnosen) erscheint in Diagnosen nur als `details.untrusted`, nie als `problem` oder `suggestions`. JSON-Compositions ohne HTML-Skripte laufen überall.
