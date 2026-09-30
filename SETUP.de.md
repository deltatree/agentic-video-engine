# OpenVideo einrichten – Anleitung für Coding Assistants

English version: [SETUP.md](SETUP.md).

OpenVideo wird nicht auf npm veröffentlicht. Jeder baut es aus diesem Repository; das dauert wenige Minuten.
Standardmäßig läuft es in einem **Container** – Docker, Podman oder Kubernetes, je nachdem, was verfügbar ist oder was der Nutzer vorgibt.
Das Image wird lokal mit genau dieser Technik gebaut; aus keiner Registry wird etwas geladen.
Von Hand musst du nichts tun: Gib diese Datei deinem Coding Assistant (Claude Code, Cursor, Codex, Copilot, …), und er richtet alles ein.

**Sag deinem Assistant:**

```text
Read https://raw.githubusercontent.com/deltatree/agentic-video-engine/main/SETUP.md and follow it to set up OpenVideo for me.
```

Wenn du eine bestimmte Laufzeit willst, sag es dazu, zum Beispiel „… richte OpenVideo mit Podman ein“ oder „… in meinem kind-Cluster“.
(Der Assistant liest die englische Fassung; die Schritte sind dieselben wie hier.)

---

## Für den Coding Assistant

Arbeite die Schritte der Reihe nach ab. Führe jeden Befehl selbst aus, prüfe das Ergebnis und behebe Probleme, bevor du weitermachst.
Frage nur, wenn ein Schritt eine Entscheidung des Nutzers braucht: eine gewünschte Laufzeit ist nicht verfügbar, `sudo` oder Installationen, der Installationsort, die MCP-Anmeldung.
Berichte am Ende, welche Laufzeit du gewählt hast und warum, was du wo installiert hast.

### 1. Laufzeit bestimmen

| Laufzeit | Wann | Was passiert |
|---|---|---|
| `docker` | Docker-Daemon erreichbar (`docker info` funktioniert) | Baut das Image mit `docker build`; `openvideo` startet einen Container |
| `podman` | `podman info` funktioniert (macOS/Windows: vorher `podman machine start`) | Baut das Image mit `podman build`; `openvideo` startet einen Container (auch rootless) |
| `kubernetes` | `kubectl` erreicht einen Cluster, und ein Image-Builder (docker, podman, nerdctl oder buildah) ist da | Baut das Image lokal, bringt es in den Cluster, deployt einen kleinen Stack; `openvideo` führt Befehle im Pod aus |
| `native` | Nur als letzter Rückfall oder auf Wunsch des Nutzers | Node.js auf diesem Rechner (npm ci, Build, Chromium, globaler Link) |

1. **Hat der Nutzer eine Laufzeit genannt** („mit Docker“, „Podman“, „in meinem Cluster“, „nativ“)? Dann diese: `--runtime <name>`.
   Ist sie nicht verfügbar, bricht das Setup mit dem Grund ab. Frag dann den Nutzer, ob du sie installieren oder starten sollst oder eine andere nehmen.
2. **Sonst** erkennt das Setup sie selbst: `--runtime auto` ist der Standard und prüft Docker, Podman und Kubernetes in dieser Reihenfolge.
   Native kommt nur, wenn nichts davon funktioniert, mit deutlicher Meldung.
3. Die Entscheidung vorab ansehen, ohne etwas zu ändern:

   ```bash
   npm run setup -- --dry-run
   ```

   Das JSON zeigt die Erkennung (`detection`), die gewählte Laufzeit mit Grund, den Build-Befehl, alle Schritte und den Inhalt des Wrappers `openvideo`.

Die Wahl wird in `~/.config/openvideo/runtime.json` gespeichert (Ordner änderbar mit `OPENVIDEO_CONFIG_DIR`); spätere Updates nehmen dieselbe Laufzeit.
`OPENVIDEO_RUNTIME=<name>` wirkt wie `--runtime`; die Option hat Vorrang.

### 2. Voraussetzungen

| Werkzeug | Prüfung | Wofür |
|---|---|---|
| git | `git --version` | Klonen |
| Node.js **22.13 oder neuer** | `node --version` | Setup-Skript (und alles bei `native`) |
| Docker, Podman oder `kubectl` | `docker info`, `podman info`, `kubectl version` | die Container-Laufzeiten |
| FFmpeg | `ffmpeg -version` | nur `native` – das Image enthält FFmpeg, Chromium und Schriften |

