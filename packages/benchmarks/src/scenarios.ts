/**
 * Benchmark-Szenarien (A38): Projekte und Assets entstehen deterministisch im Code.
 *
 * Jedes Szenario belastet einen Teil der Pipeline besonders stark:
 * Textsatz, Vektorgrafik, Bilder, Videodekodierung, 3D, gemischte Backends oder Audio.
 */
import { execFile } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { OpenVideoError, SCHEMA_VERSION, random } from '@agentic-video/core';
import { encodePng } from '@agentic-video/png';

/** Alle Szenarien in fester Reihenfolge. */
export const SCENARIOS = ['text-heavy', 'vector-heavy', 'image-heavy', 'video-heavy', '3d-heavy', 'mixed', 'audio-heavy'] as const;
/** Kennung eines Szenarios. */
export type ScenarioId = (typeof SCENARIOS)[number];

/** Auflösungen mit Bildrate (A38). */
export const RESOLUTIONS = {
  '1080p30': { width: 1920, height: 1080, fps: 30 },
  '1080p60': { width: 1920, height: 1080, fps: 60 },
  '4k30': { width: 3840, height: 2160, fps: 30 },
  '4k60': { width: 3840, height: 2160, fps: 60 },
} as const;
/** Kennung einer Auflösung. */
export type ResolutionId = keyof typeof RESOLUTIONS;
/** Alle Auflösungen in fester Reihenfolge. */
export const RESOLUTION_IDS: readonly ResolutionId[] = ['1080p30', '1080p60', '4k30', '4k60'];

/** Seed aller Szenarien; gleiche Eingabe ergibt gleiche Projekte und Assets. */
const SEED = 1405;

type Json = Record<string, unknown>;

/**
 * Prüft, ob ein Wert eine bekannte Szenario-Kennung ist.
 *
 * @example
 * ```ts
 * isScenarioId('mixed'); // true
 * ```
 */
export function isScenarioId(value: string): value is ScenarioId {
  return SCENARIOS.some((s) => s === value);
}

/**
 * Prüft, ob ein Wert eine bekannte Auflösungs-Kennung ist.
 *
 * @example
 * ```ts
 * isResolutionId('4k60'); // true
 * ```
 */
export function isResolutionId(value: string): value is ResolutionId {
  return RESOLUTION_IDS.some((r) => r === value);
}

/** Ein erzeugtes Szenario-Projekt. */
export interface ScenarioProject {
  readonly project: Json;
  readonly compositionId: string;
}

/** Eingaben für {@link buildScenario}. */
export interface ScenarioOptions {
  readonly scenario: ScenarioId;
  readonly resolution: ResolutionId;
  /** Anzahl gerenderter Frames; die Composition ist mindestens so lang. */
  readonly frames: number;
  /** Projektordner; Assets werden hier unter `assets/` angelegt. */
  readonly projectDir: string;
  /** FFmpeg-Programm für Test-Videos und Töne (Standard: `OPENVIDEO_FFMPEG` oder `ffmpeg` aus `PATH`). */
  readonly ffmpeg?: string;
}

function rnd(...keys: readonly (number | string)[]): number {
  return random(SEED, ...keys);
}

function hex(v: number): string {
  return Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, '0');
}

function color(...keys: readonly (number | string)[]): string {
  return `#${hex(40 + rnd(...keys, 'r') * 215)}${hex(40 + rnd(...keys, 'g') * 215)}${hex(40 + rnd(...keys, 'b') * 215)}`;
}

function keyframes(from: unknown, to: unknown, frames: number): Json {
  return { $keyframes: [{ t: 0, v: from }, { t: Math.max(1, frames), v: to, ease: 'easeInOutCubic' }] };
}

/**
 * Führt FFmpeg aus und meldet Fehler als {@link OpenVideoError}.
 *
 * @example
 * ```ts
 * await runFfmpeg('ffmpeg', ['-f', 'lavfi', '-i', 'sine=f=440:d=1', 'tone.wav']);
 * ```
 */
