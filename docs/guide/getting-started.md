# Erste Schritte

## Voraussetzungen

| Werkzeug | Zweck | Pflicht |
|---|---|---|
| Node.js 22.13 oder neuer | Laufzeit | ja |
| FFmpeg 6 oder neuer | Video-Encoding, Medien | ja, für Videos |
| Chromium (über Playwright) | HTML/CSS, PixiJS, Three.js | nur für diese Node-Typen |
| Docker | Sandbox für TSX und HTML-Skripte | nur für Agent-Code |
| Blender 4.2 LTS | `blender`-Nodes | nein |

Prüfe alles mit `openvideo doctor`. Jede Zeile nennt bei Bedarf eine Lösung.

## Projekt anlegen und ansehen

1. Lege ein Projekt an: `openvideo create hello`.
2. Wechsle in den Ordner: `cd hello`.
3. Starte das Studio: `openvideo dev`. Die Adresse steht in der Ausgabe.

Das Studio zeigt die Composition. Änderungen im Studio landen als Patches in `project.json`.

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
- MCP: `openvideo mcp` (stdio). Beispiel für Claude Code: `claude mcp add openvideo -- openvideo mcp --workspace ~/ov`.
- Lies danach [docs/ai/AGENTS.md](../ai/AGENTS.md).
