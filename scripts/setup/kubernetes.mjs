// Kubernetes-Laufzeit (ADR 0029): lokal gebautes Image in den Cluster bringen und den schlanken Stack
// deploy/k8s/overlays/dev über ein erzeugtes Overlay im Konfigurationsverzeichnis anwenden.
import { join, relative, sep } from 'node:path';
import { saveCommand, tagCommand, pushCommand } from './image.mjs';

/**
 * Schritte, die das Image in den Cluster bringen. `image` ist die lokale Referenz (eindeutiger Tag),
 * `archive` eine Datei für den Import per Archiv. Liefert `{ steps, error? }`.
 */
export function loadImageSteps({ cluster, builder, image, archive, registry, env, which, isRoot }) {
  const b = { builder: builder.name, builderPath: builder.path, ...(builder.namespace !== undefined ? { namespace: builder.namespace } : {}) };
  const save = { name: 'save-image', ...saveCommand({ ...b, image, file: archive }) };
  const need = (tool) => which(tool, env);
  switch (cluster.type) {
    case 'kind': {
      const kind = need('kind');
      if (kind === undefined) return { steps: [], error: 'The context is a kind cluster, but the program kind is not installed (https://kind.sigs.k8s.io).' };
      if (builder.name === 'docker') return { steps: [{ name: 'load-image', cmd: kind, argv: ['load', 'docker-image', image, '--name', cluster.name] }] };
      return { steps: [save, { name: 'load-image', cmd: kind, argv: ['load', 'image-archive', archive, '--name', cluster.name] }] };
    }
    case 'minikube': {
      const minikube = need('minikube');
      if (minikube === undefined) return { steps: [], error: 'The context is a minikube cluster, but the program minikube is not installed.' };
      if (builder.name === 'docker') return { steps: [{ name: 'load-image', cmd: minikube, argv: ['-p', cluster.name, 'image', 'load', image] }] };
      return { steps: [save, { name: 'load-image', cmd: minikube, argv: ['-p', cluster.name, 'image', 'load', archive] }] };
    }
    case 'k3d': {
      const k3d = need('k3d');
      if (k3d === undefined) return { steps: [], error: 'The context is a k3d cluster, but the program k3d is not installed.' };
      if (builder.name === 'docker') return { steps: [{ name: 'load-image', cmd: k3d, argv: ['image', 'import', image, '--cluster', cluster.name] }] };
      return { steps: [save, { name: 'load-image', cmd: k3d, argv: ['image', 'import', archive, '--cluster', cluster.name] }] };
    }
    case 'k3s': {
      // containerd von k3s gehört root: Import mit sudo, wenn das Setup nicht als root läuft.
      const k3s = need('k3s');
      const ctr = need('ctr');
      const sudo = isRoot ? [] : ['sudo'];
      const importer = k3s !== undefined ? [...sudo, k3s, 'ctr', 'images', 'import', archive] : ctr !== undefined ? [...sudo, ctr, '-n', 'k8s.io', '--address', '/run/k3s/containerd/containerd.sock', 'images', 'import', archive] : undefined;
      if (importer === undefined) return { steps: [], error: 'The cluster runs k3s, but neither k3s nor ctr is on the PATH of this machine. For a remote k3s cluster use --registry <host/path>.' };
      return { steps: [save, { name: 'load-image', cmd: importer[0], argv: importer.slice(1), sudo: !isRoot }] };
    }
    case 'docker-desktop':
      if (builder.name !== 'docker') return { steps: [], error: 'Docker Desktop Kubernetes uses the images of its Docker engine: build with --builder docker.' };
      return { steps: [] };
    case 'rancher-desktop':
      if (builder.name === 'docker') return { steps: [] };
      if (builder.name === 'nerdctl') return { steps: [] };
      return { steps: [], error: 'Rancher Desktop uses the images of its engine: build with --builder docker (moby) or --builder nerdctl (containerd, namespace k8s.io).' };
    case 'registry': {
      const target = `${registry.replace(/\/+$/u, '')}/${image.replace(/^localhost\//u, '')}`;
      return { steps: [{ name: 'tag-registry', ...tagCommand({ ...b, from: image, to: target }) }, { name: 'push-image', ...pushCommand({ ...b, image: target }) }], image: target };
    }
    default:
      return {
        steps: [],
        error: `Cannot bring the locally built image into the cluster of context ${cluster.name}: ${cluster.reason}. Options: --registry <host/path> (push to a registry the cluster can pull from), --cluster <kind|minikube|k3d|k3s|docker-desktop|rancher-desktop>, or --runtime docker/podman.`,
      };
  }
}