export function runFfmpeg(ffmpeg: string, args: readonly string[]): Promise<void> {
  return new Promise((resolvePromise, reject) => {
    execFile(ffmpeg, ['-y', '-loglevel', 'error', ...args], (error, _stdout, stderr) => {
      if (error === null) {
        resolvePromise();
        return;
      }
      reject(
        new OpenVideoError({
          code: 'OV_BENCH_FFMPEG',
          errorClass: 'BenchmarkError',
          problem: `FFmpeg could not create a test asset: ${stderr.trim() || error.message}`,
          suggestions: ['Install FFmpeg with lavfi support and put it on PATH.', 'Or set OPENVIDEO_FFMPEG to the full path of the ffmpeg binary.'],
          cause: error,
        }),
      );
    });
  });
}

/** FFmpeg-Programm aus Option, `OPENVIDEO_FFMPEG` oder `PATH`. */
export function ffmpegProgram(explicit?: string): string {
  return explicit ?? process.env['OPENVIDEO_FFMPEG'] ?? 'ffmpeg';
}

/**
 * Erzeugt ein deterministisches Testbild (Ringe und Streifen) als PNG.
 *
 * @example
 * ```ts
 * const png = generateImage(7, 256);
 * ```
 */
export function generateImage(index: number, size: number): Uint8Array {
  const data = new Uint8Array(size * size * 4);
  const r0 = rnd('img', index, 'r') * 255;
  const g0 = rnd('img', index, 'g') * 255;
  const b0 = rnd('img', index, 'b') * 255;
  const rings = 3 + Math.floor(rnd('img', index, 'rings') * 9);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const dx = x / size - 0.5;
      const dy = y / size - 0.5;
      const ring = 0.5 + 0.5 * Math.sin(Math.sqrt(dx * dx + dy * dy) * rings * 2 * Math.PI);
      const stripe = ((x + y) >> 4) % 2 === 0 ? 1 : 0.8;
      const o = (y * size + x) * 4;
      data[o] = Math.round(r0 * ring * stripe);
      data[o + 1] = Math.round(g0 * (1 - ring) * stripe + 40);
      data[o + 2] = Math.round(b0 * stripe);
      data[o + 3] = 255;
    }
  }
  return encodePng({ width: size, height: size, data });
}

function composition(id: string, opts: ScenarioOptions, nodes: readonly unknown[], extra: Json = {}): Json {
  const res = RESOLUTIONS[opts.resolution];
  // Mindestens eine Sekunde; lang genug für alle gemessenen Frames plus den Aufwärm-Frame dahinter.
  const duration = Math.max(res.fps, opts.frames + 1);
  return { id, width: res.width, height: res.height, fps: res.fps, duration, background: '#0B0D12', ...extra, nodes };
}

function textHeavy(opts: ScenarioOptions, s: number): ScenarioProject {
  const nodes: unknown[] = [{ id: 'title', type: 'text', text: 'Benchmark: text-heavy', fontSize: 72 * s, fontWeight: 700, x: 100 * s, y: 60 * s, fill: '#FFFFFF' }];
  const words = ['render', 'frame', 'agent', 'layer', 'cache', 'vector', 'timeline', 'shader', 'glyph', 'kerning', 'deterministic', 'compositor', 'audio', 'scene'];
  for (let i = 0; i < 24; i++) {
    const col = i % 3;
    const row = Math.floor(i / 3);
    const text = Array.from({ length: 24 }, (_, w) => words[Math.floor(rnd('text', i, w) * words.length)] ?? 'frame').join(' ');
    nodes.push({
      id: `t${String(i)}`,
      type: 'text',
      text,
      width: 540 * s,
      fontSize: 20 * s,
      lineHeight: 1.3,
      fontWeight: i % 2 === 0 ? 400 : 700,
      textAlign: i % 3 === 0 ? 'left' : 'center',
      x: (100 + col * 580) * s,
      y: keyframes((160 + row * 110) * s + 20 * s, (160 + row * 110) * s, opts.frames),
      opacity: keyframes(0.3, 1, opts.frames),
      fill: color('text', i),
    });
  }
  return { project: { schemaVersion: SCHEMA_VERSION, compositions: [composition('main', opts, nodes)] }, compositionId: 'main' };
}

