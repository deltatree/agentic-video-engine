// `npm run setup` (ADR 0029): Laufzeit wählen (docker, podman, kubernetes, native), Image lokal mit der
// jeweiligen Technik bauen, den Befehl `openvideo` als Wrapper installieren und die Wahl speichern.
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync, chmodSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { configDir, configPaths, ensurePrivateDir, envFileContent, readConfig, readToken, writePrivate } from './config.mjs';
import { chooseRuntime, detectBuilder, detectCluster, detectGpu } from './detect.mjs';
import { buildCommand, clusterImageName, imageIdCommand, imageTags, tagCommand } from './image.mjs';
import { archivePath, deploySteps, kustomization, loadImageSteps, namespaceManifest } from './kubernetes.mjs';
import { nativeProblems, nativeSteps } from './native.mjs';
import { USAGE, UsageError, parseOptions } from './options.mjs';
import { commandLine, firstLine, probe, which } from './util.mjs';
import { WRAPPER_MARKER, cmdWrapper, containerWrapper, kubernetesWrapper, powershellWrapper } from './wrapper.mjs';

const IMAGE_ID = '@IMAGE_ID@';

class SetupError extends Error {}

/**
 * Führt das Setup aus und liefert den Exit-Code (0 ok, 1 Fehler, 2 falsche Bedienung).
 *
 * @example
 * process.exitCode = await main(process.argv.slice(2));
 */
export async function main(argv, ctx = {}) {
  const env = ctx.env ?? process.env;
  const platform = ctx.platform ?? process.platform;
  const out = ctx.stdout ?? ((t) => process.stdout.write(t));
  const err = ctx.stderr ?? ((t) => process.stderr.write(t));
  const root = ctx.root ?? resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
  let opts;
  try {
    opts = parseOptions(argv, env);
  } catch (error) {
    if (!(error instanceof UsageError)) throw error;
    err(`${error.message}\n\n${USAGE}\n`);
    return 2;
  }
  if (opts.help) {
    out(`${USAGE}\n`);
    return 0;
  }
  try {
    const plan = makePlan({ opts, env, platform, root, err });
    if (opts.dryRun) {
      out(`${JSON.stringify(describe(plan), null, 2)}\n`);
      return 0;
    }
    return execute(plan, { env, out, err, platform });
  } catch (error) {
    if (!(error instanceof SetupError)) throw error;
    err(`\n${error.message}\n`);
    return 1;
  }
}

/** Plan: Erkennung, Schritte (Befehle, Dateien) und Abschlusshinweise – ohne etwas auszuführen. */
function makePlan({ opts, env, platform, root, err }) {
  const paths = configPaths(configDir(env, platform));
  const { config: saved, problem } = readConfig(paths);
  if (problem !== undefined) err(`Warning: ${problem}\n`);
  const wanted = opts.runtime ?? saved?.runtime;
  const source = opts.runtimeSource ?? (saved?.runtime !== undefined ? 'config' : 'auto');
  const same = saved !== undefined && (wanted === undefined || wanted === 'auto' || wanted === saved.runtime);
  // Einstellungen der letzten Einrichtung gelten weiter, solange die Laufzeit dieselbe bleibt.
  const k8sSaved = same ? (saved?.kubernetes ?? {}) : {};
  const choice = chooseRuntime({ env, wanted, source, kubeContext: opts.kubeContext ?? k8sSaved.context, builder: opts.builder ?? k8sSaved.builder });
  if (choice.error !== undefined) {
    throw new SetupError(`${choice.error}\n${detectionText(choice)}\nChoose another runtime with --runtime <docker|podman|kubernetes|native>, or --runtime auto to detect one.`);
  }
  const keep = saved !== undefined && saved.runtime === choice.runtime;
  const settings = {
    binDir: resolve(opts.binDir ?? (keep ? saved.binDir : undefined) ?? join(env.HOME ?? homedir(), '.local', 'bin')),
    withBlender: opts.withBlender || (keep && saved.withBlender === true),
    gpu: opts.gpu || (keep && saved.gpu === true),
    caCert: opts.caCert ?? (keep ? saved.caCert : undefined),
  };
  const version = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).version;
  const revision = probe('git', ['-C', root, 'rev-parse', 'HEAD'], { env }).stdout || 'unknown';
  const plan = { root, paths, choice, settings, version, actions: [], notes: [], summary: {} };
  if (choice.runtime === 'native') planNative(plan, { opts, env, platform });
  else if (choice.runtime === 'kubernetes') planKubernetes(plan, { opts, env, platform, k8sSaved, keep, saved, revision });
  else planContainer(plan, { opts, env, platform, revision });
  return plan;
}

