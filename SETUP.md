# Set up OpenVideo – instructions for coding assistants

German version: [SETUP.de.md](SETUP.de.md).

OpenVideo is not published on npm. Everyone builds it from this repository; it takes a few minutes.
By default it runs in a **container** – Docker, Podman or Kubernetes, whichever is available or whichever the user asks for.
The image is built locally with that technology; nothing is pulled from a registry.
You do not have to do it by hand: give this file to your coding assistant (Claude Code, Cursor, Codex, Copilot, …) and it sets everything up.

**Tell your assistant:**

```text
Read https://raw.githubusercontent.com/deltatree/agentic-video-engine/main/SETUP.md and follow it to set up OpenVideo for me.
```

If you want a particular runtime, say so, for example "… set up OpenVideo for me with Podman" or "… in my kind cluster".

---

## For the coding assistant

Follow these steps in order. Run every command yourself, check its result, and fix problems before you go on.
Ask the user only when a step needs their decision: a runtime they asked for is not available, `sudo` or installing software, the install location, MCP registration.
Report at the end which runtime you chose and why, what you installed and where.

### 1. Determine the runtime

| Runtime | When | What it does |
|---|---|---|
| `docker` | Docker daemon reachable (`docker info` works) | Builds the image with `docker build`; `openvideo` runs a container |
| `podman` | `podman info` works (macOS/Windows: `podman machine start` first) | Builds the image with `podman build`; `openvideo` runs a container (rootless supported) |
| `kubernetes` | `kubectl` reaches a cluster and an image builder (docker, podman, nerdctl or buildah) is available | Builds the image locally, loads it into the cluster, deploys a small stack; `openvideo` runs commands in the pod |
| `native` | Only as a last resort, or when the user asks for it | Node.js on this host (npm ci, build, Chromium, global link) |

1. **Did the user name a runtime** ("with Docker", "Podman", "in my cluster", "natively")? Use it: `--runtime <name>`.
   If it is not available, the setup stops with the reason. Then ask the user whether to install or start it, or to use another runtime.
2. **Otherwise** let the setup detect it: `--runtime auto` is the default and checks Docker, Podman and Kubernetes in this order.
   Native is used only when none of them works, with a clear message.
3. Preview the decision without changing anything:

   ```bash
   npm run setup -- --dry-run
   ```

   The JSON shows the detection (`detection`), the chosen runtime with its reason, the build command, every step and the content of the `openvideo` wrapper.

The choice is saved in `~/.config/openvideo/runtime.json` (change the folder with `OPENVIDEO_CONFIG_DIR`), so later updates use the same runtime.
`OPENVIDEO_RUNTIME=<name>` does the same as `--runtime`; the option wins.

### 2. Prerequisites

| Tool | Check | Needed for |
|---|---|---|
| git | `git --version` | cloning |
| Node.js **22.13 or newer** | `node --version` | running the setup script (and everything with `native`) |
| Docker, Podman or `kubectl` | `docker info`, `podman info`, `kubectl version` | the container runtimes |
| FFmpeg | `ffmpeg -version` | only `native` – the image contains FFmpeg, Chromium and fonts |

Install what is missing (ask before using `sudo`):

| System | Node.js 22 | Docker / Podman |
|---|---|---|
| macOS | `brew install node@22` | Docker Desktop, or `brew install podman && podman machine init && podman machine start` |
| Debian/Ubuntu | `curl -fsSL https://deb.nodesource.com/setup_22.x \| sudo -E bash - && sudo apt-get install -y nodejs` (or `nvm install 22`) | `sudo apt-get install -y podman`, or Docker Engine (docs.docker.com/engine/install) |
| Fedora | `sudo dnf install nodejs22` (or `nvm install 22`) | `sudo dnf install podman` |
| Windows | `winget install OpenJS.NodeJS.LTS` | Docker Desktop or Podman Desktop |

For `native` also install FFmpeg (`brew install ffmpeg`, `sudo apt-get install -y ffmpeg`, `winget install Gyan.FFmpeg`).

### 3. Clone and set up

Pick a stable location outside the user's project (default `~/openvideo`; ask if unsure):

```bash
git clone https://github.com/deltatree/agentic-video-engine.git ~/openvideo
cd ~/openvideo
npm run setup
```

Examples for each runtime:

```bash
npm run setup -- --runtime docker
npm run setup -- --runtime podman
npm run setup -- --runtime kubernetes
npm run setup -- --runtime native
```

What `npm run setup` does with a container runtime:

1. detects the runtime (step 1) and prints it with the reason,
2. builds the image `openvideo-local:<version>` (also `openvideo-local:latest`) from `deploy/docker/Dockerfile`, target `local`:
   CLI, Studio, FFmpeg, Chromium, fonts. The first build takes a few minutes and about 2.5 GB,