Installiere, was fehlt (frage vor `sudo`):

| System | Node.js 22 | Docker / Podman |
|---|---|---|
| macOS | `brew install node@22` | Docker Desktop, oder `brew install podman && podman machine init && podman machine start` |
| Debian/Ubuntu | `curl -fsSL https://deb.nodesource.com/setup_22.x \| sudo -E bash - && sudo apt-get install -y nodejs` (oder `nvm install 22`) | `sudo apt-get install -y podman`, oder Docker Engine (docs.docker.com/engine/install) |
| Fedora | `sudo dnf install nodejs22` (oder `nvm install 22`) | `sudo dnf install podman` |
| Windows | `winget install OpenJS.NodeJS.LTS` | Docker Desktop oder Podman Desktop |

Für `native` zusätzlich FFmpeg (`brew install ffmpeg`, `sudo apt-get install -y ffmpeg`, `winget install Gyan.FFmpeg`).

### 3. Klonen und einrichten

Wähle einen festen Ort außerhalb des Nutzerprojekts (Standard `~/openvideo`; frage im Zweifel):

```bash
git clone https://github.com/deltatree/agentic-video-engine.git ~/openvideo
cd ~/openvideo
npm run setup
```

Beispiele je Laufzeit:

```bash
npm run setup -- --runtime docker
npm run setup -- --runtime podman
npm run setup -- --runtime kubernetes
npm run setup -- --runtime native
```

Was `npm run setup` mit einer Container-Laufzeit tut:

1. erkennt die Laufzeit (Schritt 1) und gibt sie mit Grund aus,
2. baut das Image `openvideo-local:<version>` (auch `openvideo-local:latest`) aus `deploy/docker/Dockerfile`, Ziel `local`:
   CLI, Studio, FFmpeg, Chromium, Schriften. Der erste Build dauert einige Minuten und belegt rund 2,5 GB,
3. erzeugt ein zufälliges API-Token in `~/.config/openvideo/api.env` (nur für den Nutzer lesbar),
4. installiert den Befehl `openvideo` als kleines Wrapper-Skript in `~/.local/bin` (`--bin-dir <ordner>` für einen anderen Ordner),
5. führt `openvideo doctor` im Container aus.

Der Wrapper startet für jeden Befehl einen Container: Der aktuelle Ordner ist unter demselben Pfad eingehängt, Dateien gehören dem Nutzer,
`serve`/`dev`/`studio` veröffentlichen ihren Port nur auf `127.0.0.1`, der Cache liegt im Volume `openvideo-cache-<uid>`.
Liegt `~/.local/bin` nicht im `PATH`, sagt das Setup es; ergänze ihn (zum Beispiel `export PATH="$HOME/.local/bin:$PATH"` in `~/.profile`).

Optionen:

| Option | Wirkung |
|---|---|
| `--runtime <auto\|docker\|podman\|kubernetes\|native>` | Laufzeit (Standard `auto`; oder `OPENVIDEO_RUNTIME`) |
| `--dry-run` | Nur Erkennung, Befehle und Wrapper als JSON ausgeben |
| `--bin-dir <ordner>` | Ordner für den Wrapper `openvideo` (Standard `~/.local/bin`) |
| `--with-blender` | Image mit Blender 4.2 LTS (`blender`-Nodes) |
| `--gpu` | NVIDIA-GPU an Container oder Pod durchreichen (braucht das NVIDIA Container Toolkit bzw. einen GPU-Knoten) |
| `--ca-cert <datei>` | CA-Zertifikate eines TLS-prüfenden Proxys für den Image-Build (Standard: `NODE_EXTRA_CA_CERTS`) |
| `--skip-build` | Container-Laufzeiten: vorhandenes Image nutzen, nur Wrapper und Einstellungen neu schreiben |
| `--builder`, `--cluster`, `--registry`, `--kube-context`, `--namespace` | Kubernetes, siehe unten |
| `--skip-install`, `--skip-build`, `--skip-browser`, `--with-deps`, `--no-link` | Native, siehe unten |

#### Kubernetes

`npm run setup -- --runtime kubernetes` nutzt den aktuellen `kubectl`-Kontext (`--kube-context <ctx>` für einen anderen),
baut das Image mit dem ersten verfügbaren Builder (docker, podman, nerdctl, buildah; `--builder <name>`) und bringt es in den Cluster:

