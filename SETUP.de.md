# OpenVideo einrichten – Anleitung für Coding Assistants

English version: [SETUP.md](SETUP.md).

OpenVideo wird nicht auf npm veröffentlicht. Jeder baut es aus diesem Repository; das dauert wenige Minuten.
Von Hand musst du nichts tun: Gib diese Datei deinem Coding Assistant (Claude Code, Cursor, Codex, Copilot, …), und er richtet alles ein.

**Sag deinem Assistant:**

```text
Read https://raw.githubusercontent.com/deltatree/agentic-video-engine/main/SETUP.md and follow it to set up OpenVideo for me.
```

(Der Assistant liest die englische Fassung; die Schritte sind dieselben wie hier.)

---

## Für den Coding Assistant

Arbeite die Schritte der Reihe nach ab. Führe jeden Befehl selbst aus, prüfe das Ergebnis und behebe Probleme, bevor du weitermachst.
Frage nur, wenn ein Schritt eine Entscheidung braucht (Installationsort, `sudo`, MCP-Anmeldung).
Berichte am Ende, was du wo installiert hast.

### 1. Voraussetzungen prüfen

| Werkzeug | Prüfung | Wofür |
|---|---|---|
| git | `git --version` | Klonen |
| Node.js **22.13 oder neuer** | `node --version` | alles |
| FFmpeg und ffprobe | `ffmpeg -version`, `ffprobe -version` | Videos kodieren, Audio, Video-Assets |

Installiere, was fehlt (vor `sudo` fragen):

| System | Node.js 22 | FFmpeg |
|---|---|---|
| macOS | `brew install node@22` | `brew install ffmpeg` |
| Debian/Ubuntu | `curl -fsSL https://deb.nodesource.com/setup_22.x \| sudo -E bash - && sudo apt-get install -y nodejs` (oder `nvm install 22`) | `sudo apt-get install -y ffmpeg` |
| Fedora | `sudo dnf install nodejs22` (oder `nvm install 22`) | `sudo dnf install ffmpeg` (RPM Fusion) |
| Windows | `winget install OpenJS.NodeJS.LTS` | `winget install Gyan.FFmpeg` |

Liegt FFmpeg nicht im `PATH`, setze `OPENVIDEO_FFMPEG` und `OPENVIDEO_FFPROBE` auf die beiden Programme.

Optional, nur wenn diese Funktionen gewünscht sind: `espeak-ng` oder Piper (Voiceover), whisper.cpp (Transkription), Blender 4.2 (`blender`-Nodes), Docker (fremden TSX-Code im Container ausführen).
`openvideo doctor` nennt später jedes davon mit Installationshinweis.

### 2. Klonen und bauen

Wähle einen festen Ort außerhalb des Nutzerprojekts (Standard `~/openvideo`; im Zweifel fragen):

```bash
git clone https://github.com/deltatree/agentic-video-engine.git ~/openvideo
cd ~/openvideo
npm run setup
```

`npm run setup` (`scripts/setup.mjs`) erledigt alles und bricht beim ersten echten Fehler mit klarer Meldung ab:

1. prüft Node.js-Version und FFmpeg,
2. `npm ci` – installiert die Abhängigkeiten,
3. `npm run build` – baut alle Pakete und kopiert das Studio ins CLI-Paket,
4. `npx playwright install chromium chromium-headless-shell` – lädt Chromium für HTML-, PixiJS- und 3D-Layer,
5. `npm install -g ./packages/cli` – legt den Befehl `openvideo` in den `PATH` (ein Link auf diesen Checkout),
6. `openvideo doctor` – prüft die Umgebung.

Optionen: `--dry-run` (nur den Plan ausgeben), `--skip-install`, `--skip-build`, `--skip-browser`, `--with-deps` (Linux: auch die Systembibliotheken von Chromium, braucht root/`sudo`), `--no-link` (nicht global verlinken).
Beispiel: `npm run setup -- --with-deps`.