3. creates a random API token in `~/.config/openvideo/api.env` (only readable by the user),
4. installs the command `openvideo` as a small wrapper script in `~/.local/bin` (`--bin-dir <dir>` for another folder),
5. runs `openvideo doctor` in the container.

The wrapper starts a container for every command: the current folder is mounted under the same path, files belong to the user,
`serve`/`dev`/`studio` publish their port only on `127.0.0.1`, the cache lives in the volume `openvideo-cache-<uid>`.
If `~/.local/bin` is not on `PATH`, the setup says so; add it (for example `export PATH="$HOME/.local/bin:$PATH"` in `~/.profile`).

Options:

| Option | Effect |
|---|---|
| `--runtime <auto\|docker\|podman\|kubernetes\|native>` | Runtime (default `auto`; or `OPENVIDEO_RUNTIME`) |
| `--dry-run` | Only print detection, commands and wrapper as JSON |
| `--bin-dir <dir>` | Folder for the `openvideo` wrapper (default `~/.local/bin`) |
| `--with-blender` | Image with Blender 4.2 LTS (`blender` nodes) |
| `--gpu` | Pass the NVIDIA GPU into the container or pod (needs the NVIDIA Container Toolkit or a GPU node) |
| `--ca-cert <file>` | CA certificates of a TLS-inspecting proxy for the image build (default: `NODE_EXTRA_CA_CERTS`) |
| `--skip-build` | Container runtimes: reuse the existing image, only rewrite wrapper and settings |
| `--builder`, `--cluster`, `--registry`, `--kube-context`, `--namespace` | Kubernetes, see below |
| `--skip-install`, `--skip-build`, `--skip-browser`, `--with-deps`, `--no-link` | Native, see below |

#### Kubernetes

`npm run setup -- --runtime kubernetes` uses the current `kubectl` context (`--kube-context <ctx>` for another),
builds the image with the first available builder (docker, podman, nerdctl, buildah; `--builder <name>`) and brings it into the cluster:

| Cluster (detected from the context) | How the image gets there |
|---|---|
| kind (`kind-*`) | `kind load docker-image` (or `kind load image-archive` with podman/nerdctl/buildah) |
| minikube | `minikube image load` |
| k3d (`k3d-*`) | `k3d image import` |
| k3s (node version `+k3s`) | `k3s ctr images import` (needs `sudo` unless you are root) |
| Docker Desktop, Rancher Desktop | The local image is used directly (Rancher Desktop with containerd: `--builder nerdctl`) |
| any other cluster | `--registry <host/path>`: the image is pushed there and used from there |

Examples:

```bash
npm run setup -- --runtime kubernetes --kube-context kind-dev
npm run setup -- --runtime kubernetes --builder podman --namespace video
npm run setup -- --runtime kubernetes --registry registry.example.com/team
```

The setup deploys the small stack `deploy/k8s/overlays/dev` (one pod with CLI, Agent API and Studio, a workspace volume, no network egress)
into the namespace `openvideo-local` (`--namespace`). It writes the overlay with image, namespace and token to `~/.config/openvideo/kubernetes/` – nothing in the repository.
The wrapper then runs `openvideo` in the pod: `mcp` over `kubectl exec`, `serve`/`studio` over `kubectl port-forward` on `127.0.0.1:7788`,
and commands with files (`create`, `render`, `render-frame`, …) copy the current folder into the pod and the results back.
`openvideo dev` (watching local files) is not available with Kubernetes; use Docker or Podman for that.

#### Native (fallback)