/** CA-Zertifikate für den Build: `--ca-cert` oder `NODE_EXTRA_CA_CERTS` (TLS-Proxy wie auf dem Host). */
function caCertFor(plan, env) {
  const given = plan.settings.caCert;
  if (given !== undefined) {
    const file = resolve(given);
    if (!existsSync(file)) throw new SetupError(`--ca-cert ${given}: file not found.`);
    return file;
  }
  const extra = env.NODE_EXTRA_CA_CERTS;
  if (extra !== undefined && extra !== '' && existsSync(extra)) {
    plan.notes.push(`The image build trusts the CA certificates from NODE_EXTRA_CA_CERTS (${extra}) as a build secret (not stored in the image).`);
    return extra;
  }
  return undefined;
}

function runtimeInfoOf(runtime, image) {
  return `${runtime}, image ${image}`;
}

/** Docker oder Podman: Image bauen, Wrapper, Token, Konfiguration, doctor im Container. */
function planContainer(plan, { opts, env, platform, revision }) {
  const engine = plan.choice.engine;
  const tags = imageTags(plan.version);
  let gpu;
  if (plan.settings.gpu) {
    const g = detectGpu(env, engine);
    if (!g.usable) throw new SetupError(`--gpu: ${g.reason}. Run the setup without --gpu to use the CPU.`);
    gpu = g.mode;
    plan.notes.push(`GPU: ${g.reason}; the wrapper passes the NVIDIA GPU into the container. OPENVIDEO_BROWSER_GPU=1 additionally renders WebGL/WebGPU on it (not bit-identical).`);
  }
  if (opts.skipBuild) {
    const exists = probe(engine.path, ['image', 'inspect', tags.versioned], { env });
    if (!exists.ok) throw new SetupError(`--skip-build: the image ${tags.versioned} does not exist yet. Run the setup without --skip-build.`);
  } else {
    const b = buildCommand({ builder: engine.name, builderPath: engine.path, root: plan.root, version: plan.version, revision, withBlender: plan.settings.withBlender, caCert: caCertFor(plan, env) });
    plan.actions.push({ kind: 'run', name: 'build-image', ...b, cwd: plan.root });
  }
  addToken(plan, plan.paths.envFile);
  const runtimeInfo = runtimeInfoOf(engine.name, tags.versioned);
  addWrappers(plan, platform, {
    posix: () => containerWrapper({ engine: engine.name, enginePath: engine.path, image: tags.versioned, envFile: plan.paths.envFile, rootless: engine.rootless === true, gpu, runtimeInfo, pollMs: platform === 'darwin' ? '1000' : undefined }),
    windows: () => powershellWrapper({ engine: engine.name, enginePath: engine.path, image: tags.versioned, envFile: plan.paths.envFile, runtimeInfo }),
  });
  plan.config = { runtime: engine.name, engine: engine.name, image: tags.versioned, rootless: engine.rootless === true, envFile: plan.paths.envFile };
  plan.summary = { image: `${tags.versioned} (also ${tags.latest})`, builder: `${engine.name} build` };
}