function vectorHeavy(opts: ScenarioOptions, s: number): ScenarioProject {
  const res = RESOLUTIONS[opts.resolution];
  const star = 'M 50 0 L 61 35 L 98 35 L 68 57 L 79 91 L 50 70 L 21 91 L 32 57 L 2 35 L 39 35 Z';
  const nodes: unknown[] = [];
  for (let i = 0; i < 600; i++) {
    const x = rnd('vec', i, 'x') * (res.width - 120 * s);
    const y = rnd('vec', i, 'y') * (res.height - 120 * s);
    const size = (20 + rnd('vec', i, 'size') * 80) * s;
    const rotation = keyframes(0, (rnd('vec', i, 'rot') - 0.5) * 360, opts.frames);
    const fill = color('vec', i);
    switch (i % 4) {
      case 0:
        nodes.push({ id: `v${String(i)}`, type: 'rect', x, y, width: size, height: size * 0.6, cornerRadius: 8 * s, rotation, fill: { type: 'linear', stops: [{ offset: 0, color: fill }, { offset: 1, color: '#101522' }] } });
        break;
      case 1:
        nodes.push({ id: `v${String(i)}`, type: 'ellipse', x, y, width: size, height: size, rotation, fill, stroke: '#FFFFFF', strokeWidth: 2 * s });
        break;
      case 2:
        nodes.push({ id: `v${String(i)}`, type: 'path', d: star, x, y, scale: { x: size / 100, y: size / 100 }, rotation, fill, stroke: '#0B0D12', strokeWidth: 1.5 });
        break;
      default:
        nodes.push({ id: `v${String(i)}`, type: 'line', from: { x: 0, y: 0 }, to: { x: size, y: size * 0.4 }, x, y, rotation, stroke: fill, strokeWidth: 3 * s });
    }
  }
  return { project: { schemaVersion: SCHEMA_VERSION, compositions: [composition('main', opts, nodes)] }, compositionId: 'main' };
}

async function imageHeavy(opts: ScenarioOptions, s: number): Promise<ScenarioProject> {
  const res = RESOLUTIONS[opts.resolution];
  const assets: Json[] = [];
  for (let i = 0; i < 16; i++) {
    const file = join('assets', `img-${String(i)}.png`);
    await writeFile(join(opts.projectDir, file), generateImage(i, 512));
    assets.push({ id: `img${String(i)}`, type: 'image', src: file });
  }
  const nodes: unknown[] = [];
  for (let i = 0; i < 60; i++) {
    const size = (160 + rnd('imgnode', i, 'size') * 160) * s;
    nodes.push({
      id: `i${String(i)}`,
      type: 'image',
      asset: `img${String(i % 16)}`,
      fit: 'cover',
      width: size,
      height: size * 0.75,
      x: rnd('imgnode', i, 'x') * (res.width - size),
      y: rnd('imgnode', i, 'y') * (res.height - size),
      rotation: keyframes(0, (rnd('imgnode', i, 'rot') - 0.5) * 60, opts.frames),
      opacity: keyframes(0.6, 1, opts.frames),
    });
  }
  return { project: { schemaVersion: SCHEMA_VERSION, assets, compositions: [composition('main', opts, nodes)] }, compositionId: 'main' };
}

