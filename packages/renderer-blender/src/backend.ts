/**
 * Blender-Backend (FR-43, FR-44): rendert `blender`-Nodes headless mit Cycles oder Eevee.
 *
 * Ablauf je Chunk: Node beschreibt jeden Frame als JSON-Zustand, startet **einen**
 * Blender-Prozess mit `python/openvideo_blender.py`, liest die PNGs und platziert sie
 * mit der 2D-Matrix der Node im Ausgabebild.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { availableParallelism } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  OpenVideoError,
  minimalChildEnv,
  evaluateScene,
  walkEvaluated,
  type BackendCheck,
  type EvaluateOptions,
  type EvaluatedNode,
  type LayerRequest,
  type RenderBackend,
  type RgbaImage,
} from '@agentic-video/core';
import { decodePng } from '@agentic-video/png';
import { checkBlenderNode } from './check.js';
import { describeScene, type BlenderSceneState } from './describe.js';
import { detectBlender, type BlenderInstall } from './detect.js';
import { placeImage, renderSize } from './place.js';

/** Pfad des mitgelieferten Python-Skripts. */
export const BLENDER_SCRIPT_PATH: string = fileURLToPath(new URL('../python/openvideo_blender.py', import.meta.url));

/**
 * Fähigkeit eines Backends, Motion Blur aus Nachbar-Subframes zu rechnen (Story 17.5): Der Frame-Render
 * wertet für Nodes mit `motionBlur: true` die Szene an den Offsets {@link DEFAULT_MOTION_OFFSETS} aus und
 * übergibt die Zustände als `motionStates` ({@link BlenderLayerRequest}).
 */
export const MOTION_STATES_CAPABILITY = 'motion-states';

/** Standard-Offsets der Subframes in Frames: Verschlusszeit ½ Frame, zentriert. */
export const DEFAULT_MOTION_OFFSETS: readonly number[] = [-0.25, 0.25];

/** Fähigkeiten des Blender-Backends. */
export const BLENDER_CAPABILITIES: readonly string[] = [
  'blender.cycles',
  'blender.eevee',
  'blender.passes.depth',
  'blender.passes.normal',
  'blender.passes.object-mask',
  'blender.volume',
  'blender.fog',
  'blender.motion-blur',
  'blender.gltf',
  'blender.obj',
  'blender.hdri',
  'blender.transparent',
  'blender.particles',
  MOTION_STATES_CAPABILITY,
];

/** Standard-Timeout je Frame (inklusive Start von Blender beim ersten Frame). */
export const DEFAULT_FRAME_TIMEOUT_MS = 10 * 60_000;

/** Zustand der Nodes eines Layers an einem Nachbar-Subframe (für Motion Blur). */
export interface MotionState {
  /** Abstand zum Frame in Frames, z. B. `-0.25` oder `0.25`. */
  readonly offset: number;
  /** Dieselben Nodes wie `LayerRequest.nodes`, ausgewertet am Subframe. */
  readonly nodes: readonly EvaluatedNode[];
}

/** Auftrag mit optionalen Subframe-Zuständen für Motion Blur. */
export interface BlenderLayerRequest extends LayerRequest {
  /**
   * Zustände an Nachbar-Subframes. Ohne sie bleibt `motionBlur: true` wirkungslos,
   * denn das Backend rechnet keine Zeit selbst (OpenVideo besitzt die Zeit).
   */
  readonly motionStates?: readonly MotionState[];
}

/** Optionen für {@link createBlenderBackend}. */
export interface BlenderBackendOptions {
  /** Pfad zur Blender-Programmdatei. Sonst `OPENVIDEO_BLENDER`, `PATH`, `~/.local/opt/blender*`. */
  readonly blenderPath?: string;
  /** Arbeitsordner für Job-Dateien und Zwischenbilder. */
  readonly workDir: string;
  /** Feste Thread-Zahl für Blender. Standard: alle Kerne. */
  readonly threads?: number;
  /** Timeout je Frame in Millisekunden. Standard {@link DEFAULT_FRAME_TIMEOUT_MS}. */
  readonly frameTimeoutMs?: number;
  /** Umgebung für die Blender-Suche (`OPENVIDEO_BLENDER`, `PATH`, `HOME`). Standard: `process.env`. */
  readonly env?: Readonly<Record<string, string | undefined>>;
}