/** Kubernetes: Image mit einem Builder bauen, in den Cluster bringen, Overlay anwenden, Wrapper. */
function planKubernetes(plan, { opts, env, platform, k8sSaved, keep, revision }) {
  if (platform === 'win32') throw new SetupError('Runtime kubernetes needs a POSIX shell for the openvideo wrapper (Linux, macOS, WSL). On Windows use --runtime docker or podman, or run the setup inside WSL.');
  const k = plan.choice.kubernetes;
  const builder = { ...k.builder };
  const namespace = opts.namespace ?? (keep ? k8sSaved.namespace : undefined) ?? 'openvideo-local';
  const registry = opts.registry ?? (keep ? k8sSaved.registry : undefined);
  const wantedCluster = opts.cluster ?? (registry !== undefined ? 'registry' : keep ? k8sSaved.cluster : undefined);
  const cluster = detectCluster(env, k.path, k.context, wantedCluster);
  if (cluster.type === 'rancher-desktop' && builder.name === 'nerdctl') builder.namespace = 'k8s.io';
  if (plan.settings.gpu) {
    const gpus = probe(k.path, ['--context', k.context, 'get', 'nodes', '-o', 'jsonpath={.items[*].status.allocatable.nvidia\\.com/gpu}', '--request-timeout=5s'], { env });
    if (!gpus.ok || gpus.stdout.trim() === '' || gpus.stdout.trim().split(/\s+/u).every((n) => n === '0')) throw new SetupError('--gpu: no node of the cluster offers nvidia.com/gpu (NVIDIA GPU Operator or device plugin missing). Run the setup without --gpu.');
  }
  const tags = imageTags(plan.version);
  const uniqueTag = `${plan.version}-${IMAGE_ID}`;
  const local = `${clusterImageName(builder.name)}:${uniqueTag}`;
  const overlayDir = plan.paths.kubernetes;
  const isRoot = typeof process.getuid === 'function' && process.getuid() === 0;
  const load = loadImageSteps({ cluster, builder, image: local, archive: archivePath(overlayDir), registry, env, which, isRoot });
  if (load.error !== undefined) throw new SetupError(load.error);
  const clusterImage = load.image ?? local;
  const [imageName, imageTag] = splitImage(clusterImage);
  if (opts.skipBuild) {
    const exists = probe(builder.path, ['image', 'inspect', tags.versioned], { env });
    if (!exists.ok) throw new SetupError(`--skip-build: the image ${tags.versioned} does not exist yet. Run the setup without --skip-build.`);
  } else {
    const b = buildCommand({ builder: builder.name, builderPath: builder.path, root: plan.root, version: plan.version, revision, withBlender: plan.settings.withBlender, caCert: caCertFor(plan, env), ...(builder.namespace !== undefined ? { namespace: builder.namespace } : {}) });
    plan.actions.push({ kind: 'run', name: 'build-image', ...b, cwd: plan.root });
  }
  plan.actions.push({ kind: 'capture', name: 'image-id', ...imageIdCommand({ builder: builder.name, builderPath: builder.path, image: tags.versioned, ...(builder.namespace !== undefined ? { namespace: builder.namespace } : {}) }) });
  plan.actions.push({ kind: 'run', name: 'tag-image', ...tagCommand({ builder: builder.name, builderPath: builder.path, from: tags.versioned, to: local, ...(builder.namespace !== undefined ? { namespace: builder.namespace } : {}) }) });
  plan.actions.push({ kind: 'mkdir', path: overlayDir });
  for (const step of load.steps) plan.actions.push({ kind: 'run', ...step });
  const newToken = addToken(plan, plan.paths.envFile);
  plan.actions.push({ kind: 'write', path: join(overlayDir, 'api.env'), content: '@TOKEN_FILE@', private: true, secret: true });
  plan.actions.push({ kind: 'write', path: join(overlayDir, 'namespace.yaml'), content: namespaceManifest(namespace) });
  plan.actions.push({ kind: 'write', path: join(overlayDir, 'kustomization.yaml'), content: kustomization({ overlayDir, devOverlay: join(plan.root, 'deploy', 'k8s', 'overlays', 'dev'), namespace, imageName, imageTag, gpu: plan.settings.gpu }) });
  for (const step of deploySteps({ kubectl: k.path, context: k.context, namespace, overlayDir, newToken })) plan.actions.push({ kind: 'run', ...step });
  if (load.steps.some((s) => s.name === 'save-image')) plan.actions.push({ kind: 'remove', path: archivePath(overlayDir), always: true });
  addWrappers(plan, platform, { posix: () => kubernetesWrapper({ kubectlPath: k.path, context: k.context, namespace, envFile: plan.paths.envFile }) });
  plan.config = { runtime: 'kubernetes', image: clusterImage, envFile: plan.paths.envFile, kubernetes: { context: k.context, namespace, cluster: cluster.type, builder: builder.name, ...(registry !== undefined ? { registry } : {}), overlay: overlayDir } };
  plan.summary = { image: `${clusterImage} (built as ${tags.versioned})`, builder: `${builder.name} build`, cluster: `${cluster.type ?? 'unknown'} (${cluster.reason})`, namespace, context: k.context };
  plan.notes.push(`Kubernetes: stack deploy/k8s/overlays/dev in namespace ${namespace} (context ${k.context}); files for create/render are copied into the pod and results back into the current folder.`);
}