async function videoHeavy(opts: ScenarioOptions, s: number): Promise<ScenarioProject> {
  const res = RESOLUTIONS[opts.resolution];
  const seconds = Math.ceil(Math.max(res.fps, opts.frames) / res.fps) + 1;
  const assets: Json[] = [];
  for (let i = 0; i < 4; i++) {
    const file = join('assets', `clip-${String(i)}.mp4`);
    // `mpeg4` ist in jedem FFmpeg-Build enthalten; ein Thread hält die Datei bitgleich.
    await runFfmpeg(ffmpegProgram(opts.ffmpeg), ['-f', 'lavfi', '-i', `testsrc2=size=640x360:rate=${String(res.fps)}:duration=${String(seconds)}`, '-vf', `hue=h=${String(i * 90)}`, '-c:v', 'mpeg4', '-q:v', '4', '-threads', '1', '-pix_fmt', 'yuv420p', join(opts.projectDir, file)]);
    assets.push({ id: `clip${String(i)}`, type: 'video', src: file });
  }
  const nodes: unknown[] = [];
  const cw = res.width / 3;
  const ch = res.height / 3;
  for (let i = 0; i < 9; i++) {
    nodes.push({ id: `video${String(i)}`, type: 'video', asset: `clip${String(i % 4)}`, fit: 'cover', loop: true, muted: true, startFrom: i * 5, x: (i % 3) * cw + 8 * s, y: Math.floor(i / 3) * ch + 8 * s, width: cw - 16 * s, height: ch - 16 * s });
  }
  return { project: { schemaVersion: SCHEMA_VERSION, assets, compositions: [composition('main', opts, nodes)] }, compositionId: 'main' };
}

function threeDHeavy(opts: ScenarioOptions): ScenarioProject {
  const res = RESOLUTIONS[opts.resolution];
  const geometries: Json[] = [{ type: 'box' }, { type: 'sphere', radius: 0.6 }, { type: 'torus', radius: 0.5, tube: 0.2 }, { type: 'torus-knot', radius: 0.45, tube: 0.15 }, { type: 'cone', radius: 0.5, height: 1 }, { type: 'capsule', radius: 0.3, length: 0.6 }];
  const children: unknown[] = [
    { id: 'cam', type: 'camera3d', position: [0, 3, 12], target: [0, 0, 0], fov: 50 },
    { id: 'amb', type: 'light3d', kind: 'ambient', intensity: 0.4 },
    { id: 'sun', type: 'light3d', kind: 'directional', position: [4, 8, 6], intensity: 2.5 },
    { id: 'fill', type: 'light3d', kind: 'point', position: [-5, 2, 4], intensity: 20, color: '#7F5AF0' },
  ];
  for (let i = 0; i < 48; i++) {
    const col = i % 8;
    const row = Math.floor(i / 8);
    children.push({
      id: `m${String(i)}`,
      type: 'mesh3d',
      geometry: geometries[i % geometries.length],
      position: [(col - 3.5) * 1.7, (row - 2.5) * 1.5, 0],
      rotation: keyframes([0, 0, 0], [rnd('3d', i, 'x') * 180, rnd('3d', i, 'y') * 360, 0], opts.frames),
      material: { color: color('3d', i), metalness: rnd('3d', i, 'metal'), roughness: 0.2 + rnd('3d', i, 'rough') * 0.6 },
    });
  }
  const nodes = [{ id: 'scene', type: 'scene3d', width: res.width, height: res.height, backend: 'webgl2', camera: 'cam', background: '#101522', children }];
  return { project: { schemaVersion: SCHEMA_VERSION, compositions: [composition('main', opts, nodes)] }, compositionId: 'main' };
}