/** Das Blender-Backend mit Batch-API. */
export interface BlenderBackend extends RenderBackend {
  /** Rendert alle Aufträge in **einem** Blender-Prozess (Szene einmal aufbauen, je Frame Zustände setzen). */
  renderFrames(requests: readonly BlenderLayerRequest[]): Promise<RgbaImage[]>;
  /** Anzahl der bisher gestarteten Blender-Prozesse. */
  readonly launches: number;
}

const ERROR_CLASS = 'BlenderRendererError';
const STDERR_LINES = 30;

/** Macht aus einer ausgewerteten Node wieder eine IR-ähnliche Node für {@link checkBlenderNode}. */
function toRecord(node: EvaluatedNode): Record<string, unknown> {
  return { ...node.props, id: node.id, type: node.type, children: node.children.map(toRecord) };
}

function blenderNodeOf(request: LayerRequest): EvaluatedNode {
  const [node, ...rest] = request.nodes;
  if (node?.type !== 'blender' || rest.length > 0) {
    throw new OpenVideoError({
      code: 'OV_BLENDER_NODE_TYPE',
      errorClass: ERROR_CLASS,
      problem: 'The blender backend renders exactly one "blender" node per layer.',
      details: { layer: request.layerId, nodes: request.nodes.map((n) => `${n.id}:${n.type}`).join(', ') },
      suggestions: ['Put the 3D content into one blender node.', 'Let the planner place each blender node on its own layer.'],
    });
  }
  return node;
}

/**
 * Wertet die Nodes eines Layers an Nachbar-Subframes aus (für Motion Blur).
 *
 * @param nodeIds IDs der Layer-Nodes (in Reihenfolge).
 * @param offsets Abstände in Frames. Standard `[-0.25, 0.25]` (Verschlusszeit ½ Frame).
 *
 * @example
 * ```ts
 * const motionStates = evaluateMotionStates(project, 'hero', 12, ['orbit']);
 * await backend.renderFrames([{ ...request, motionStates }]);
 * ```
 */
export function evaluateMotionStates(
  project: Readonly<Record<string, unknown>>,
  compositionId: string | undefined,
  frame: number,
  nodeIds: readonly string[],
  offsets: readonly number[] = DEFAULT_MOTION_OFFSETS,
  options: EvaluateOptions = {},
): MotionState[] {
  return offsets.map((offset) => {
    const scene = evaluateScene(project, compositionId, frame + offset, { ...options, motionKey: false });
    const found = new Map<string, EvaluatedNode>();
    walkEvaluated(scene.nodes, (n) => {
      if (nodeIds.includes(n.id)) found.set(n.id, n);
    });
    return { offset, nodes: nodeIds.map((id) => found.get(id)).filter((n): n is EvaluatedNode => n !== undefined) };
  });
}

interface RunResult {
  readonly frames: number;
}


/** Variablen, die Blender zusätzlich zu `CHILD_ENV_NAMES` (core) erbt (N1). */
const BLENDER_ENV_NAMES: readonly string[] = ['DISPLAY', 'OCIO'];
/** Präfixe für Blender, GPU-Treiber und Mesa (z. B. `BLENDER_USER_SCRIPTS`, `CUDA_VISIBLE_DEVICES`). */
const BLENDER_ENV_PREFIXES: readonly string[] = ['BLENDER_', 'CUDA_', 'NVIDIA_', '__GLX_', '__EGL_', 'MESA_', 'EGL_', 'LIBGL_', 'VK_', 'OMP_'];

/**
 * Minimale Umgebung für den Blender-Prozess (N1, Story 16.5): nur Laufzeit-, Grafik- und
 * Blender-Variablen. Tokens und S3-Schlüssel (`OPENVIDEO_*`, `AWS_*`) bleiben draußen.
 *
 * @example
 * ```ts
 * blenderEnv({ PATH: '/usr/bin', OPENVIDEO_WORKER_TOKEN: 'secret', CUDA_VISIBLE_DEVICES: '0' }); // { PATH: '/usr/bin', CUDA_VISIBLE_DEVICES: '0' }
 * ```
 */
