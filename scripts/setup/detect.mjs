// Erkennung der Laufzeit (ADR 0029): Docker, Podman, Kubernetes – nur, was wirklich nutzbar ist.
import { existsSync } from 'node:fs';
import { firstLine, probe, which } from './util.mjs';

/**
 * Docker: Programm vorhanden und Daemon erreichbar (`docker info`). Ein `docker`, das in Wahrheit Podman
 * ist (Paket podman-docker), zählt nicht als Docker; die Podman-Erkennung übernimmt es.
 */
export function detectDocker(env) {
  const path = which('docker', env);
  if (path === undefined) return { name: 'docker', usable: false, reason: 'docker is not installed' };
  const version = probe(path, ['--version'], { env });
  if (/podman/iu.test(version.stdout)) return { name: 'docker', usable: false, path, reason: 'docker is an alias for podman' };
  const info = probe(path, ['info', '--format', '{{.ServerVersion}}'], { env, timeoutMs: 20_000 });
  if (!info.ok || info.stdout === '') return { name: 'docker', usable: false, path, reason: `the Docker daemon is not reachable (${firstLine(info.stderr) || 'docker info failed'})` };
  return { name: 'docker', usable: true, path, version: info.stdout, reason: `Docker ${info.stdout} is running` };
}

/** Podman: `podman info` funktioniert; merkt sich, ob Podman rootless läuft (Wrapper: `--userns=keep-id`). */
export function detectPodman(env) {
  const path = which('podman', env);
  if (path === undefined) return { name: 'podman', usable: false, reason: 'podman is not installed' };
  const info = probe(path, ['info', '--format', '{{.Host.Security.Rootless}} {{.Version.Version}}'], { env, timeoutMs: 30_000 });
  if (!info.ok) return { name: 'podman', usable: false, path, reason: `podman info failed (${firstLine(info.stderr) || 'no output'}); on macOS/Windows start the machine: podman machine start` };
  const [rootless, version] = info.stdout.split(/\s+/u);
  return { name: 'podman', usable: true, path, rootless: rootless === 'true', version, reason: `Podman ${version ?? ''} works${rootless === 'true' ? ' (rootless)' : ''}`.replace('  ', ' ') };
}

/** Image-Builder für Kubernetes: `--builder` oder der erste nutzbare aus docker, podman, nerdctl, buildah. */
export function detectBuilder(env, wanted, known = {}) {
  const checks = {
    docker: () => known.docker ?? detectDocker(env),
    podman: () => known.podman ?? detectPodman(env),
    nerdctl: () => {
      const path = which('nerdctl', env);
      if (path === undefined) return { name: 'nerdctl', usable: false, reason: 'nerdctl is not installed' };
      const r = probe(path, ['info'], { env, timeoutMs: 20_000 });
      return r.ok ? { name: 'nerdctl', usable: true, path, reason: 'nerdctl works' } : { name: 'nerdctl', usable: false, path, reason: `nerdctl info failed (${firstLine(r.stderr)})` };
    },
    buildah: () => {
      const path = which('buildah', env);
      if (path === undefined) return { name: 'buildah', usable: false, reason: 'buildah is not installed' };
      const r = probe(path, ['version'], { env });
      return r.ok ? { name: 'buildah', usable: true, path, reason: 'buildah works' } : { name: 'buildah', usable: false, path, reason: `buildah version failed (${firstLine(r.stderr)})` };
    },
  };
  const order = wanted !== undefined ? [wanted] : ['docker', 'podman', 'nerdctl', 'buildah'];
  const tried = [];
  for (const name of order) {
    const r = checks[name]();
    tried.push(r);
    if (r.usable) return { builder: r, tried };
  }
  return { builder: undefined, tried };
}

/**
 * Kubernetes: `kubectl` vorhanden, Kontext gesetzt und der API-Server antwortet (kurzer Timeout).
 */
export function detectKubernetes(env, context) {
  const path = which('kubectl', env);
  if (path === undefined) return { name: 'kubernetes', usable: false, reason: 'kubectl is not installed' };
  const ctx = context ?? probe(path, ['config', 'current-context'], { env }).stdout;
  if (ctx === undefined || ctx === '') return { name: 'kubernetes', usable: false, path, reason: 'kubectl has no current context' };
  const version = probe(path, ['--context', ctx, 'version', '--request-timeout=5s', '-o', 'json'], { env, timeoutMs: 15_000 });
  if (!version.ok) return { name: 'kubernetes', usable: false, path, context: ctx, reason: `the cluster of context ${ctx} does not answer (${firstLine(version.stderr) || 'kubectl version failed'})` };
  let server = '';
  try {
    server = JSON.parse(version.stdout).serverVersion?.gitVersion ?? '';
  } catch (error) {
    if (!(error instanceof SyntaxError)) throw error;
  }
  return { name: 'kubernetes', usable: true, path, context: ctx, server, reason: `context ${ctx} answers${server !== '' ? ` (Kubernetes ${server})` : ''}` };
}

/**
 * Wie kommt das lokal gebaute Image in den Cluster? Aus `--cluster`/`--registry` oder aus dem Kontextnamen
 * (kind-*, k3d-*, minikube, docker-desktop, rancher-desktop) bzw. der Kubelet-Version (+k3s).
 */