function splitImage(ref) {
  const at = ref.lastIndexOf(':');
  return at > ref.lastIndexOf('/') ? [ref.slice(0, at), ref.slice(at + 1)] : [ref, 'latest'];
}

/** Native: wie bisher (npm ci, build, Chromium, npm install -g). Ein früherer Wrapper wird entfernt. */
function planNative(plan, { opts, env, platform }) {
  const problems = nativeProblems(env, platform);
  plan.problems = problems;
  if (plan.choice.fallback === true) {
    plan.notes.push('NOTE: No container runtime (Docker, Podman, Kubernetes) is usable, so OpenVideo is installed natively on this host. Install Docker or Podman and run `npm run setup -- --runtime auto` to switch.');
  }
  for (const step of nativeSteps(plan.root, opts, platform)) plan.actions.push({ kind: 'run', ...step, cwd: plan.root });
  for (const name of ['openvideo', 'openvideo.cmd', 'openvideo.ps1']) {
    const file = join(plan.settings.binDir, name);
    if (existsSync(file) && readFileSync(file, 'utf8').includes(WRAPPER_MARKER)) plan.actions.push({ kind: 'remove', path: file });
  }
  plan.config = { runtime: 'native' };
  plan.summary = { command: opts.noLink ? `node ${join(plan.root, 'packages', 'cli', 'dist', 'bin.js')}` : 'openvideo (npm install -g ./packages/cli)' };
}

/** Token-Datei anlegen oder beibehalten; liefert `true`, wenn ein neues Token entsteht. */
function addToken(plan, envFile) {
  const existing = readToken(envFile);
  plan.tokenContent = envFileContent(existing);
  plan.actions.push({ kind: 'write', path: envFile, content: plan.tokenContent, private: true, secret: true });
  return existing === undefined;
}

function addWrappers(plan, platform, make) {
  const dir = plan.settings.binDir;
  const files = platform === 'win32' ? [{ name: 'openvideo.ps1', content: make.windows?.() }, { name: 'openvideo.cmd', content: cmdWrapper() }] : [{ name: 'openvideo', content: make.posix() }];
  for (const f of files) {
    if (f.content === undefined) continue;
    const path = join(dir, f.name);
    if (existsSync(path) && !readFileSync(path, 'utf8').includes(WRAPPER_MARKER)) {
      throw new SetupError(`${path} exists and was not created by npm run setup. Remove it or choose another folder with --bin-dir <dir>.`);
    }
    plan.actions.push({ kind: 'write', path, content: f.content, mode: 0o755, wrapper: true });
  }
  plan.wrapper = join(dir, platform === 'win32' ? 'openvideo.cmd' : 'openvideo');
  if (platform !== 'win32') plan.actions.push({ kind: 'run', name: 'doctor', cmd: plan.wrapper, argv: ['doctor'], optional: true, cwd: tmpdir() });
}