| Cluster (aus dem Kontext erkannt) | Wie das Image dorthin kommt |
|---|---|
| kind (`kind-*`) | `kind load docker-image` (bzw. `kind load image-archive` mit podman/nerdctl/buildah) |
| minikube | `minikube image load` |
| k3d (`k3d-*`) | `k3d image import` |
| k3s (Knotenversion `+k3s`) | `k3s ctr images import` (braucht `sudo`, außer als root) |
| Docker Desktop, Rancher Desktop | Das lokale Image wird direkt genutzt (Rancher Desktop mit containerd: `--builder nerdctl`) |
| jeder andere Cluster | `--registry <host/pfad>`: Das Image wird dorthin geschoben und von dort genutzt |

Beispiele:

```bash
npm run setup -- --runtime kubernetes --kube-context kind-dev
npm run setup -- --runtime kubernetes --builder podman --namespace video
npm run setup -- --runtime kubernetes --registry registry.example.com/team
```

Das Setup deployt den kleinen Stack `deploy/k8s/overlays/dev` (ein Pod mit CLI, Agent API und Studio, ein Workspace-Volume, kein ausgehender Netzverkehr)
in den Namespace `openvideo-local` (`--namespace`). Das Overlay mit Image, Namespace und Token schreibt es nach `~/.config/openvideo/kubernetes/` – nichts davon ins Repository.
Der Wrapper führt `openvideo` dann im Pod aus: `mcp` über `kubectl exec`, `serve`/`studio` über `kubectl port-forward` auf `127.0.0.1:7788`,
und Befehle mit Dateien (`create`, `render`, `render-frame`, …) kopieren den aktuellen Ordner in den Pod und die Ergebnisse zurück.
`openvideo dev` (lokale Dateien beobachten) gibt es mit Kubernetes nicht; dafür Docker oder Podman nehmen.

#### Native (Rückfall)

`npm run setup -- --runtime native` arbeitet wie bisher: prüft Node.js und FFmpeg, `npm ci`, `npm run build`,
`npx playwright install chromium chromium-headless-shell`, `npm install -g ./packages/cli` (der Befehl `openvideo` verweist auf diesen Checkout), `openvideo doctor`.
Optionen: `--skip-install`, `--skip-build`, `--skip-browser`, `--with-deps` (Linux: auch Chromiums Systembibliotheken, braucht root/`sudo`), `--no-link` (nicht global verlinken).
Scheitert das Verlinken, hilft ein Alias: `alias openvideo="node ~/openvideo/packages/cli/dist/bin.js"`.

### 4. Prüfen

```bash
openvideo --help
openvideo doctor
```

`doctor` gibt je Prüfung eine Zeile mit Lösung für jede Lücke aus; die erste Zeile nennt die Laufzeit. Pflicht: `node`, `ffmpeg`, `browser`. Alles andere ist optional.
Dann einen ersten Frame in einem Testordner rendern:

```bash
mkdir -p ~/openvideo-scratch && cd ~/openvideo-scratch
openvideo create hello && cd hello
openvideo validate
openvideo render-frame --frame 1s --out out/frame.png
```

Öffne `out/frame.png` und sieh es dir an. Wenn möglich, zeig es dem Nutzer.

### 5. OpenVideo mit dem Assistant verbinden (MCP, optional, empfohlen)

Über MCP bekommt der Assistant alle 31 Operationen als Werkzeuge (Frames rendern, prüfen, patchen, Videos rendern).
Nimm den absoluten Pfad des Wrappers (das Setup gibt ihn aus; MCP-Clients starten oft ohne den `PATH` deiner Shell):

- **Claude Code:** `claude mcp add openvideo -- ~/.local/bin/openvideo mcp --workspace ~/openvideo-projects`
  (oder `--project <ordner>` für ein bestehendes Projekt).
- **Andere Clients (Cursor, Windsurf, VS Code, …):** in die MCP-Konfiguration des Clients eintragen; [examples/mcp.json](examples/mcp.json) ist eine Vorlage:

  ```json
  { "mcpServers": { "openvideo": { "command": "/home/you/.local/bin/openvideo", "args": ["mcp", "--workspace", "/absolute/path/to/openvideo-projects"] } } }
  ```

Mit Docker oder Podman ist der Workspace-Ordner unter demselben Pfad im Container eingehängt; Dateipfade in MCP-Antworten gelten also auf deinem Rechner.
Mit Kubernetes nutzt der MCP-Server das Workspace-Volume im Pod. Mit `native` und globalem Link genügt `"command": "openvideo"`.