`npm run setup -- --runtime native` works as before: checks Node.js and FFmpeg, `npm ci`, `npm run build`,
`npx playwright install chromium chromium-headless-shell`, `npm install -g ./packages/cli` (the command `openvideo` links to this checkout), `openvideo doctor`.
Options: `--skip-install`, `--skip-build`, `--skip-browser`, `--with-deps` (Linux: also install Chromium's system libraries, needs root/`sudo`), `--no-link` (do not link globally).
If linking fails, use an alias: `alias openvideo="node ~/openvideo/packages/cli/dist/bin.js"`.

### 4. Verify

```bash
openvideo --help
openvideo doctor
```

`doctor` prints one line per check with a fix for every gap; the first line names the runtime. Required: `node`, `ffmpeg`, `browser`. Everything else is optional.
Then render a first frame in a scratch folder:

```bash
mkdir -p ~/openvideo-scratch && cd ~/openvideo-scratch
openvideo create hello && cd hello
openvideo validate
openvideo render-frame --frame 1s --out out/frame.png
```

Open `out/frame.png` and look at it. If you can, show it to the user.

### 5. Connect OpenVideo to the assistant (MCP, optional but recommended)

With MCP the assistant gets all 31 operations as tools (render frames, inspect, patch, render videos).
Use the absolute path of the wrapper (the setup prints it; MCP clients often start without your shell's `PATH`):

- **Claude Code:** `claude mcp add openvideo -- ~/.local/bin/openvideo mcp --workspace ~/openvideo-projects`
  (or `--project <dir>` for one existing project).
- **Other clients (Cursor, Windsurf, VS Code, …):** add this to the client's MCP configuration; [examples/mcp.json](examples/mcp.json) is a template:

  ```json
  { "mcpServers": { "openvideo": { "command": "/home/you/.local/bin/openvideo", "args": ["mcp", "--workspace", "/absolute/path/to/openvideo-projects"] } } }
  ```

With Docker or Podman the workspace folder is mounted into the container under the same path, so file paths in MCP answers are valid on your computer.
With Kubernetes the MCP server uses the workspace volume in the pod. With `native` and the global link, `"command": "openvideo"` is enough.

Without MCP everything also works through the CLI: `openvideo op <operation> --input '<json>'`.

### 6. Learn how to make videos

Read [docs/ai/AGENTS.md](docs/ai/AGENTS.md) (over MCP also the resource `openvideo://agents.md`). It explains the loop – create, validate, look at frames, patch, render – the JSON format, animation, patches and diagnostics.
More: [recipes](docs/guide/recipes.md), [examples](examples/README.md), [getting started](docs/guide/getting-started.md), [llms.txt](llms.txt).

### 7. Update later

```bash
cd ~/openvideo && git pull && npm run setup
```

The setup takes the saved runtime from `runtime.json` and rebuilds the image; unchanged layers come from the build cache.
The API token stays the same. With `native`, `npm run setup -- --skip-browser` is enough unless `doctor` reports a Chromium version mismatch.
To switch the runtime, run the setup with `--runtime <name>`; switching to `native` removes the wrapper.

### Troubleshooting

| Problem | Fix |
|---|---|
| `openvideo: command not found` | Add the bin folder the setup printed (default `~/.local/bin`) to `PATH`, open a new shell |
| Setup: "another openvideo comes first on your PATH" | An old native link wins: `npm uninstall -g @agentic-video/cli`, or put `~/.local/bin` first |
| Setup: "Runtime docker … is not usable" | Start Docker (`sudo systemctl start docker`, Docker Desktop) or add the user to the `docker` group; or choose `--runtime podman` |
| Docker: `permission denied … docker.sock` | `sudo usermod -aG docker $USER`, log out and in again |
| Podman on macOS/Windows: `podman info` fails | `podman machine init` (once) and `podman machine start` |
| Podman: old version fails on the Dockerfile | Podman 4.9 or newer; the setup builds with `--format docker` |
| Image build fails with TLS/certificate errors | Behind a TLS-inspecting proxy: `npm run setup -- --ca-cert /path/to/ca.pem` |
| Podman build: `ECONNREFUSED 127.0.0.1:<port>` while downloading | Podman passes `HTTP(S)_PROXY` into the build; a proxy on `127.0.0.1` is not reachable from there. Unset the variables for the setup or use an address the build container can reach |
| `dev` does not see changes (macOS/Windows) | The wrapper polls every second (`OPENVIDEO_WATCH_POLL_MS`); set a smaller value if needed |
| Port 7788 in use | `openvideo serve --port 7790` (the wrapper publishes the same port on `127.0.0.1`) |
| Kubernetes: "Cannot bring the locally built image into the cluster" | Use `--registry <host/path>` or `--cluster <kind\|minikube\|k3d\|k3s\|docker-desktop\|rancher-desktop>` |
| Kubernetes: pod not ready | `kubectl -n openvideo-local get pods`, `kubectl -n openvideo-local describe pod -l app.kubernetes.io/component=openvideo` |
| Kubernetes: `openvideo dev` not available | Use `openvideo studio` (workspace in the pod) or set up Docker/Podman |
| Native: `doctor` reports browser or FFmpeg missing | `npm run setup -- --runtime native --skip-install --skip-build` (add `--with-deps` on Linux); install FFmpeg |
| TSX projects: `OV_SANDBOX_REQUIRED` | Run your **own** project with `--trusted` (in the container it sees only the mounted folders); untrusted TSX needs `native` with Docker |
| Anything else | The error has `code`, `problem` and `suggestions`; follow the suggestions. `npm run setup -- --dry-run` shows what the setup would do |
