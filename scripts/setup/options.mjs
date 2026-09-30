// Optionen von `npm run setup` (ADR 0029).

export const RUNTIMES = ['auto', 'docker', 'podman', 'kubernetes', 'native'];
export const BUILDERS = ['docker', 'podman', 'nerdctl', 'buildah'];
export const CLUSTERS = ['kind', 'minikube', 'k3d', 'k3s', 'docker-desktop', 'rancher-desktop', 'registry'];

const FLAGS = ['--dry-run', '--skip-install', '--skip-build', '--skip-browser', '--with-deps', '--no-link', '--with-blender', '--gpu', '--help'];
const VALUES = ['--runtime', '--builder', '--registry', '--cluster', '--kube-context', '--namespace', '--bin-dir', '--ca-cert'];

export const USAGE = `Usage: npm run setup -- [options]

Runtime (default: auto; or OPENVIDEO_RUNTIME; a later run reuses the saved choice):
  --runtime <auto|docker|podman|kubernetes|native>
                        auto checks docker, podman, kubernetes in this order; native only as last fallback
  --bin-dir <dir>       Where the openvideo wrapper goes (default ~/.local/bin)
  --with-blender        Image with Blender 4.2 LTS (blender nodes)
  --gpu                 Pass the NVIDIA GPU into the container/pod (only if available)
  --ca-cert <file>      CA certificates for a TLS proxy during the image build (default: NODE_EXTRA_CA_CERTS)

Kubernetes:
  --kube-context <ctx>  kubectl context (default: current context)
  --namespace <ns>      Namespace of the local stack (default openvideo-local)
  --builder <docker|podman|nerdctl|buildah>
                        Image builder (default: the first one available in this order)
  --cluster <kind|minikube|k3d|k3s|docker-desktop|rancher-desktop|registry>
                        How the image reaches the cluster (default: detected from the context)
  --registry <host/path>
                        Push the image there and use it from there (clusters without local image import)

Native (Node.js on this host):
  --skip-install --skip-build --skip-browser --with-deps --no-link

General:
  --dry-run             Print detection, builder, commands and wrapper content as JSON; change nothing
  --skip-build          Container runtimes: reuse the existing image instead of building it
  --help`;

/** Fehler in den Optionen (Exit-Code 2). */
export class UsageError extends Error {}

/**
 * Liest die Optionen. `--name value` und `--name=value` sind gleichwertig.
 *
 * @example
 * parseOptions(['--runtime', 'docker'], {}); // { runtime: 'docker', runtimeSource: 'flag', … }
 */
export function parseOptions(argv, env) {
  const flags = new Set();
  const values = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const eq = arg.indexOf('=');
    const name = eq > 0 ? arg.slice(0, eq) : arg;
    if (FLAGS.includes(name) && eq < 0) {
      flags.add(name);
      continue;
    }
    if (VALUES.includes(name)) {
      const value = eq > 0 ? arg.slice(eq + 1) : argv[++i];
      if (value === undefined || value === '' || (eq < 0 && value.startsWith('--'))) throw new UsageError(`Option ${name} needs a value.`);
      values[name.slice(2)] = value;
      continue;
    }
    throw new UsageError(`Unknown option ${arg}. Known: ${[...FLAGS, ...VALUES].join(', ')}`);
  }
  const envRuntime = env.OPENVIDEO_RUNTIME !== undefined && env.OPENVIDEO_RUNTIME !== '' ? env.OPENVIDEO_RUNTIME : undefined;
  const runtime = values.runtime ?? envRuntime;
  if (runtime !== undefined && !RUNTIMES.includes(runtime)) throw new UsageError(`Unknown runtime "${runtime}". Use one of: ${RUNTIMES.join(', ')}.`);
  if (values.builder !== undefined && !BUILDERS.includes(values.builder)) throw new UsageError(`Unknown builder "${values.builder}". Use one of: ${BUILDERS.join(', ')}.`);
  if (values.cluster !== undefined && !CLUSTERS.includes(values.cluster)) throw new UsageError(`Unknown cluster type "${values.cluster}". Use one of: ${CLUSTERS.join(', ')}.`);
  if (values.namespace !== undefined && !/^[a-z0-9]([-a-z0-9]{0,61}[a-z0-9])?$/u.test(values.namespace)) throw new UsageError(`Namespace "${values.namespace}" is not a valid Kubernetes name.`);
  if (values.cluster === 'registry' && values.registry === undefined) throw new UsageError('--cluster registry needs --registry <host/path>.');
  return {
    help: flags.has('--help'),
    dryRun: flags.has('--dry-run'),
    runtime,
    runtimeSource: values.runtime !== undefined ? 'flag' : envRuntime !== undefined ? 'env' : undefined,
    builder: values.builder,
    registry: values.registry,
    cluster: values.cluster ?? (values.registry !== undefined ? 'registry' : undefined),
    kubeContext: values['kube-context'],
    namespace: values.namespace,
    binDir: values['bin-dir'],
    caCert: values['ca-cert'],
    withBlender: flags.has('--with-blender'),
    gpu: flags.has('--gpu'),
    skipInstall: flags.has('--skip-install'),
    skipBuild: flags.has('--skip-build'),
    skipBrowser: flags.has('--skip-browser'),
    withDeps: flags.has('--with-deps'),
    noLink: flags.has('--no-link'),
  };
}
