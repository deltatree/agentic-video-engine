# Set up OpenVideo – instructions for coding assistants

German version: [SETUP.de.md](SETUP.de.md).

OpenVideo is not published on npm. Everyone builds it from this repository; it takes a few minutes.
You do not have to do it by hand: give this file to your coding assistant (Claude Code, Cursor, Codex, Copilot, …) and it sets everything up.

**Tell your assistant:**

```text
Read https://raw.githubusercontent.com/deltatree/agentic-video-engine/main/SETUP.md and follow it to set up OpenVideo for me.
```

---

## For the coding assistant

Follow these steps in order. Run every command yourself, check its result, and fix problems before you go on.
Ask the user only when a step needs their decision (install location, `sudo`, MCP registration).
Report at the end what you installed and where.

### 1. Check the prerequisites

| Tool | Check | Needed for |
|---|---|---|
| git | `git --version` | cloning |
| Node.js **22.13 or newer** | `node --version` | everything |
| FFmpeg and ffprobe | `ffmpeg -version`, `ffprobe -version` | encoding videos, audio, video assets |

Install what is missing (ask before using `sudo`):

| System | Node.js 22 | FFmpeg |
|---|---|---|
| macOS | `brew install node@22` | `brew install ffmpeg` |
| Debian/Ubuntu | `curl -fsSL https://deb.nodesource.com/setup_22.x \| sudo -E bash - && sudo apt-get install -y nodejs` (or `nvm install 22`) | `sudo apt-get install -y ffmpeg` |
| Fedora | `sudo dnf install nodejs22` (or `nvm install 22`) | `sudo dnf install ffmpeg` (RPM Fusion) |
| Windows | `winget install OpenJS.NodeJS.LTS` | `winget install Gyan.FFmpeg` |

If FFmpeg is not on `PATH`, set `OPENVIDEO_FFMPEG` and `OPENVIDEO_FFPROBE` to the two executables.

Optional, only when the user wants these features: `espeak-ng` or Piper (voiceover), whisper.cpp (transcription), Blender 4.2 (`blender` nodes), Docker (running untrusted TSX in a container).
`openvideo doctor` later lists each of them with an install hint.

### 2. Clone and build

Pick a stable location outside the user's project (default `~/openvideo`; ask if unsure):

```bash
git clone https://github.com/deltatree/agentic-video-engine.git ~/openvideo
cd ~/openvideo
npm run setup
```

`npm run setup` (`scripts/setup.mjs`) does all of this and stops with a clear message on the first real error:

1. checks the Node.js version and FFmpeg,
2. `npm ci` – installs dependencies,
3. `npm run build` – builds all packages and copies the Studio into the CLI package,
4. `npx playwright install chromium chromium-headless-shell` – downloads Chromium for HTML, PixiJS and 3D layers,
5. `npm install -g ./packages/cli` – puts the command `openvideo` on the `PATH` (a link to this checkout),
6. `openvideo doctor` – checks the environment.

Options: `--dry-run` (only print the plan), `--skip-install`, `--skip-build`, `--skip-browser`, `--with-deps` (Linux: also install Chromium's system libraries, needs root/`sudo`), `--no-link` (do not link globally).
Example: `npm run setup -- --with-deps`.

If Chromium fails to start on Linux with missing libraries, run `npm run setup -- --skip-install --skip-build --with-deps`.

If linking fails (no write access to the global npm folder), use an alias instead and add it to the user's shell profile:

```bash
alias openvideo="node ~/openvideo/packages/cli/dist/bin.js"
```

### 3. Verify

```bash
openvideo --help
openvideo doctor
```

`doctor` prints one line per check with a fix for every gap. Required: `node`, `ffmpeg`, `browser`. Everything else is optional.
Then render a first frame in a scratch folder:

```bash
cd /tmp && openvideo create hello && cd hello
openvideo validate
openvideo render-frame --frame 1s --out out/frame.png
```

Open `out/frame.png` and look at it. If you can, show it to the user.

### 4. Connect OpenVideo to the assistant (MCP, optional but recommended)

With MCP the assistant gets all 31 operations as tools (render frames, inspect, patch, render videos).

- **Claude Code:** `claude mcp add openvideo -- openvideo mcp --workspace ~/openvideo-projects`
  (or `--project <dir>` for one existing project).
- **Other clients (Cursor, Windsurf, VS Code, …):** add this to the client's MCP configuration; [examples/mcp.json](examples/mcp.json) is a template:

  ```json
  { "mcpServers": { "openvideo": { "command": "openvideo", "args": ["mcp", "--workspace", "/absolute/path/to/openvideo-projects"] } } }
  ```

  Without the global link use `"command": "node"` and put the absolute path to `packages/cli/dist/bin.js` first in `args`.

Without MCP everything also works through the CLI: `openvideo op <operation> --input '<json>'`.

### 5. Learn how to make videos

Read [docs/ai/AGENTS.md](docs/ai/AGENTS.md) (over MCP also the resource `openvideo://agents.md`). It explains the loop – create, validate, look at frames, patch, render – the JSON format, animation, patches and diagnostics.
More: [recipes](docs/guide/recipes.md), [examples](examples/README.md), [getting started](docs/guide/getting-started.md), [llms.txt](llms.txt).

### 6. Update later

```bash
cd ~/openvideo && git pull && npm run setup -- --skip-browser
```

The global link points to the checkout, so the new build is used right away.
Run the full setup (without `--skip-browser`) when `doctor` reports a Chromium version mismatch.

### Troubleshooting

| Problem | Fix |
|---|---|
| `openvideo: command not found` | Open a new shell, check `npm prefix -g` is on `PATH`, or use the alias from step 2 |
| `doctor`: browser missing or wrong version | `npm run setup -- --skip-install --skip-build` (add `--with-deps` on Linux) |
| `doctor`: FFmpeg missing | Install it (step 1) or set `OPENVIDEO_FFMPEG`/`OPENVIDEO_FFPROBE` |
| `EACCES` while linking | Use the alias, or configure a user-owned npm prefix (`npm config set prefix ~/.npm-global`) |
| TSX projects: `OV_SANDBOX_REQUIRED` | Install Docker, or run your **own** project with `--trusted` |
| Anything else | The error has `code`, `problem` and `suggestions`; follow the suggestions |
