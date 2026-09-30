import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { skipUnless } from '@agentic-video/testing';
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { renderVideo, type NodeEnvironment } from '@agentic-video/render';
import { createDockerChunkRunner, dockerRunArgs, type SchedulerEvent } from '@agentic-video/scheduler';
import { makeEnv, project, tempProjectDir } from './fixture.js';

const root = fileURLToPath(new URL('../../..', import.meta.url));
const dockerReady = spawnSync('docker', ['info'], { stdio: 'ignore' }).status === 0;
const baseReady = dockerReady && spawnSync('docker', ['image', 'inspect', 'node:22-bookworm-slim'], { stdio: 'ignore' }).status === 0;
const profile = { format: 'mp4', codec: 'h264' };
const envs: NodeEnvironment[] = [];

function walk(dir: string, out: string[]): void {
  for (const e of readdirSync(dir).sort()) {
    const p = join(dir, e);
    if (statSync(p).isDirectory()) walk(p, out);
    else out.push(p);
  }
}

/**
 * Baut das Test-Image aus `node:22-bookworm-slim`, den gebauten `dist`-Ordnern und `node_modules`.
 * Der Tag ist ein Inhalts-Hash; ein vorhandenes Image wird wiederverwendet.
 */
function buildWorkerImage(): string {
  const packages = readdirSync(join(root, 'packages')).filter((n) => existsSync(join(root, 'packages', n, 'dist')));
  const hash = createHash('sha256');
  hash.update(readFileSync(join(root, 'package-lock.json')));
  for (const name of packages) {
    const files: string[] = [join(root, 'packages', name, 'package.json')];
    walk(join(root, 'packages', name, 'dist'), files);
    for (const f of files) hash.update(relative(root, f)).update(readFileSync(f));
  }
  const tag = `openvideo-worker-test:${hash.digest('hex').slice(0, 16)}`;
  if (spawnSync('docker', ['image', 'inspect', tag], { stdio: 'ignore' }).status === 0) return tag;
  const ctx = mkdtempSync(join(tmpdir(), 'ov-worker-image-'));
  try {
    cpSync(join(root, 'node_modules'), join(ctx, 'node_modules'), { recursive: true, verbatimSymlinks: true });
    cpSync(join(root, 'package.json'), join(ctx, 'package.json'));
    for (const name of packages) {
      mkdirSync(join(ctx, 'packages', name), { recursive: true });
      cpSync(join(root, 'packages', name, 'package.json'), join(ctx, 'packages', name, 'package.json'));
      cpSync(join(root, 'packages', name, 'dist'), join(ctx, 'packages', name, 'dist'), { recursive: true });
    }
    writeFileSync(join(ctx, 'Dockerfile'), ['FROM node:22-bookworm-slim', 'WORKDIR /app', 'COPY . /app', 'ENTRYPOINT ["node", "/app/packages/worker/dist/bin.js"]', ''].join('\n'));
    execFileSync('docker', ['build', '-q', '-t', tag, ctx], { stdio: ['ignore', 'ignore', 'inherit'] });
  } finally {
    rmSync(ctx, { recursive: true, force: true });
  }
  return tag;
}

let image = '';
let reference: readonly string[] = [];

beforeAll(async () => {
  if (!baseReady) return;
  image = buildWorkerImage();
  const dir = tempProjectDir('ov-docker-ref-');
  const env = await makeEnv(dir);
  envs.push(env);
  reference = (await renderVideo(env, project, { outPath: join(dir, 'out', 'ref.mp4'), profile, chunkSize: 15, noAudio: true })).manifest.frameHashes;
}, 900_000);

afterAll(async () => {
  for (const env of envs) await env.dispose();
});

describe('Docker-Worker (Story 10.2)', () => {
  it('baut die Container-Argumente ohne Netz, read-only, ohne Capabilities und mit Grenzen', () => {
    const args = dockerRunArgs('img:1', 'n', { memory: '1g', cpus: 2 });
    expect(args.join(' ')).toContain('--network none --read-only --tmpfs /tmp:rw,size=2g --cap-drop ALL --security-opt no-new-privileges --pids-limit 512 --memory 1g --cpus 2 --user 65534:65534');
    expect(args).not.toContain('-v');
    expect(args.slice(-2)).toEqual(['img:1', '--stdio']);
  });

  // Braucht Docker und das Basis-Image node:22-bookworm-slim.
  it.skipIf(skipUnless(baseReady, 'Docker oder das Basis-Image node:22-bookworm-slim fehlt: `docker pull node:22-bookworm-slim`'))(
    'rendert in Containern ohne Netz mit denselben Frame-Hashes',
    async () => {
      const dir = tempProjectDir('ov-docker-');
      const env = await makeEnv(dir);
      envs.push(env);
      const events: SchedulerEvent[] = [];
      const inspected = new Map<string, string>();
      const runChunks = createDockerChunkRunner({
        image,
        concurrency: 2,
        limits: { memory: '1g', cpus: 1 },
        projectDir: dir,
        project,
        cache: env.cache,
        telemetry: env.telemetry,
        onEvent: (e) => {
          events.push(e);
          // Nach dem ersten Ergebnis läuft der Container sicher (bei `chunk-started` kann er noch entstehen).
          const container = e.type === 'chunk-done' ? events.find((x) => x.type === 'worker-started' && x.worker === e.worker) : undefined;
          if (container?.type === 'worker-started' && container.container !== undefined && !inspected.has(container.container)) {
            const out = spawnSync('docker', ['inspect', '--format', '{{.HostConfig.NetworkMode}} {{.HostConfig.ReadonlyRootfs}} {{len .Mounts}}', container.container], { encoding: 'utf8' });
            inspected.set(container.container, out.stdout.trim());
          }
        },
      });
      const r = await renderVideo(env, project, { outPath: join(dir, 'out', 'docker.mp4'), profile, chunkSize: 15, noAudio: true, runChunks });
      expect(r.manifest.frameHashes).toEqual(reference);
      expect(r.manifest.chunks.every((c) => c.worker?.startsWith('docker-') === true)).toBe(true);
      expect(inspected.size).toBeGreaterThanOrEqual(1);
      for (const v of inspected.values()) expect(v).toBe('none true 0');
      // Container werden mit --rm entfernt.
      const left = spawnSync('docker', ['ps', '-a', '--filter', 'name=openvideo-worker-', '--format', '{{.Names}}'], { encoding: 'utf8' }).stdout.trim();
      const ours = [...inspected.keys()].filter((n) => left.split('\n').includes(n));
      expect(ours).toEqual([]);
    },
    900_000,
  );
});