Startet Chromium unter Linux wegen fehlender Bibliotheken nicht: `npm run setup -- --skip-install --skip-build --with-deps`.

Scheitert das Verlinken (keine Schreibrechte im globalen npm-Ordner), nutze einen Alias und trage ihn im Shell-Profil ein:

```bash
alias openvideo="node ~/openvideo/packages/cli/dist/bin.js"
```

### 3. Prüfen

```bash
openvideo --help
openvideo doctor
```

`doctor` gibt je Prüfung eine Zeile mit einer Lösung für jede Lücke aus. Pflicht: `node`, `ffmpeg`, `browser`. Alles andere ist optional.
Danach einen ersten Frame in einem Testordner rendern:

```bash
cd /tmp && openvideo create hello && cd hello
openvideo validate
openvideo render-frame --frame 1s --out out/frame.png
```

Öffne `out/frame.png` und sieh es dir an. Wenn möglich, zeig es dem Nutzer.

### 4. OpenVideo mit dem Assistant verbinden (MCP, optional, empfohlen)

Über MCP bekommt der Assistant alle 31 Operationen als Werkzeuge (Frames rendern, prüfen, patchen, Videos rendern).

- **Claude Code:** `claude mcp add openvideo -- openvideo mcp --workspace ~/openvideo-projects`
  (oder `--project <dir>` für ein bestehendes Projekt).
- **Andere Clients (Cursor, Windsurf, VS Code, …):** in die MCP-Konfiguration des Clients eintragen; [examples/mcp.json](examples/mcp.json) ist eine Vorlage:

  ```json
  { "mcpServers": { "openvideo": { "command": "openvideo", "args": ["mcp", "--workspace", "/absolute/path/to/openvideo-projects"] } } }
  ```

  Ohne globalen Link: `"command": "node"` und den absoluten Pfad zu `packages/cli/dist/bin.js` als erstes Element in `args`.

Ohne MCP geht alles auch über die CLI: `openvideo op <operation> --input '<json>'`.

### 5. Lernen, wie man Videos macht

Lies [docs/ai/AGENTS.md](docs/ai/AGENTS.md) (über MCP auch als Resource `openvideo://agents.md`). Dort stehen der Ablauf – anlegen, prüfen, Frames ansehen, patchen, rendern –, das JSON-Format, Animation, Patches und Diagnosen.
Mehr: [Rezepte](docs/guide/recipes.de.md), [Beispiele](examples/README.md), [Erste Schritte](docs/guide/getting-started.de.md), [llms.txt](llms.txt).

### 6. Später aktualisieren

```bash
cd ~/openvideo && git pull && npm run setup -- --skip-browser
```

Der globale Link zeigt auf den Checkout; der neue Build gilt sofort.
Meldet `doctor` eine abweichende Chromium-Version, das volle Setup (ohne `--skip-browser`) ausführen.

### Fehlersuche

| Problem | Lösung |
|---|---|
| `openvideo: command not found` | Neue Shell öffnen, prüfen, ob `npm prefix -g` im `PATH` liegt, oder den Alias aus Schritt 2 nutzen |
| `doctor`: Browser fehlt oder falsche Version | `npm run setup -- --skip-install --skip-build` (unter Linux mit `--with-deps`) |
| `doctor`: FFmpeg fehlt | Installieren (Schritt 1) oder `OPENVIDEO_FFMPEG`/`OPENVIDEO_FFPROBE` setzen |
| `EACCES` beim Verlinken | Alias nutzen oder ein eigenes npm-Präfix einrichten (`npm config set prefix ~/.npm-global`) |
| TSX-Projekte: `OV_SANDBOX_REQUIRED` | Docker installieren oder das **eigene** Projekt mit `--trusted` ausführen |
| Alles andere | Der Fehler hat `code`, `problem` und `suggestions`; den Vorschlägen folgen |
