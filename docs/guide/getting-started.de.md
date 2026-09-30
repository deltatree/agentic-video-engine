# Erste Schritte

[English version](getting-started.md)

## Voraussetzungen

| Werkzeug | Zweck | Pflicht |
|---|---|---|
| Node.js 22.13 oder neuer | Laufzeit | ja |
| FFmpeg 6 oder neuer (CI und Images nutzen 7.1) | Video-Encoding, Medien | ja, für Videos |
| Chromium (über Playwright) | HTML/CSS, PixiJS, Three.js | nur für diese Node-Typen |
| Docker | Sandbox für TSX und HTML-Skripte, Docker-Worker | nur für Agent-Code |
| Blender 4.2 LTS | `blender`-Nodes | nein |
| Piper oder espeak-ng, whisper.cpp | Voiceover, Transkription | nein |

## Installation

OpenVideo wird nicht auf npm veröffentlicht; jeder baut es aus dem Repository. Am einfachsten lässt du das
deinen Coding Assistant erledigen: Sag ihm, er soll [SETUP.md](../../SETUP.md) lesen und befolgen. Von Hand:

```bash
git clone https://github.com/deltatree/agentic-video-engine.git ~/openvideo
cd ~/openvideo
npm run setup
```

`npm run setup` wählt die Laufzeit – die mit `--runtime <docker|podman|kubernetes|native>` angegebene, sonst die
erste nutzbare aus Docker, Podman und Kubernetes; native (Node.js auf diesem Rechner) nur als letzter Rückfall. Mit einer
Container-Laufzeit baut es das Image `openvideo-local` lokal mit dieser Technik (FFmpeg, Chromium, Schriften und Studio
darin) und installiert den Befehl `openvideo` als Wrapper in `~/.local/bin`: Jeder Befehl läuft in einem Container, der
den aktuellen Ordner unter demselben Pfad sieht; `dev`/`studio`/`serve` veröffentlichen ihren Port nur auf `127.0.0.1`.
Mit Kubernetes führt der Wrapper Befehle in einem Pod aus (`deploy/k8s/overlays/dev`). Die Wahl wird gespeichert;
`git pull && npm run setup` baut später mit derselben Laufzeit neu. Details, Optionen und Fehlersuche: SETUP.de.md;
die Entscheidung: [ADR 0029](../adr/0029-setup-im-container-docker-podman-kubernetes.md).

Mit einer Container-Laufzeit gilt die Tabelle oben für das Image, nicht für deinen Rechner: Du brauchst nur Node.js für das Setup-Skript.

Prüfe alles mit `openvideo doctor`. Jede Zeile nennt bei Bedarf eine Lösung.

## Projekt anlegen und ansehen

1. Lege ein Projekt an: `openvideo create hello` (`--tsx` für TypeScript/JSX, `--template <name>` für eines der 15 Templates; `openvideo templates` listet sie).
2. Wechsle in den Ordner: `cd hello`.
3. Starte das Studio: `openvideo dev`. Der Browser öffnet sich mit dem Projekt; die Adresse (mit Token im `#token=`-Fragment) steht auch in der Ausgabe. Im Container (Docker/Podman) öffnest du die ausgegebene Adresse selbst.

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

`render` nutzt standardmäßig mehrere Worker-Prozesse (Kerne − 1, höchstens einer je 1,5 GB des Speicherbudgets – halber Arbeitsspeicher, höchstens der freie – und höchstens 16); `--workers 1` rendert im Prozess.
Ein zweiter Lauf rendert nur geänderte Frames neu; der Rest kommt aus dem Cache unter `.openvideo/cache`. Ein identischer Render nutzt die ganze Ausgabedatei wieder.

## TSX statt JSON

1. Lege ein TSX-Projekt an: `openvideo create hello --tsx`.
2. Die Quelle liegt in `src/video.tsx`. JSX ist nur Syntax; das Ergebnis ist dieselbe IR.
3. TSX ist Code. OpenVideo führt ihn in einem Docker-Container ohne Netz aus.
4. Für dein eigenes Projekt kannst du mit `--trusted` auf dem Host ausführen.

## Für Agents

- Agent API: `openvideo serve --port 7788` (HTTP, `GET /v1/operations`).
- MCP: `openvideo mcp` (stdio). Beispiel für Claude Code: `claude mcp add openvideo -- openvideo mcp --workspace ~/ov`, für ein bestehendes Projekt `openvideo mcp --project ./hello`. [examples/mcp.json](../../examples/mcp.json) ist eine Client-Konfiguration.
- Jede Operation auch ohne Server: `openvideo op <name> --input '<json>'` (Liste: `openvideo op --list`).
- Lies danach [docs/ai/AGENTS.de.md](../ai/AGENTS.de.md) (englisch: [AGENTS.md](../ai/AGENTS.md)).

## Nützliche Umgebungsvariablen

| Variable | Wirkung |
|---|---|
| `OPENVIDEO_FFMPEG`, `OPENVIDEO_FFPROBE` | Pfade zu FFmpeg und FFprobe |
| `OPENVIDEO_CHROMIUM`, `OPENVIDEO_BLENDER` | Pfade zu Chromium und Blender |
| `OPENVIDEO_PIPER`, `OPENVIDEO_PIPER_MODEL`, `OPENVIDEO_ESPEAK`, `OPENVIDEO_WHISPER`, `OPENVIDEO_WHISPER_MODEL` | Sprachsynthese und Spracherkennung |
| `OPENVIDEO_API_TOKEN` | Bearer-Token der Agent API (Pflicht auf jeder Adresse außer Loopback) |
| `OPENVIDEO_WORKSPACE`, `OPENVIDEO_PROJECT_ROOTS` | Workspace-Ordner; Ordner, die `project.open` öffnen darf |
| `OPENVIDEO_WORKERS`, `OPENVIDEO_ENCODER_THREADS` | Lokale Render-Prozesse; Encoder-Threads (Standard fest 4 für bitgleiche Dateien, `auto` für Tempo) |
| `OPENVIDEO_CACHE_DIR`, `OPENVIDEO_CACHE_MAX_BYTES`, `OPENVIDEO_OUTPUT_CACHE` | Ort und Obergrenze des Caches, Wiederverwendung ganzer Ausgabedateien (`0` = aus) |
| `OPENVIDEO_RENDER_ISOLATION`, `OPENVIDEO_WORKER_IMAGE`, `OPENVIDEO_WORKER_GPUS` | Chunks in Docker-Containern rendern, mit Image und GPU-Quota |
| `OPENVIDEO_BROWSER_GPU` | `1` rendert WebGL/WebGPU auf der GPU des Hosts statt mit SwiftShader (nicht bitgleich) |
| `OPENVIDEO_ALLOW_HTML_SCRIPTS`, `OPENVIDEO_ALLOW_PLUGINS`, `OPENVIDEO_PLUGIN_PERMISSIONS` | HTML-Skripte (nur mit Chromium-OS-Sandbox) und Plugins erlauben |

Einstellungen für den Cluster (Koordinator, S3, Rollen-Tokens, Metriken) stehen in [deploy/README.de.md](../../deploy/README.de.md).