function mixed(opts: ScenarioOptions, s: number): ScenarioProject {
  const res = RESOLUTIONS[opts.resolution];
  const nodes = [
    { id: 'grad', type: 'rect', width: res.width, height: res.height, fill: { type: 'radial', stops: [{ offset: 0, color: '#2B3A67' }, { offset: 1, color: '#101522' }] } },
    {
      id: 'scene',
      type: 'scene3d',
      width: 1000 * s,
      height: 1000 * s,
      x: 880 * s,
      y: 40 * s,
      backend: 'webgl2',
      camera: 'cam',
      children: [
        { id: 'cam', type: 'camera3d', position: [0, 1.2, 4], target: [0, 0, 0], fov: 45 },
        { id: 'amb', type: 'light3d', kind: 'ambient', intensity: 0.4 },
        { id: 'sun', type: 'light3d', kind: 'directional', position: [3, 5, 2], intensity: 3 },
        { id: 'knot', type: 'mesh3d', geometry: { type: 'torus-knot', radius: 0.8, tube: 0.25 }, material: { color: '#FF5A1F', metalness: 0.3, roughness: 0.35 }, rotation: keyframes([0, 0, 0], [0, 180, 0], opts.frames) },
      ],
    },
    {
      id: 'card',
      type: 'html',
      x: 90 * s,
      y: 270 * s,
      width: 780 * s,
      height: 420 * s,
      html: '<div class="card"><h1>HTML</h1><p>CSS in Chromium</p></div>',
      css: `.card{height:100%;box-sizing:border-box;padding:${String(50 * s)}px;border-radius:${String(44 * s)}px;background:linear-gradient(135deg,#7F5AF0,#2CB67D);color:white;font-family:Inter,sans-serif}h1{margin:0;font-size:${String(110 * s)}px}p{margin:0;font-size:${String(50 * s)}px}`,
    },
    { id: 'glow', type: 'layer', blendMode: 'screen', opacity: 0.8, effects: [{ type: 'blur', radius: 16 * s }], children: [{ id: 'bar', type: 'rect', x: 90 * s, y: 780 * s, width: keyframes(100 * s, 780 * s, opts.frames), height: 34 * s, cornerRadius: 17 * s, fill: '#2CB67D' }] },
    { id: 'caption', type: 'text', text: 'Skia + Chromium + Three.js + Compositor', fontSize: 48 * s, x: 100 * s, y: 880 * s, fill: '#FFFFFF' },
  ];
  return { project: { schemaVersion: SCHEMA_VERSION, compositions: [composition('main', opts, nodes)] }, compositionId: 'main' };
}

async function audioHeavy(opts: ScenarioOptions, s: number): Promise<ScenarioProject> {
  const res = RESOLUTIONS[opts.resolution];
  const frames = Math.max(res.fps, opts.frames + 1);
  const seconds = frames / res.fps;
  const ffmpeg = ffmpegProgram(opts.ffmpeg);
  const tones: readonly [string, string][] = [
    ['music', `sine=f=220:d=${String(Math.ceil(seconds) + 1)}`],
    ['voice', 'sine=f=440:d=1'],
    ['blip', 'sine=f=1200:d=0.1'],
  ];
  for (const [id, source] of tones) await runFfmpeg(ffmpeg, ['-f', 'lavfi', '-i', source, '-ar', '48000', join(opts.projectDir, 'assets', `${id}.wav`)]);
  const voiceClips = Array.from({ length: Math.max(4, Math.floor(seconds * 2)) }, (_, i) => ({ id: `vo${String(i)}`, source: 'voice', start: Math.round((i * res.fps) / 2), duration: Math.round(res.fps * 0.3), fadeIn: 2, fadeOut: 2 }));
  const sfxClips = Array.from({ length: Math.max(24, Math.floor(seconds * 12)) }, (_, i) => ({ id: `sfx${String(i)}`, source: 'blip', start: Math.floor((i * frames) / Math.max(24, Math.floor(seconds * 12))), volume: 0.3 + rnd('sfx', i) * 0.5, pan: i % 2 === 0 ? -0.6 : 0.6 }));
  const bars = Array.from({ length: 12 }, (_, i) => ({ id: `bar${String(i)}`, type: 'rect', x: (160 + i * 135) * s, y: 300 * s, width: 90 * s, height: keyframes(80 * s, (200 + rnd('bar', i) * 500) * s, opts.frames), cornerRadius: 12 * s, fill: color('bar', i) }));
  const project = {
    schemaVersion: SCHEMA_VERSION,
    assets: tones.map(([id]) => ({ id: `${id}-file`, type: 'audio', src: join('assets', `${id}.wav`) })),
    audio: tones.map(([id]) => ({ id, asset: `${id}-file` })),
    compositions: [
      composition('main', opts, [{ id: 'title', type: 'text', text: 'Benchmark: audio-heavy', fontSize: 72 * s, x: 160 * s, y: 120 * s, fill: '#FFFFFF' }, ...bars], {
        audio: { sampleRate: 48000, loudness: -16, limiter: { ceiling: -1 } },
        tracks: [
          {
            id: 'music-track',
            kind: 'audio',
            role: 'music',
            clips: [{ id: 'bed', source: 'music', start: 0, loop: true, volume: 0.8, fadeIn: 5 }],
            eq: [{ type: 'lowshelf', frequency: 120, gain: 3 }, { type: 'peak', frequency: 2500, gain: -2, q: 1 }],
            compressor: { threshold: -18, ratio: 3, attack: 10, release: 120 },
            ducking: { by: 'voice-track', amount: -12 },
          },
          { id: 'voice-track', kind: 'audio', role: 'voiceover', clips: voiceClips, compressor: { threshold: -20, ratio: 4 } },
          { id: 'sfx-track', kind: 'audio', role: 'sfx', clips: sfxClips, limiter: { ceiling: -3 } },
        ],
      }),
    ],
  };
  return { project, compositionId: 'main' };
}