function detectionText(choice) {
  return choice.candidates.map((c) => `  ${c.usable ? '✓' : '✗'} ${c.name.padEnd(10)} ${c.reason}`).join('\n');
}

/** Ausgabe von `--dry-run`. Token-Dateien erscheinen nur als Pfad. */
function describe(plan) {
  return {
    root: plan.root,
    configDir: plan.paths.dir,
    runtime: { name: plan.choice.runtime, reason: plan.choice.reason, source: plan.choice.source, fallback: plan.choice.fallback === true },
    detection: plan.choice.candidates.map((c) => ({ name: c.name, usable: c.usable, reason: c.reason })),
    ...(plan.problems !== undefined ? { problems: plan.problems } : {}),
    summary: plan.summary,
    steps: plan.actions.filter((a) => a.kind === 'run' || a.kind === 'capture').map((a) => ({ name: a.name, command: commandLine(a.cmd, a.argv), optional: a.optional === true, ...(a.env !== undefined && Object.keys(a.env).length > 0 ? { env: a.env } : {}) })),
    files: plan.actions.filter((a) => a.kind === 'write').map((a) => ({ path: a.path, mode: a.private === true ? '0600' : a.mode !== undefined ? `0${a.mode.toString(8)}` : '0644', ...(a.secret === true ? { content: '(API token, not shown)' } : { content: a.content }) })),
    removes: plan.actions.filter((a) => a.kind === 'remove').map((a) => a.path),
    config: { path: plan.paths.runtime, content: configContent(plan) },
    wrapper: plan.wrapper,
    notes: plan.notes,
  };
}

function configContent(plan) {
  return {
    schema: 1,
    ...plan.config,
    reason: plan.choice.reason,
    source: plan.choice.source,
    repo: plan.root,
    version: plan.version,
    binDir: plan.settings.binDir,
    ...(plan.wrapper !== undefined ? { wrapper: plan.wrapper } : {}),
    withBlender: plan.settings.withBlender,
    gpu: plan.settings.gpu,
    ...(plan.settings.caCert !== undefined ? { caCert: plan.settings.caCert } : {}),
  };
}

function replaceId(value, id) {
  return typeof value === 'string' ? value.replaceAll(IMAGE_ID, id) : value;
}

