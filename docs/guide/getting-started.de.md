# Erste Schritte

## Voraussetzungen

| Werkzeug | Zweck | Pflicht |
|---|---|---|
| Node.js 22.13 oder neuer | Laufzeit | ja |
| FFmpeg 6 oder neuer | Video-Encoding, Medien | ja, für Videos |
| Chromium (über Playwright) | HTML/CSS, PixiJS, Three.js | nur für diese Node-Typen |
| Docker | Sandbox für TSX und HTML-Skripte | nur für Agent-Code |
| Blender 4.2 LTS | `blender`-Nodes | nein |

## Installation

> **Noch nicht auf npm:** Die Pakete `@agentic-video/*` sind bis zur ersten Veröffentlichung
> (Release-Workflow bei einem Tag `v*`) nicht in der npm-Registry. `npx @agentic-video/cli` und
> `npm install -g @agentic-video/cli` finden sie bis dahin nicht. Installiere die CLI so lange aus dem Repository:

```bash
git clone https://github.com/deltatree/agentic-video-engine.git
cd agentic-video-engine
npm ci && npm run build          # baut alle Pakete und kopiert das Studio ins CLI-Paket
alias openvideo="node $PWD/packages/cli/dist/bin.js"
```

Nach der ersten Veröffentlichung ersetzt `npx @agentic-video/cli <befehl>` den Alias. Alle Befehle unten
schreiben `openvideo`.

Prüfe alles mit `openvideo doctor`. Jede Zeile nennt bei Bedarf eine Lösung.

## Projekt anlegen und ansehen

1. Lege ein Projekt an: `openvideo create hello`.
2. Wechsle in den Ordner: `cd hello`.
3. Starte das Studio: `openvideo dev`. Der Browser öffnet sich mit dem Projekt; die Adresse (mit Token im `#token=`-Fragment) steht auch in der Ausgabe.

Das Studio zeigt die Composition. Änderungen im Studio landen als Patches in `project.json`.

`openvideo dev` beobachtet `src/**` und `project.json`:

- Speicherst du in deinem Editor, kompiliert `dev` TSX-Projekte neu und schreibt die IR nach `project.json`. Kompilierfehler stehen im Terminal; das Studio behält den letzten guten Stand.
- Ändert ein Agent (MCP, Agent API, `openvideo patch`) oder dein Editor das Projekt, lädt das Studio sofort neu (Server-Sent Events `GET /v1/events`, siehe [ADR 0025](../adr/0025-live-sync-ueber-inhaltsrevisionen.md)). Undo-Schritte von vor der Fremdänderung verfallen. Hast du im Code-Panel ungespeicherte Änderungen, warnt das Studio statt sie zu überschreiben.
- `--no-open` öffnet keinen Browser (in CI und ohne grafische Sitzung öffnet `dev` ohnehin keinen). `openvideo serve --open` öffnet das Studio auch beim Agent-API-Server.

Im Studio hilft `?` mit allen Tastenkürzeln (u. a. J/K/L, I/O, M für Marker, Strg+←/→ für Keyframes).

## Rendern

1. Einen Frame ansehen: `openvideo render-frame --frame 2s --out out/frame.png`.
2. Das Video rendern: `openvideo render --format mp4 --codec h264`.
3. Neben dem Video liegt `<datei>.render-manifest.json` mit allen Versionen und Frame-Hashes.

Ein zweiter Lauf rendert nur geänderte Frames neu. Der Rest kommt aus dem Cache unter `.openvideo/cache`.

## TSX statt JSON

1. Lege ein TSX-Projekt an: `openvideo create hello --tsx`.
2. Die Quelle liegt in `src/video.tsx`. JSX ist nur Syntax; das Ergebnis ist dieselbe IR.
3. TSX ist Code. OpenVideo führt ihn in einem Docker-Container ohne Netz aus.
4. Für dein eigenes Projekt kannst du mit `--trusted` auf dem Host ausführen.

## Für Agents

- Agent API: `openvideo serve --port 7788` (HTTP, `GET /v1/operations`).
- MCP: `openvideo mcp` (stdio). Beispiel für Claude Code: `claude mcp add openvideo -- openvideo mcp --workspace ~/ov`, für ein bestehendes Projekt `openvideo mcp --project ./hello`.
- Jede Operation auch ohne Server: `openvideo op <name> --input '<json>'` (Liste: `openvideo op --list`).
- Lies danach [docs/ai/AGENTS.md](../ai/AGENTS.md).