/** Namespace mit Pod Security "restricted" (wie deploy/k8s/base/namespace.yaml). */
export function namespaceManifest(namespace) {
  return `# Erzeugt von npm run setup (ADR 0029).
apiVersion: v1
kind: Namespace
metadata:
  name: ${namespace}
  labels:
    app.kubernetes.io/part-of: openvideo
    pod-security.kubernetes.io/enforce: restricted
    pod-security.kubernetes.io/enforce-version: latest
    pod-security.kubernetes.io/warn: restricted
`;
}

/**
 * Erzeugtes Overlay (Konfigurationsverzeichnis, nicht im Repository): bindet deploy/k8s/overlays/dev ein und
 * setzt Namespace, Image (kustomize `images:`) und das Secret `openvideo-local` aus api.env.
 *
 * @example
 * kustomization({ overlayDir: '/home/u/.config/openvideo/kubernetes', devOverlay: '/src/deploy/k8s/overlays/dev', namespace: 'openvideo-local', imageName: 'openvideo-local', imageTag: '0.1.0-abc' });
 */
export function kustomization({ overlayDir, devOverlay, namespace, imageName, imageTag, gpu = false }) {
  const rel = relative(overlayDir, devOverlay).split(sep).join('/');
  const gpuPatch = gpu
    ? `patches:
  - target: { kind: Deployment, name: openvideo }
    patch: |-
      - { op: add, path: /spec/template/spec/containers/0/resources/limits/nvidia.com~1gpu, value: 1 }
      - { op: add, path: /spec/template/spec/containers/0/env/-, value: { name: NVIDIA_DRIVER_CAPABILITIES, value: "compute,utility,video,graphics" } }
`
    : '';
  return `# Erzeugt von npm run setup (ADR 0029). Nicht von Hand ändern: npm run setup erzeugt die Datei neu.
apiVersion: kustomize.config.k8s.io/v1beta1
kind: Kustomization
namespace: ${namespace}
resources:
  - namespace.yaml
  - ${rel}
images:
  - name: openvideo-local
    newName: ${imageName}
    newTag: ${imageTag}
secretGenerator:
  - name: openvideo-local
    envs: [api.env]
    options:
      disableNameSuffixHash: true
${gpuPatch}`;
}

/** Schritte nach dem Image: anwenden, auf den Rollout warten. */
export function deploySteps({ kubectl, context, namespace, overlayDir, newToken = false }) {
  return [
    { name: 'apply', cmd: kubectl, argv: ['--context', context, 'apply', '-k', overlayDir] },
    // Ein neues Token (Secret) wirkt erst nach einem Neustart; ein neuer Image-Tag startet den Pod ohnehin neu.
    ...(newToken ? [{ name: 'restart', cmd: kubectl, argv: ['--context', context, '-n', namespace, 'rollout', 'restart', 'deploy/openvideo'] }] : []),
    { name: 'rollout', cmd: kubectl, argv: ['--context', context, '-n', namespace, 'rollout', 'status', 'deploy/openvideo', '--timeout=300s'] },
  ];
}

/** Pfad der Archivdatei für den Import. */
export function archivePath(overlayDir) {
  return join(overlayDir, 'openvideo-local.tar');
}
