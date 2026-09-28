#!/usr/bin/env node
// Baut die Templates: erzeugt die Wellenform des Test-Tons, prüft die TSX-Quellen mit
// TypeScript und kompiliert jede `src/video.tsx` zur IR in `project.json`.
// Die Templates sind eigener Code; deshalb läuft der Compiler im Modus `trusted-host`.
//
// Aufruf: `npm run build:extra -w @agentic-video/templates` (alle) oder
// `node scripts/build-templates.mjs logo-reveal` (nur die genannten Templates).
// Setzt ein gebautes `@agentic-video/compiler` (dist) voraus: erst `tsc -b`, dann dieses Skript.
import { spawnSync } from 'node:child_process';
import { readdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { compileTsx, exportJson } from '@agentic-video/compiler';

const pkg = join(dirname(fileURLToPath(import.meta.url)), '..');
const templatesDir = join(pkg, 'templates');
const root = join(pkg, '..', '..');

// ---------------------------------------------------------------------------
// 1. Test-Ton für `podcast-clip`: synthetisiert, dann RMS-Amplitude je Frame.
// ---------------------------------------------------------------------------

/**
 * Erzeugt einen Test-Ton (Sprach-ähnliche Silben aus zwei Sinustönen mit Hüllkurve)
 * und liefert die RMS-Amplitude je Videoframe, normiert auf 0..1.
 * Der Ton ist vollständig deterministisch: kein Zufall, nur feste Formeln.
 */
function testToneAmplitudes({ seconds, fps, sampleRate }) {
  const total = Math.round(seconds * sampleRate);
  const samples = new Float64Array(total);
  for (let i = 0; i < total; i++) {
    const t = i / sampleRate;
    // Silben: 3,2 Hz Hüllkurve, Phrasen: 0,35 Hz, kurze Pausen nach jeder Phrase.
    const syllable = Math.pow(Math.max(0, Math.sin(Math.PI * 3.2 * t)), 1.5);
    const phrase = 0.55 + 0.45 * Math.sin(2 * Math.PI * 0.35 * t + 0.6);
    const pause = (t % 2.9) > 2.55 ? 0.08 : 1;
    const envelope = syllable * phrase * pause;
    samples[i] = envelope * (0.7 * Math.sin(2 * Math.PI * 180 * t) + 0.3 * Math.sin(2 * Math.PI * 360 * t + 1.1));
  }
  const perFrame = sampleRate / fps;
  const frames = Math.round(seconds * fps);
  const rms = [];
  for (let f = 0; f < frames; f++) {
    let sum = 0;
    const start = Math.floor(f * perFrame);
    const end = Math.min(total, Math.floor((f + 1) * perFrame));
    for (let i = start; i < end; i++) sum += samples[i] * samples[i];
    rms.push(Math.sqrt(sum / Math.max(1, end - start)));
  }
  const max = Math.max(...rms);
  return rms.map((v) => Math.round((v / max) * 1000) / 1000);
}

const GENERATED = '// Erzeugt von scripts/build-templates.mjs';

function writeWaveform() {
  const target = join(templatesDir, 'podcast-clip', 'src', 'waveform.ts');
  if (!existsSync(dirname(target))) return;
  // Eigene Amplituden (ohne Kopfzeile) bleiben unangetastet.
  if (existsSync(target) && !readFileSync(target, 'utf8').startsWith(GENERATED)) return;
  const fps = 30;
  const amplitudes = testToneAmplitudes({ seconds: 12, fps, sampleRate: 16000 });
  const rows = [];
  for (let i = 0; i < amplitudes.length; i += 15) rows.push(`  ${amplitudes.slice(i, i + 15).join(', ')},`);
  const source = [
    `${GENERATED} – nicht von Hand ändern.`,
    '// RMS-Amplitude (0..1) je Frame eines synthetischen Test-Tons (12 s, 30 fps, 16 kHz).',
    '// Eigene Audiodatei: Amplituden je Frame berechnen und diese Liste ersetzen.',
    '',
    `/** Bilder pro Sekunde, für die die Amplituden gelten. */`,
    `export const WAVEFORM_FPS = ${fps};`,
    '',
    '/** RMS-Amplitude je Frame, normiert auf 0..1. */',
    'export const AMPLITUDES: readonly number[] = [',
    ...rows,
    '];',
    '',
  ].join('\n');
  writeFileSync(target, source);
}

// ---------------------------------------------------------------------------
// 2. TypeScript-Prüfung der TSX-Quellen
// ---------------------------------------------------------------------------

function typecheck() {
  const tsc = join(root, 'node_modules', 'typescript', 'bin', 'tsc');
  const r = spawnSync(process.execPath, [tsc, '-p', join(pkg, 'tsconfig.templates.json')], { stdio: 'inherit' });
  if (r.status !== 0) {
    console.error('TypeScript-Prüfung der Templates fehlgeschlagen.');
    process.exit(r.status ?? 1);
  }
}

// ---------------------------------------------------------------------------
// 3. TSX → project.json
// ---------------------------------------------------------------------------

async function compileAll() {
  const only = process.argv.slice(2);
  const names = readdirSync(templatesDir, { withFileTypes: true })
    .filter((d) => d.isDirectory() && (only.length === 0 || only.includes(d.name)))
    .map((d) => d.name)
    .sort();
  let failed = false;
  for (const name of names) {
    const dir = join(templatesDir, name);
    const { project, diagnostics } = await compileTsx('src/video.tsx', { projectDir: dir, mode: 'trusted-host' });
    for (const d of diagnostics) console.error(`${name}: ${d.severity} ${d.code}: ${d.problem}`);
    if (diagnostics.some((d) => d.severity === 'error')) {
      failed = true;
      continue;
    }
    writeFileSync(join(dir, 'project.json'), exportJson(project));
    console.log(`${name}: project.json geschrieben`);
  }
  if (failed) process.exit(1);
}

writeWaveform();
typecheck();
await compileAll();