export function detectCluster(env, kubectl, context, wanted) {
  if (wanted !== undefined) return { type: wanted, name: clusterName(wanted, context), reason: 'given with --cluster/--registry' };
  if (context.startsWith('kind-')) return { type: 'kind', name: context.slice('kind-'.length), reason: `context ${context}` };
  if (context.startsWith('k3d-')) return { type: 'k3d', name: context.slice('k3d-'.length), reason: `context ${context}` };
  if (context === 'docker-desktop') return { type: 'docker-desktop', name: context, reason: `context ${context}` };
  if (context === 'rancher-desktop') return { type: 'rancher-desktop', name: context, reason: `context ${context}` };
  const minikube = which('minikube', env);
  if (context === 'minikube' || (minikube !== undefined && probe(minikube, ['-p', context, 'status', '--format', '{{.Host}}'], { env }).ok)) return { type: 'minikube', name: context, reason: `minikube profile ${context}` };
  const kubelet = probe(kubectl, ['--context', context, 'get', 'nodes', '-o', 'jsonpath={.items[*].status.nodeInfo.kubeletVersion}', '--request-timeout=5s'], { env });
  if (kubelet.ok && kubelet.stdout.includes('+k3s')) return { type: 'k3s', name: context, reason: `nodes run k3s (${kubelet.stdout.split(' ')[0]})` };
  return { type: undefined, name: context, reason: `context ${context} is no local cluster that OpenVideo can load images into` };
}

function clusterName(type, context) {
  if (type === 'kind' && context.startsWith('kind-')) return context.slice(5);
  if (type === 'k3d' && context.startsWith('k3d-')) return context.slice(4);
  return context;
}

/**
 * NVIDIA-GPU für Container: Treiber (`nvidia-smi -L`) und Container Toolkit (Docker-Runtime `nvidia` oder
 * eine CDI-Spezifikation).
 */
export function detectGpu(env, engine) {
  const smi = which('nvidia-smi', env);
  if (smi === undefined || !probe(smi, ['-L'], { env }).ok) return { usable: false, reason: 'no NVIDIA GPU found (nvidia-smi -L fails)' };
  const cdi = ['/etc/cdi/nvidia.yaml', '/var/run/cdi/nvidia.yaml', '/etc/cdi/nvidia.json', '/var/run/cdi/nvidia.json'].some((f) => existsSync(f));
  if (engine.name === 'docker') {
    const runtimes = probe(engine.path, ['info', '--format', '{{json .Runtimes}}'], { env });
    if (runtimes.ok && runtimes.stdout.includes('nvidia')) return { usable: true, mode: 'docker', reason: 'NVIDIA Container Toolkit (docker runtime nvidia)' };
    if (cdi) return { usable: true, mode: 'cdi', reason: 'NVIDIA CDI specification' };
    return { usable: false, reason: 'the NVIDIA Container Toolkit is not set up for Docker (nvidia-ctk runtime configure --runtime=docker)' };
  }
  if (cdi) return { usable: true, mode: 'cdi', reason: 'NVIDIA CDI specification' };
  return { usable: false, reason: 'no NVIDIA CDI specification for Podman (sudo nvidia-ctk cdi generate --output=/etc/cdi/nvidia.yaml)' };
}

/**
 * Wählt die Laufzeit: ausdrückliche Angabe (Option, Umgebung, gespeicherte Wahl) vor `auto`.
 * `auto` prüft Docker, Podman, Kubernetes; native nur als letzter Rückfall.
 * Liefert `{ runtime, reason, source, candidates, engine?, kubernetes?, error? }`.
 */
export function chooseRuntime({ env, wanted, source, kubeContext, builder }) {
  const candidates = [];
  const known = {};
  const tryDocker = () => {
    known.docker = detectDocker(env);
    candidates.push(known.docker);
    return known.docker;
  };
  const tryPodman = () => {
    known.podman = detectPodman(env);
    candidates.push(known.podman);
    return known.podman;
  };
  const tryKubernetes = () => {
    const k = detectKubernetes(env, kubeContext);
    if (k.usable) {
      const b = detectBuilder(env, builder, known);
      if (b.builder === undefined) {
        const r = { ...k, usable: false, reason: `${k.reason}, but no image builder works (${b.tried.map((t) => `${t.name}: ${t.reason}`).join('; ')})` };
        candidates.push(r);
        return r;
      }
      const r = { ...k, builder: b.builder };
      candidates.push(r);
      return r;
    }
    candidates.push(k);
    return k;
  };
  if (wanted !== undefined && wanted !== 'auto') {
    if (wanted === 'native') return { runtime: 'native', reason: explicitReason(source), source, candidates };
    const r = wanted === 'docker' ? tryDocker() : wanted === 'podman' ? tryPodman() : tryKubernetes();
    if (!r.usable) return { runtime: wanted, source, candidates, error: `Runtime ${wanted} (${explicitReason(source)}) is not usable: ${r.reason}.` };
    return { runtime: wanted, reason: `${explicitReason(source)}; ${r.reason}`, source, candidates, ...(wanted === 'kubernetes' ? { kubernetes: r } : { engine: r }) };
  }
  const docker = tryDocker();
  if (docker.usable) return { runtime: 'docker', reason: `auto: ${docker.reason}`, source: 'auto', candidates, engine: docker };
  const podman = tryPodman();
  if (podman.usable) return { runtime: 'podman', reason: `auto: ${podman.reason}`, source: 'auto', candidates, engine: podman };
  const k8s = tryKubernetes();
  if (k8s.usable) return { runtime: 'kubernetes', reason: `auto: ${k8s.reason}`, source: 'auto', candidates, kubernetes: k8s };
  return { runtime: 'native', reason: 'auto: no container runtime is usable, falling back to native (Node.js on this host)', source: 'auto', candidates, fallback: true };
}

function explicitReason(source) {
  if (source === 'flag') return 'chosen with --runtime';
  if (source === 'env') return 'chosen with OPENVIDEO_RUNTIME';
  if (source === 'config') return 'saved by the last setup';
  return 'chosen';
}