Ohne MCP geht alles auch über die CLI: `openvideo op <operation> --input '<json>'`.

### 6. Lernen, wie man Videos macht

Lies [docs/ai/AGENTS.de.md](docs/ai/AGENTS.de.md) (über MCP auch die Ressource `openvideo://agents.md`). Sie erklärt die Schleife – anlegen, validieren, Frames ansehen, patchen, rendern –, das JSON-Format, Animation, Patches und Diagnosen.
Mehr: [Rezepte](docs/guide/recipes.de.md), [Beispiele](examples/README.md), [Einstieg](docs/guide/getting-started.de.md), [llms.txt](llms.txt).

### 7. Später aktualisieren

```bash
cd ~/openvideo && git pull && npm run setup
```

Das Setup nimmt die gespeicherte Laufzeit aus `runtime.json` und baut das Image neu; unveränderte Schichten kommen aus dem Build-Cache.
Das API-Token bleibt gleich. Mit `native` genügt `npm run setup -- --skip-browser`, außer `doctor` meldet eine unpassende Chromium-Version.
Zum Wechsel der Laufzeit das Setup mit `--runtime <name>` ausführen; der Wechsel auf `native` entfernt den Wrapper.

### Fehlersuche

| Problem | Lösung |
|---|---|
| `openvideo: command not found` | Den vom Setup genannten Bin-Ordner (Standard `~/.local/bin`) in den `PATH` aufnehmen, neue Shell öffnen |
| Setup: „another openvideo comes first on your PATH“ | Ein alter nativer Link gewinnt: `npm uninstall -g @agentic-video/cli`, oder `~/.local/bin` nach vorn |
| Setup: „Runtime docker … is not usable“ | Docker starten (`sudo systemctl start docker`, Docker Desktop) oder den Nutzer in die Gruppe `docker` aufnehmen; oder `--runtime podman` |
| Docker: `permission denied … docker.sock` | `sudo usermod -aG docker $USER`, ab- und wieder anmelden |
| Podman unter macOS/Windows: `podman info` scheitert | `podman machine init` (einmal) und `podman machine start` |
| Podman: alte Version scheitert am Dockerfile | Podman 4.9 oder neuer; das Setup baut mit `--format docker` |
| Image-Build scheitert mit TLS-/Zertifikatsfehlern | Hinter einem TLS-prüfenden Proxy: `npm run setup -- --ca-cert /pfad/zu/ca.pem` |
| Podman-Build: `ECONNREFUSED 127.0.0.1:<port>` beim Herunterladen | Podman reicht `HTTP(S)_PROXY` in den Build; ein Proxy auf `127.0.0.1` ist von dort nicht erreichbar. Die Variablen für das Setup entfernen oder eine vom Build-Container erreichbare Adresse nutzen |
| `dev` sieht Änderungen nicht (macOS/Windows) | Der Wrapper fragt jede Sekunde ab (`OPENVIDEO_WATCH_POLL_MS`); bei Bedarf kleiner setzen |
| Port 7788 belegt | `openvideo serve --port 7790` (der Wrapper veröffentlicht denselben Port auf `127.0.0.1`) |
| Kubernetes: „Cannot bring the locally built image into the cluster“ | `--registry <host/pfad>` oder `--cluster <kind\|minikube\|k3d\|k3s\|docker-desktop\|rancher-desktop>` |
| Kubernetes: Pod nicht bereit | `kubectl -n openvideo-local get pods`, `kubectl -n openvideo-local describe pod -l app.kubernetes.io/component=openvideo` |
| Kubernetes: `openvideo dev` nicht verfügbar | `openvideo studio` nutzen (Workspace im Pod) oder Docker/Podman einrichten |
| Native: `doctor` meldet fehlenden Browser oder FFmpeg | `npm run setup -- --runtime native --skip-install --skip-build` (unter Linux mit `--with-deps`); FFmpeg installieren |
| TSX-Projekte: `OV_SANDBOX_REQUIRED` | Das **eigene** Projekt mit `--trusted` ausführen (im Container sieht es nur die eingehängten Ordner); fremde TSX brauchen `native` mit Docker |
| Alles andere | Der Fehler hat `code`, `problem` und `suggestions`; folge den Vorschlägen. `npm run setup -- --dry-run` zeigt, was das Setup tun würde |