/** Führt den Plan aus und gibt Fortschritt aus. */
function execute(plan, { env, out, err, platform }) {
  out(`Runtime: ${plan.choice.runtime} – ${plan.choice.reason}\n${detectionText(plan.choice)}\n`);
  for (const note of plan.notes) out(`${note}\n`);
  if (plan.problems?.node !== undefined) throw new SetupError(plan.problems.node);
  if (plan.problems?.ffmpeg !== undefined) err(`Warning: ${plan.problems.ffmpeg} Rendering videos needs it; the build continues.\n`);
  let id = IMAGE_ID;
  let linked = false;
  let doctorOk;
  ensurePrivateDir(plan.paths.dir);
  const removeAlways = plan.actions.filter((a) => a.kind === 'remove' && a.always === true);
  try {
    for (const action of plan.actions) {
      if (action.kind === 'mkdir') {
        ensurePrivateDir(action.path);
        continue;
      }
      if (action.kind === 'write') {
        mkdirSync(dirname(action.path), { recursive: true });
        const content = action.content === '@TOKEN_FILE@' ? plan.tokenContent : replaceId(action.content, id);
        if (action.private === true) writePrivate(action.path, content);
        else {
          writeFileSync(action.path, content, { mode: action.mode ?? 0o644 });
          chmodSync(action.path, action.mode ?? 0o644);
        }
        if (action.wrapper === true) out(`\n==> wrapper: ${action.path}\n`);
        continue;
      }
      if (action.kind === 'remove') {
        if (action.always !== true) {
          rmSync(action.path, { force: true });
          out(`Removed the old wrapper ${action.path}.\n`);
        }
        continue;
      }
      const argv = action.argv.map((a) => replaceId(a, id));
      if (action.kind === 'capture') {
        const r = probe(action.cmd, argv, { env, timeoutMs: 60_000 });
        const m = /(?:sha256:)?([0-9a-f]{12})/u.exec(r.stdout);
        if (!r.ok || m?.[1] === undefined) throw new SetupError(`Could not read the image ID (${commandLine(action.cmd, argv)}): ${firstLine(r.stderr) || r.stdout}`);
        id = m[1];
        continue;
      }
      out(`\n==> ${action.name}: ${commandLine(action.cmd, argv)}\n`);
      if (action.sudo === true) out('(needs sudo: the image is imported into the containerd of k3s)\n');
      const r = spawnSync(action.cmd, argv, { cwd: action.cwd, stdio: 'inherit', env: { ...env, ...(action.env ?? {}) }, shell: platform === 'win32' && /\.(cmd|bat)$/iu.test(action.cmd) });
      if (r.status === 0) {
        if (action.name === 'link') linked = true;
        if (action.name === 'doctor') doctorOk = true;
        continue;
      }
      if (action.name === 'doctor') doctorOk = false;
      if (action.name === 'link') {
        out('Linking `openvideo` globally failed (often missing write access to the global npm folder). Use an alias instead:\n');
        continue;
      }
      if (action.optional === true) continue;
      throw new SetupError(`Step "${action.name}" failed${r.error !== undefined ? ` (${r.error.message})` : ''}. Fix the error above and run \`npm run setup\` again.${plan.choice.runtime === 'native' ? ' Finished steps can be skipped with --skip-install/--skip-build/--skip-browser.' : ''}`);
    }
  } finally {
    for (const a of removeAlways) rmSync(a.path, { force: true });
  }
  const config = configContent(plan);
  if (config.image !== undefined) config.image = replaceId(config.image, id);
  writePrivate(plan.paths.runtime, `${JSON.stringify(config, null, 2)}\n`);
  finish(plan, { env, out, platform, linked, doctorOk });
  return 0;
}

function finish(plan, { env, out, platform, linked, doctorOk }) {
  out(`\nOpenVideo is set up (runtime ${plan.choice.runtime}). Settings: ${plan.paths.runtime}\n`);
  if (doctorOk === false) out('Note: `openvideo doctor` reported problems (see above); the fix is next to each line.\n');
  if (plan.choice.runtime === 'native') {
    if (linked) out('The command `openvideo` is on your PATH (try: openvideo --help).\n');
    else {
      const bin = join(plan.root, 'packages', 'cli', 'dist', 'bin.js');
      out(`Make the command available with:\n  ${platform === 'win32' ? `doskey openvideo=node "${bin}" $*` : `alias openvideo="node ${bin}"`}\n`);
    }
  } else {
    out(`The command \`openvideo\` runs OpenVideo in ${plan.choice.runtime}: ${plan.wrapper}\n`);
    const sep = platform === 'win32' ? ';' : ':';
    const onPath = (env.PATH ?? env.Path ?? '').split(sep).some((d) => d !== '' && resolve(d) === plan.settings.binDir);
    if (!onPath) out(`${plan.settings.binDir} is not on your PATH. Add it, for example:\n  ${platform === 'win32' ? `setx PATH "%PATH%;${plan.settings.binDir}"` : `echo 'export PATH="${plan.settings.binDir}:$PATH"' >> ~/.profile`}\n`);
    const first = platform === 'win32' ? undefined : which('openvideo', env);
    if (first !== undefined && resolve(first) !== resolve(plan.wrapper)) {
      out(`Warning: another openvideo comes first on your PATH: ${first}. Remove it (for example npm uninstall -g @agentic-video/cli) or put ${plan.settings.binDir} first.\n`);
    }
    out(`MCP (Claude Code): claude mcp add openvideo -- ${plan.wrapper} mcp --workspace ${join(env.HOME ?? homedir(), 'openvideo-projects')}\n`);
  }
  out('Next: openvideo create hello && cd hello && openvideo render-frame --frame 1s --out out/frame.png\n');
}