/**
 * Erzeugt Projekt und Assets eines Szenarios im Projektordner.
 *
 * @example
 * ```ts
 * const { project } = await buildScenario({ scenario: 'vector-heavy', resolution: '1080p30', frames: 10, projectDir: dir });
 * ```
 */
export async function buildScenario(opts: ScenarioOptions): Promise<ScenarioProject> {
  await mkdir(join(opts.projectDir, 'assets'), { recursive: true });
  const s = RESOLUTIONS[opts.resolution].width / 1920;
  let built: ScenarioProject;
  switch (opts.scenario) {
    case 'text-heavy':
      built = textHeavy(opts, s);
      break;
    case 'vector-heavy':
      built = vectorHeavy(opts, s);
      break;
    case 'image-heavy':
      built = await imageHeavy(opts, s);
      break;
    case 'video-heavy':
      built = await videoHeavy(opts, s);
      break;
    case '3d-heavy':
      built = threeDHeavy(opts);
      break;
    case 'mixed':
      built = mixed(opts, s);
      break;
    case 'audio-heavy':
      built = await audioHeavy(opts, s);
      break;
  }
  return built;
}

/**
 * Erzeugt ein Projekt mit vielen kleinen PNG-Assets, je eines pro Image-Node (Skalierungstest).
 *
 * @example
 * ```ts
 * const project = await buildManyAssetsProject(dir, 1000);
 * ```
 */
export async function buildManyAssetsProject(projectDir: string, count: number): Promise<Json> {
  await mkdir(join(projectDir, 'assets'), { recursive: true });
  const assets: Json[] = [];
  const nodes: Json[] = [];
  const cols = Math.ceil(Math.sqrt((count * 16) / 9));
  const rows = Math.ceil(count / cols);
  const cw = 1920 / cols;
  const ch = 1080 / rows;
  for (let i = 0; i < count; i++) {
    const file = join('assets', `a-${String(i)}.png`);
    await writeFile(join(projectDir, file), generateImage(i, 16));
    assets.push({ id: `a${String(i)}`, type: 'image', src: file });
    nodes.push({ id: `n${String(i)}`, type: 'image', asset: `a${String(i)}`, x: (i % cols) * cw, y: Math.floor(i / cols) * ch, width: cw - 1, height: ch - 1 });
  }
  return { schemaVersion: SCHEMA_VERSION, assets, compositions: [{ id: 'main', width: 1920, height: 1080, fps: 30, duration: 30, background: '#000000', nodes }] };
}
