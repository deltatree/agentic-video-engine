// Lokaler Image-Build mit der jeweiligen Technik (ADR 0029): docker build, podman build, nerdctl build,
// buildah build – immer dasselbe Dockerfile (deploy/docker/Dockerfile, Ziel `local`).
import { join } from 'node:path';

export const IMAGE_NAME = 'openvideo-local';

/**
 * Image-Referenzen: `openvideo-local:<version>` plus `openvideo-local:latest`.
 *
 * @example
 * imageTags('0.1.0'); // { versioned: 'openvideo-local:0.1.0', latest: 'openvideo-local:latest' }
 */
export function imageTags(version) {
  return { versioned: `${IMAGE_NAME}:${version}`, latest: `${IMAGE_NAME}:latest` };
}

/**
 * Build-Befehl für einen Builder. Podman und Buildah bauen im Docker-Format (sonst ignoriert das OCI-Format
 * die SHELL-Anweisung) und brauchen die Ignore-Datei ausdrücklich; Docker und nerdctl (BuildKit) finden
 * `Dockerfile.dockerignore` neben dem Dockerfile selbst. Chromium und Blender gibt es nur für amd64.
 *
 * @example
 * buildCommand({ builder: 'podman', builderPath: 'podman', root: '/repo', version: '0.1.0' });
 * // { cmd: 'podman', argv: ['build', '--format', 'docker', …, '/repo'], env: {} }
 */
export function buildCommand({ builder, builderPath, root, version, revision = 'unknown', withBlender = false, caCert, namespace }) {
  const tags = imageTags(version);
  const dockerfile = join(root, 'deploy', 'docker', 'Dockerfile');
  const common = [
    '--file', dockerfile,
    '--target', 'local',
    '--platform', 'linux/amd64',
    '--tag', tags.versioned,
    '--tag', tags.latest,
    '--build-arg', `VERSION=${version}`,
    '--build-arg', `REVISION=${revision}`,
    ...(withBlender ? ['--build-arg', 'LOCAL_BASE=blender'] : []),
    ...(caCert !== undefined ? ['--secret', `id=ca,src=${caCert}`] : []),
  ];
  const ignore = ['--ignorefile', join(root, 'deploy', 'docker', 'Dockerfile.dockerignore')];
  switch (builder) {
    case 'docker':
      return { cmd: builderPath, argv: ['build', ...common, root], env: { DOCKER_BUILDKIT: '1' } };
    case 'podman':
      return { cmd: builderPath, argv: ['build', '--format', 'docker', ...ignore, ...common, root], env: {} };
    case 'buildah':
      return { cmd: builderPath, argv: ['build', '--format', 'docker', ...ignore, ...common, root], env: {} };
    case 'nerdctl':
      return { cmd: builderPath, argv: [...(namespace !== undefined ? ['--namespace', namespace] : []), 'build', ...common, root], env: {} };
    default:
      throw new Error(`unknown builder ${builder}`);
  }
}

/** Befehl, der die Image-ID liefert (für eindeutige Tags im Cluster). */
export function imageIdCommand({ builder, builderPath, image, namespace }) {
  if (builder === 'buildah') return { cmd: builderPath, argv: ['inspect', '--type', 'image', '--format', '{{.FromImageID}}', image] };
  return { cmd: builderPath, argv: [...(builder === 'nerdctl' && namespace !== undefined ? ['--namespace', namespace] : []), 'image', 'inspect', '--format', '{{.Id}}', image] };
}

/** Befehl zum Umbenennen/zusätzlichen Taggen eines Images. */
export function tagCommand({ builder, builderPath, from, to, namespace }) {
  return { cmd: builderPath, argv: [...(builder === 'nerdctl' && namespace !== undefined ? ['--namespace', namespace] : []), 'tag', from, to] };
}

/** Befehl, der das Image als Docker-Archiv speichert (Import in kind, minikube, k3d, k3s). */
export function saveCommand({ builder, builderPath, image, file, namespace }) {
  if (builder === 'buildah') return { cmd: builderPath, argv: ['push', image, `docker-archive:${file}:${image}`] };
  if (builder === 'podman') return { cmd: builderPath, argv: ['save', '--format', 'docker-archive', '--output', file, image] };
  return { cmd: builderPath, argv: [...(builder === 'nerdctl' && namespace !== undefined ? ['--namespace', namespace] : []), 'save', '--output', file, image] };
}

/** Befehl zum Hochladen in eine Registry. */
export function pushCommand({ builder, builderPath, image, namespace }) {
  return { cmd: builderPath, argv: [...(builder === 'nerdctl' && namespace !== undefined ? ['--namespace', namespace] : []), 'push', image] };
}

/**
 * Name des Images, wie ein Cluster es nach dem Import kennt: Podman und Buildah speichern lokale Images als
 * `localhost/<name>`, Docker und nerdctl als `docker.io/library/<name>` (Kurzform `<name>`).
 *
 * @example
 * clusterImageName('podman'); // 'localhost/openvideo-local'
 */
export function clusterImageName(builder) {
  return builder === 'podman' || builder === 'buildah' ? `localhost/${IMAGE_NAME}` : IMAGE_NAME;
}
