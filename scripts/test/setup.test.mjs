// SETUP.md / ADR 0029: `npm run setup` wählt die Laufzeit (docker, podman, kubernetes, native), baut das
// Image lokal mit der jeweiligen Technik und installiert den Wrapper `openvideo`. Die Tests laufen mit
// Stub-Programmen in einem eigenen PATH (setup-fakes.mjs) und prüfen Plan (--dry-run) und echte Ausführung.
import { readFileSync, statSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { WORKING, fakeEnv, runNode } from './setup-fakes.mjs';
import { parseOptions } from '../setup/options.mjs';
import { buildCommand, clusterImageName } from '../setup/image.mjs';
import { kustomization } from '../setup/kubernetes.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const SCRIPT = join(ROOT, 'scripts', 'setup.mjs');

function plan(f, ...extra) {
  const r = runNode(SCRIPT, ['--dry-run', ...extra], f.env);
  expect(r.stderr).not.toMatch(/Error|at /u);
  expect(r.status).toBe(0);
  return JSON.parse(r.stdout);
}

const names = (p) => p.steps.map((s) => s.name);
const step = (p, name) => p.steps.find((s) => s.name === name);

describe('scripts/setup.mjs: Laufzeit-Erkennung', () => {
  it('auto nimmt Docker, wenn der Daemon antwortet, und baut das Ziel local mit docker build', () => {
    const f = fakeEnv(['docker', 'podman', 'kubectl'], WORKING);
    const p = plan(f);
    expect(p.runtime).toMatchObject({ name: 'docker', source: 'auto', fallback: false });
    expect(p.runtime.reason).toContain('Docker 29.3.1 is running');
    expect(names(p)).toEqual(['build-image', 'doctor']);
    const build = step(p, 'build-image');
    expect(build.command).toContain('docker build --file');
    expect(build.command).toContain('--target local --platform linux/amd64 --tag openvideo-local:0.1.0 --tag openvideo-local:latest');
    expect(build.env).toEqual({ DOCKER_BUILDKIT: '1' });
    expect(p.detection.map((d) => d.name)).toEqual(['docker']);
    expect(p.files.map((x) => x.path)).toEqual([join(f.env.OPENVIDEO_CONFIG_DIR, 'api.env'), join(f.home, '.local', 'bin', 'openvideo')]);
    expect(p.files[0]).toMatchObject({ mode: '0600', content: '(API token, not shown)' });
    expect(p.files[1].mode).toBe('0755');
    expect(p.files[1].content).toContain("OV_IMAGE='openvideo-local:0.1.0'");
    expect(p.config.content).toMatchObject({ runtime: 'docker', image: 'openvideo-local:0.1.0', source: 'auto' });
  });

  it('auto nimmt Podman, wenn Docker fehlt oder der Daemon nicht antwortet; rootless mit keep-id', () => {
    const f = fakeEnv(['docker', 'podman'], { ...WORKING, docker: { '--version': { stdout: 'Docker version 29' }, info: { status: 1, stderr: 'Cannot connect to the Docker daemon' } } });
    const p = plan(f);
    expect(p.runtime.name).toBe('podman');
    expect(p.detection).toEqual([
      { name: 'docker', usable: false, reason: 'the Docker daemon is not reachable (Cannot connect to the Docker daemon)' },
      { name: 'podman', usable: true, reason: 'Podman 5.4.2 works (rootless)' },
    ]);
    const build = step(p, 'build-image').command;
    expect(build).toMatch(/podman build --format docker --ignorefile \S+Dockerfile\.dockerignore --file/u);
    expect(p.files[1].content).toContain("OV_ROOTLESS='1'");
  });

  it('ein docker, das Podman ist (podman-docker), zählt nicht als Docker', () => {
    const f = fakeEnv(['docker', 'podman'], { ...WORKING, docker: { '--version': { stdout: 'podman version 5.4.2' } } });
    const p = plan(f);
    expect(p.detection[0]).toEqual({ name: 'docker', usable: false, reason: 'docker is an alias for podman' });
    expect(p.runtime.name).toBe('podman');
  });

  it('auto nimmt Kubernetes, wenn kein Docker/Podman läuft, der Cluster antwortet und ein Builder da ist', () => {
    const f = fakeEnv(['kubectl', 'buildah', 'kind'], { ...WORKING, buildah: { version: { stdout: 'buildah 1.39' } } });
    const p = plan(f);
    expect(p.runtime).toMatchObject({ name: 'kubernetes', source: 'auto' });
    expect(p.runtime.reason).toContain('context kind-dev answers (Kubernetes v1.33.1)');
    expect(names(p)).toEqual(['build-image', 'image-id', 'tag-image', 'save-image', 'load-image', 'apply', 'restart', 'rollout', 'doctor']);
    expect(step(p, 'build-image').command).toContain('buildah build --format docker --ignorefile');
    expect(step(p, 'save-image').command).toContain('buildah push localhost/openvideo-local:0.1.0-@IMAGE_ID@ docker-archive:');
    expect(step(p, 'load-image').command).toMatch(/kind load image-archive \S+openvideo-local\.tar --name dev$/u);
  });

  it('native nur als letzter Rückfall, mit deutlicher Meldung', () => {
    const f = fakeEnv([]);
    const p = plan(f);
    expect(p.runtime).toMatchObject({ name: 'native', source: 'auto', fallback: true });
    expect(p.detection.map((d) => `${d.name}: ${d.reason}`)).toEqual(['docker: docker is not installed', 'podman: podman is not installed', 'kubernetes: kubectl is not installed']);
    expect(p.notes.join('\n')).toContain('No container runtime (Docker, Podman, Kubernetes) is usable');
    expect(names(p)).toEqual(['install', 'build', 'browser', 'link', 'doctor']);
  });

  it('ausdrückliche Angabe schlägt auto: --runtime native trotz Docker, OPENVIDEO_RUNTIME ebenso', () => {
    const f = fakeEnv(['docker'], WORKING);
    const p = plan(f, '--runtime', 'native');
    expect(p.runtime).toMatchObject({ name: 'native', source: 'flag', reason: 'chosen with --runtime', fallback: false });
    expect(p.detection).toEqual([]);
    const e = plan({ ...f, env: { ...f.env, OPENVIDEO_RUNTIME: 'native' } });
    expect(e.runtime).toMatchObject({ name: 'native', source: 'env' });
    const flagWins = plan({ ...f, env: { ...f.env, OPENVIDEO_RUNTIME: 'native' } }, '--runtime=docker');
    expect(flagWins.runtime).toMatchObject({ name: 'docker', source: 'flag' });
  });

  it('eine ausdrücklich gewünschte, aber nicht verfügbare Laufzeit ist ein Fehler mit Erkennung und Ausweg', () => {
    const f = fakeEnv(['docker'], WORKING);
    const r = runNode(SCRIPT, ['--dry-run', '--runtime', 'podman'], f.env);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('Runtime podman (chosen with --runtime) is not usable: podman is not installed.');
    expect(r.stderr).toContain('--runtime auto');
  });

  it('native: Schritte wie bisher, Schalter wirken, --with-deps geht an Playwright', () => {
    const f = fakeEnv([]);
    const p = plan(f, '--runtime', 'native', '--skip-install', '--no-link', '--with-deps');
    expect(names(p)).toEqual(['build', 'browser', 'doctor']);
    expect(step(p, 'browser').command).toContain('--with-deps');
    expect(p.problems.node).toBeUndefined();
    const full = plan(f, '--runtime', 'native');
    expect(step(full, 'link').command).toContain('install -g ./packages/cli');
  });

  it('lehnt unbekannte Optionen und Werte mit Exit-Code 2 ab', () => {
    const f = fakeEnv([]);
    for (const args of [['--bogus'], ['--runtime', 'lxc'], ['--builder', 'kaniko'], ['--namespace', 'Bad_NS'], ['--runtime']]) {
      const r = runNode(SCRIPT, args, f.env);
      expect(r.status, args.join(' ')).toBe(2);
    }
    expect(runNode(SCRIPT, ['--bogus'], f.env).stderr).toContain('Unknown option --bogus');
    expect(parseOptions(['--registry=reg.example/ov'], {})).toMatchObject({ registry: 'reg.example/ov', cluster: 'registry' });
  });

  it('--help nennt alle Laufzeiten und Optionen', () => {
    const r = runNode(SCRIPT, ['--help'], fakeEnv([]).env);
    expect(r.status).toBe(0);
    for (const word of ['--runtime <auto|docker|podman|kubernetes|native>', '--bin-dir', '--with-blender', '--gpu', '--builder', '--registry', '--cluster', '--kube-context', '--namespace', '--ca-cert', '--dry-run']) expect(r.stdout).toContain(word);
  });
});

describe('scripts/setup.mjs: Ausführung mit Docker (Stub)', () => {
  it('baut, schreibt Token (0600), Wrapper (0755) und runtime.json; doctor läuft über den Wrapper', () => {
    const f = fakeEnv(['docker'], WORKING);
    const r = runNode(SCRIPT, [], f.env);
    expect(r.stderr).toBe('');
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('Runtime: docker – auto: Docker 29.3.1 is running');
    const cfgDir = f.env.OPENVIDEO_CONFIG_DIR;
    const envFile = join(cfgDir, 'api.env');
    expect(statSync(envFile).mode & 0o777).toBe(0o600);
    expect(statSync(join(cfgDir, 'runtime.json')).mode & 0o777).toBe(0o600);
    const token = /^OPENVIDEO_API_TOKEN=([A-Za-z0-9_-]{43})$/mu.exec(readFileSync(envFile, 'utf8'))?.[1];
    expect(token).toBeDefined();
    const wrapper = join(f.home, '.local', 'bin', 'openvideo');
    expect(statSync(wrapper).mode & 0o777).toBe(0o755);
    const calls = f.calls().filter((c) => c.name === 'docker' && (c.args[0] === 'build' || c.args[0] === 'run'));
    expect(calls.map((c) => c.args[0])).toEqual(['build', 'run']);
    expect(calls[0].env.DOCKER_BUILDKIT).toBe('1');
    expect(calls[1].args.slice(-2)).toEqual(['openvideo-local:0.1.0', 'doctor']);
    const cfg = JSON.parse(readFileSync(join(cfgDir, 'runtime.json'), 'utf8'));
    expect(cfg).toMatchObject({ schema: 1, runtime: 'docker', image: 'openvideo-local:0.1.0', wrapper, envFile });
    expect(r.stdout).toContain('is not on your PATH');
    expect(r.stdout).toContain(`claude mcp add openvideo -- ${wrapper} mcp --workspace`);

    // Aktualisieren: gespeicherte Laufzeit, gleiches Token, Image neu gebaut.
    const again = runNode(SCRIPT, [], f.env);
    expect(again.status).toBe(0);
    expect(again.stdout).toContain('Runtime: docker – saved by the last setup; Docker 29.3.1 is running');
    expect(readFileSync(envFile, 'utf8')).toContain(token);
    expect(f.calls().filter((c) => c.name === 'docker' && c.args[0] === 'build')).toHaveLength(2);
  });

  it('überschreibt keine fremde Datei im Bin-Ordner und entfernt den Wrapper beim Wechsel auf native', () => {
    const f = fakeEnv(['docker'], WORKING);
    const bin = join(f.dir, 'bin');
    mkdirSync(bin);
    writeFileSync(join(bin, 'openvideo'), '#!/bin/sh\necho mine\n');
    const r = runNode(SCRIPT, ['--bin-dir', bin], f.env);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('exists and was not created by npm run setup');
    const own = join(f.dir, 'bin2');
    expect(runNode(SCRIPT, ['--bin-dir', own], f.env).status).toBe(0);
    const native = plan(f, '--runtime', 'native', '--bin-dir', own);
    expect(native.removes).toEqual([join(own, 'openvideo')]);
  });

  it('--skip-build nutzt ein vorhandenes Image und bricht ohne Image klar ab', () => {
    const f = fakeEnv(['docker'], { docker: { ...WORKING.docker, 'image inspect openvideo-local:0.1.0': { status: 1 } } });
    const r = runNode(SCRIPT, ['--dry-run', '--skip-build'], f.env);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('--skip-build: the image openvideo-local:0.1.0 does not exist yet');
    f.setTable(WORKING);
    expect(names(plan(f, '--skip-build'))).toEqual(['doctor']);
  });

  it('--gpu nur, wenn GPU und Container Toolkit da sind', () => {
    const f = fakeEnv(['docker'], WORKING);
    const r = runNode(SCRIPT, ['--dry-run', '--gpu'], f.env);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('--gpu: no NVIDIA GPU found');
    const g = fakeEnv(['docker', 'nvidia-smi'], { ...WORKING, docker: { ...WORKING.docker, 'info --format {{json .Runtimes}}': { stdout: '{"nvidia":{},"runc":{}}' } } });
    const p = plan(g, '--gpu');
    expect(p.files[1].content).toContain('--gpus all -e NVIDIA_DRIVER_CAPABILITIES=compute,utility,video,graphics');
  });

  it('--with-blender baut local auf dem Ziel blender; --ca-cert geht als Build-Secret', () => {
    const f = fakeEnv(['docker'], WORKING);
    const ca = join(f.dir, 'ca.pem');
    writeFileSync(ca, 'cert');
    const p = plan(f, '--with-blender', '--ca-cert', ca);
    expect(step(p, 'build-image').command).toContain('--build-arg LOCAL_BASE=blender');
    expect(step(p, 'build-image').command).toContain(`--secret id=ca,src=${ca}`);
    const missing = runNode(SCRIPT, ['--dry-run', '--ca-cert', join(f.dir, 'nope.pem')], f.env);
    expect(missing.status).toBe(1);
  });
});

describe('scripts/setup.mjs: Kubernetes-Distributionen (Stub)', () => {
  const k8s = (context, extra = {}) => ({ ...WORKING, kubectl: { ...WORKING.kubectl, 'config current-context': { stdout: context } }, ...extra });

  it('kind + docker: kind load docker-image', () => {
    const p = plan(fakeEnv(['docker', 'kubectl', 'kind'], k8s('kind-ov')), '--runtime', 'kubernetes');
    expect(step(p, 'load-image').command).toMatch(/kind load docker-image openvideo-local:0\.1\.0-@IMAGE_ID@ --name ov$/u);
    expect(p.summary.cluster).toContain('kind');
  });

  it('minikube + podman: Archiv speichern und minikube image load', () => {
    const p = plan(fakeEnv(['podman', 'kubectl', 'minikube'], k8s('minikube')), '--runtime', 'kubernetes');
    expect(step(p, 'save-image').command).toMatch(/podman save --format docker-archive --output \S+ localhost\/openvideo-local:0\.1\.0-@IMAGE_ID@/u);
    expect(step(p, 'load-image').command).toMatch(/minikube -p minikube image load \S+openvideo-local\.tar$/u);
  });

  it('k3d + docker: k3d image import', () => {
    const p = plan(fakeEnv(['docker', 'kubectl', 'k3d'], k8s('k3d-work')), '--runtime', 'kubernetes');
    expect(step(p, 'load-image').command).toMatch(/k3d image import openvideo-local:0\.1\.0-@IMAGE_ID@ --cluster work$/u);
  });

  it('k3s (Kubelet +k3s): Archiv in containerd importieren', () => {
    const f = fakeEnv(['docker', 'kubectl', 'k3s'], k8s('default', { kubectl: { ...WORKING.kubectl, 'config current-context': { stdout: 'default' }, '--context default get nodes': { stdout: 'v1.33.1+k3s1' } } }));
    const p = plan(f, '--runtime', 'kubernetes');
    expect(p.summary.cluster).toContain('k3s');
    expect(step(p, 'load-image').command).toMatch(/k3s ctr images import \S+openvideo-local\.tar$/u);
  });

  it('Docker Desktop: das Image der Docker-Engine direkt, kein Laden', () => {
    const p = plan(fakeEnv(['docker', 'kubectl'], k8s('docker-desktop')), '--runtime', 'kubernetes');
    expect(names(p)).toEqual(['build-image', 'image-id', 'tag-image', 'apply', 'restart', 'rollout', 'doctor']);
  });

  it('Rancher Desktop + nerdctl: Build direkt im Namespace k8s.io', () => {
    const f = fakeEnv(['kubectl', 'nerdctl'], k8s('rancher-desktop'));
    const p = plan(f, '--runtime', 'kubernetes');
    expect(step(p, 'build-image').command).toMatch(/nerdctl --namespace k8s\.io build --file/u);
    expect(names(p)).not.toContain('load-image');
  });

  it('fremder Cluster: ohne --registry klare Fehlermeldung mit Optionen, mit --registry push', () => {
    const f = fakeEnv(['docker', 'kubectl'], k8s('prod-eu', { kubectl: { ...WORKING.kubectl, 'config current-context': { stdout: 'prod-eu' }, '--context prod-eu get nodes': { stdout: 'v1.33.1' } } }));
    const r = runNode(SCRIPT, ['--dry-run', '--runtime', 'kubernetes'], f.env);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('Options: --registry <host/path>');
    const p = plan(f, '--runtime', 'kubernetes', '--registry', 'registry.example.com/team');
    expect(step(p, 'tag-registry').command).toContain('registry.example.com/team/openvideo-local:0.1.0-@IMAGE_ID@');
    expect(step(p, 'push-image').command).toContain('docker push registry.example.com/team/openvideo-local:0.1.0-@IMAGE_ID@');
    const kust = p.files.find((x) => x.path.endsWith('kustomization.yaml')).content;
    expect(kust).toContain('newName: registry.example.com/team/openvideo-local');
  });

  it('Kubernetes ohne nutzbaren Builder ist nicht nutzbar (auto fällt auf native zurück)', () => {
    const p = plan(fakeEnv(['kubectl'], k8s('kind-dev')));
    expect(p.runtime.name).toBe('native');
    expect(p.detection.find((d) => d.name === 'kubernetes').reason).toContain('but no image builder works');
  });

  it('echte Ausführung (kind, Stub): Overlay mit eindeutigem Image-Tag, Secret aus api.env, Namespace, Wrapper', () => {
    const f = fakeEnv(['docker', 'kubectl', 'kind'], k8s('kind-ov'));
    const r = runNode(SCRIPT, ['--runtime', 'kubernetes', '--namespace', 'ov-test'], f.env);
    expect(r.stderr).toBe('');
    expect(r.status).toBe(0);
    const dir = join(f.env.OPENVIDEO_CONFIG_DIR, 'kubernetes');
    const kust = readFileSync(join(dir, 'kustomization.yaml'), 'utf8');
    expect(kust).toContain('namespace: ov-test');
    expect(kust).toContain('newTag: 0.1.0-0123456789ab');
    expect(kust).toMatch(/- \.\.\/.*deploy\/k8s\/overlays\/dev/u);
    expect(readFileSync(join(dir, 'namespace.yaml'), 'utf8')).toContain('pod-security.kubernetes.io/enforce: restricted');
    expect(statSync(join(dir, 'api.env')).mode & 0o777).toBe(0o600);
    expect(readFileSync(join(dir, 'api.env'), 'utf8')).toBe(readFileSync(join(f.env.OPENVIDEO_CONFIG_DIR, 'api.env'), 'utf8'));
    const kubectl = f.calls().filter((c) => c.name === 'kubectl').map((c) => c.args.join(' '));
    expect(kubectl).toContain(`--context kind-ov apply -k ${dir}`);
    expect(kubectl).toContain('--context kind-ov -n ov-test rollout status deploy/openvideo --timeout=300s');
    expect(f.calls().find((c) => c.name === 'kind').args).toEqual(['load', 'docker-image', 'openvideo-local:0.1.0-0123456789ab', '--name', 'ov']);
    const cfg = JSON.parse(readFileSync(join(f.env.OPENVIDEO_CONFIG_DIR, 'runtime.json'), 'utf8'));
    expect(cfg).toMatchObject({ runtime: 'kubernetes', image: 'openvideo-local:0.1.0-0123456789ab', kubernetes: { context: 'kind-ov', namespace: 'ov-test', cluster: 'kind', builder: 'docker' } });
    // Update übernimmt Namespace und Kontext aus runtime.json.
    const again = plan(f);
    expect(again.runtime.source).toBe('config');
    expect(again.summary.namespace).toBe('ov-test');
    expect(names(again)).not.toContain('restart');
  });
});

describe('Bausteine', () => {
  it('Build-Befehle je Builder', () => {
    const base = { root: '/r', version: '1.2.3' };
    expect(buildCommand({ ...base, builder: 'docker', builderPath: 'docker' }).argv.slice(0, 3)).toEqual(['build', '--file', '/r/deploy/docker/Dockerfile']);
    expect(buildCommand({ ...base, builder: 'buildah', builderPath: 'buildah' }).argv.slice(0, 5)).toEqual(['build', '--format', 'docker', '--ignorefile', '/r/deploy/docker/Dockerfile.dockerignore']);
    expect(clusterImageName('podman')).toBe('localhost/openvideo-local');
    expect(clusterImageName('docker')).toBe('openvideo-local');
  });

  it('kustomization: GPU-Patch nur mit --gpu', () => {
    const k = (gpu) => kustomization({ overlayDir: '/c/kubernetes', devOverlay: '/src/deploy/k8s/overlays/dev', namespace: 'n', imageName: 'openvideo-local', imageTag: 't', gpu });
    expect(k(false)).not.toContain('nvidia.com');
    expect(k(true)).toContain('nvidia.com~1gpu');
    expect(k(false)).toContain('- ../../src/deploy/k8s/overlays/dev');
  });

  it('ist als npm run setup eingetragen, und SETUP.md nennt Laufzeiten und Schalter', () => {
    const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));
    expect(pkg.scripts.setup).toBe('node scripts/setup.mjs');
    for (const file of ['SETUP.md', 'SETUP.de.md']) {
      const doc = readFileSync(join(ROOT, file), 'utf8');
      for (const flag of ['--runtime docker', '--runtime podman', '--runtime kubernetes', '--runtime native', '--registry', '--bin-dir', '--with-blender', '--gpu', '--dry-run', '--skip-install', '--skip-build', '--skip-browser', '--with-deps', '--no-link', 'OPENVIDEO_RUNTIME', 'OPENVIDEO_CONFIG_DIR']) expect(doc, `${file}: ${flag}`).toContain(flag);
    }
    expect(existsSync(join(ROOT, 'deploy', 'k8s', 'overlays', 'dev', 'kustomization.yaml'))).toBe(true);
  });
});