export function blenderEnv(source: Readonly<Record<string, string | undefined>>): Record<string, string> {
  return minimalChildEnv(source, { names: BLENDER_ENV_NAMES, prefixes: BLENDER_ENV_PREFIXES });
}
/**
 * Erzeugt das Blender-Backend. Blender wird erst beim ersten Render gesucht; `versions()` ist ohne Blender leer;
 * `check()` braucht kein Blender.
 *
 * @example
 * ```ts
 * const backend = createBlenderBackend({ workDir: '/tmp/ov-blender', threads: 8 });
 * const layer = await backend.renderLayer(request);
 * await backend.dispose();
 * ```
 */
export function createBlenderBackend(options: BlenderBackendOptions): BlenderBackend {
  const threads = Math.max(1, Math.floor(options.threads ?? availableParallelism()));
  const frameTimeoutMs = options.frameTimeoutMs ?? DEFAULT_FRAME_TIMEOUT_MS;
  const running = new Set<ChildProcess>();
  let install: BlenderInstall | undefined;
  let launches = 0;

  const blender = (): BlenderInstall => {
    if (install !== undefined) return install;
    const found = detectBlender({ ...(options.blenderPath !== undefined ? { blenderPath: options.blenderPath } : {}), ...(options.env !== undefined ? { env: options.env } : {}) });
    if (!found.found) throw new OpenVideoError(found.diagnostic);
    install = { path: found.path, version: found.version };
    return install;
  };

  const run = (jobPath: string, frameCount: number, signal: { readonly aborted: boolean } | undefined): Promise<RunResult> =>
    new Promise((resolve, reject) => {
      const { path } = blender();
      launches++;
      const child = spawn(path, ['-b', '--factory-startup', '-noaudio', '--python-exit-code', '1', '--python', BLENDER_SCRIPT_PATH, '--', jobPath], {
        stdio: ['ignore', 'pipe', 'pipe'],
        // Minimale Umgebung (N1): keine Tokens oder S3-Schlüssel an Blender und seine Python-Skripte.
        env: blenderEnv(process.env),
      });
      running.add(child);
      const stderr: string[] = [];
      let stdoutRest = '';
      let stderrRest = '';
      let done = 0;
      let failure: OpenVideoError | undefined;
      const fail = (code: string, problem: string, suggestions: readonly string[]): void => {
        if (failure !== undefined) return;
        failure = new OpenVideoError({
          code,
          errorClass: ERROR_CLASS,
          problem,
          details: { blender: path, framesDone: done, frames: frameCount, stderr: stderr.slice(-STDERR_LINES).join('\n') },
          suggestions,
        });
        child.kill('SIGKILL');
      };
      let timer: NodeJS.Timeout | undefined;
      const arm = (): void => {
        if (timer !== undefined) clearTimeout(timer);
        timer = setTimeout(() => {
          fail('OV_BLENDER_TIMEOUT', `Blender needed more than ${String(frameTimeoutMs)} ms for frame ${String(done)}.`, [
            'Lower samples on the blender node.',
            'Raise frameTimeoutMs in createBlenderBackend().',
            'Use engine: "eevee" for faster previews.',
          ]);
        }, frameTimeoutMs);
      };
      arm();
      child.stdout.setEncoding('utf8');
      child.stdout.on('data', (chunk: string) => {
        const lines = (stdoutRest + chunk).split('\n');
        stdoutRest = lines.pop() ?? '';
        for (const line of lines) {
          if (!line.startsWith('OV_FRAME_DONE ')) continue;
          done++;
          arm();
          if (signal?.aborted === true) fail('OV_BLENDER_ABORTED', 'The render was aborted.', ['Start the render again.']);
        }
      });
      child.stderr.setEncoding('utf8');
      child.stderr.on('data', (chunk: string) => {
        const lines = (stderrRest + chunk).split('\n');
        stderrRest = lines.pop() ?? '';
        stderr.push(...lines);
        if (stderr.length > STDERR_LINES * 4) stderr.splice(0, stderr.length - STDERR_LINES);
      });
      child.on('error', (error) => {
        fail('OV_BLENDER_PROCESS_FAILED', `Blender could not be started: ${error.message}`, ['Check that the Blender path is executable.', 'Run `blender --version` by hand.']);
      });
      child.on('close', (code) => {
        if (timer !== undefined) clearTimeout(timer);
        running.delete(child);
        if (stderrRest !== '') stderr.push(stderrRest);
        if (failure === undefined && (code !== 0 || done !== frameCount)) {
          fail('OV_BLENDER_PROCESS_FAILED', `Blender exited with code ${String(code)} after ${String(done)} of ${String(frameCount)} frames.`, [
            'Read details.stderr for the Blender or Python error.',
            'Run checkBlenderNode() on the node and fix reported errors.',
            'Check that all asset files exist and are readable.',
          ]);
        }
        if (failure !== undefined) reject(failure);
        else resolve({ frames: done });
      });
    });

  const renderFrames = async (requests: readonly BlenderLayerRequest[]): Promise<RgbaImage[]> => {
    if (requests.length === 0) return [];
    const prepared = requests.map((request) => {
      const node = blenderNodeOf(request);
      const errors = checkBlenderNode(toRecord(node)).filter((d) => d.severity === 'error');
      const first = errors[0];
      if (first !== undefined) throw new OpenVideoError({ ...first, frame: request.scene.frame, compositionId: request.scene.compositionId });
      const size = renderSize(node, request.scale);
      const ctx = { ...size, fps: request.scene.fps, seed: request.scene.seed, assets: request.assets };
      const states: { offset: number; scene: BlenderSceneState }[] = [{ offset: 0, scene: describeScene(node, ctx) }];
      if (node.props['motionBlur'] === true) {
        for (const m of request.motionStates ?? []) {
          const sub = m.nodes.find((n) => n.id === node.id);
          if (sub !== undefined && m.offset !== 0) states.push({ offset: m.offset, scene: describeScene(sub, ctx) });
        }
      }
      return { request, node, states };
    });
    const signal = requests.find((r) => r.signal !== undefined)?.signal;
    if (signal?.aborted === true) throw new OpenVideoError({ code: 'OV_BLENDER_ABORTED', errorClass: ERROR_CLASS, problem: 'The render was aborted.', suggestions: ['Start the render again.'] });
    mkdirSync(options.workDir, { recursive: true });
    const dir = mkdtempSync(join(options.workDir, 'job-'));
    const jobPath = join(dir, 'job.json');
    writeFileSync(jobPath, JSON.stringify({ threads, outDir: dir, frames: prepared.map((p) => ({ states: p.states })) }));
    await run(jobPath, prepared.length, signal);
    const images = prepared.map((p, i) => {
      const rendered = decodePng(readFileSync(join(dir, `frame_${String(i).padStart(5, '0')}.png`)));
      return placeImage(rendered, p.node, p.request.width, p.request.height, p.request.scale);
    });
    rmSync(dir, { recursive: true, force: true });
    return images;
  };

  return {
    id: 'blender',
    nodeTypes: ['blender'],
    capabilities: BLENDER_CAPABILITIES,
    fusable: false,
    get launches() {
      return launches;
    },
    versions() {
      // Ohne Blender liefert das Backend keine Version, statt den Start der Umgebung zu blockieren.
      // Der Fehler kommt erst, wenn wirklich eine blender-Node gerendert wird.
      if (install !== undefined) return { blender: install.version };
      const found = detectBlender({ ...(options.blenderPath !== undefined ? { blenderPath: options.blenderPath } : {}), ...(options.env !== undefined ? { env: options.env } : {}) });
      return found.found ? { blender: found.version } : {};
    },
    check(node): BackendCheck {
      const diagnostics = checkBlenderNode(node);
      return { supported: !diagnostics.some((d) => d.severity === 'error'), diagnostics };
    },
    async renderLayer(request) {
      const [image] = await renderFrames([request]);
      if (image === undefined) throw new OpenVideoError({ code: 'OV_BLENDER_PROCESS_FAILED', errorClass: ERROR_CLASS, problem: 'Blender returned no image.', suggestions: ['Run the render again.'] });
      return image;
    },
    renderFrames,
    dispose() {
      for (const child of running) child.kill('SIGKILL');
      running.clear();
      return Promise.resolve();
    },
  };
}
