#!/usr/bin/env node
// Richtet OpenVideo aus dem Quellcode ein (npm run setup): Voraussetzungen prüfen, Abhängigkeiten
// installieren, bauen, Chromium laden, den Befehl `openvideo` global verlinken und `doctor` ausführen.
// Die Pakete werden bewusst nicht auf npm veröffentlicht; jeder baut sie selbst (SETUP.md).
//
// Optionen:
//   --dry-run        nur den Plan als JSON ausgeben, nichts ausführen
//   --skip-install   `npm ci` überspringen
//   --skip-build     `npm run build` überspringen
//   --skip-browser   Chromium nicht laden
//   --with-deps      Chromium samt Systembibliotheken laden (Linux, braucht root/sudo)
//   --no-link        `openvideo` nicht global verlinken (dann Alias nutzen, siehe Ausgabe)
import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const BIN = join(ROOT, 'packages', 'cli', 'dist', 'bin.js');
const MIN_NODE = [22, 13];
const NPM = process.platform === 'win32' ? 'npm.cmd' : 'npm';
const NPX = process.platform === 'win32' ? 'npx.cmd' : 'npx';

const args = new Set(process.argv.slice(2));
const known = ['--dry-run', '--skip-install', '--skip-build', '--skip-browser', '--with-deps', '--no-link', '--help'];
for (const a of args) {
  if (!known.includes(a)) {
    process.stderr.write(`Unknown option ${a}. Known: ${known.join(', ')}\n`);
    process.exit(2);
  }
}
if (args.has('--help')) {
  process.stdout.write('Usage: npm run setup -- [--dry-run] [--skip-install] [--skip-build] [--skip-browser] [--with-deps] [--no-link]\n');
  process.exit(0);
}

/** Prüft die Node-Version; liefert eine Meldung oder undefined. */
function nodeProblem() {
  const [major, minor] = process.versions.node.split('.').map(Number);
  if (major > MIN_NODE[0] || (major === MIN_NODE[0] && minor >= MIN_NODE[1])) return undefined;
  return `Node ${process.versions.node} is too old; OpenVideo needs Node ${MIN_NODE.join('.')} or newer (https://nodejs.org, or nvm install 22).`;
}

/** Sucht FFmpeg über OPENVIDEO_FFMPEG oder PATH. */
function ffmpegFound() {
  const cmd = process.env['OPENVIDEO_FFMPEG'] ?? 'ffmpeg';
  const r = spawnSync(cmd, ['-version'], { encoding: 'utf8' });
  return r.status === 0 ? (r.stdout.split('\n')[0] ?? cmd) : undefined;
}

function ffmpegHint() {
  if (process.platform === 'darwin') return 'brew install ffmpeg';
  if (process.platform === 'win32') return 'winget install Gyan.FFmpeg';
  return 'sudo apt-get install -y ffmpeg   (Debian/Ubuntu; other distros: package "ffmpeg")';
}

const steps = [];
if (!args.has('--skip-install')) steps.push({ name: 'install', cmd: NPM, argv: ['ci'] });
if (!args.has('--skip-build')) steps.push({ name: 'build', cmd: NPM, argv: ['run', 'build'] });
if (!args.has('--skip-browser')) {
  steps.push({ name: 'browser', cmd: NPX, argv: ['playwright', 'install', ...(args.has('--with-deps') ? ['--with-deps'] : []), 'chromium', 'chromium-headless-shell'] });
}
if (!args.has('--no-link')) steps.push({ name: 'link', cmd: NPM, argv: ['install', '-g', './packages/cli'], optional: true });
steps.push({ name: 'doctor', cmd: process.execPath, argv: [BIN, 'doctor'], optional: true });

const problems = { node: nodeProblem(), ffmpeg: ffmpegFound() === undefined ? `FFmpeg not found. Install it: ${ffmpegHint()} (or set OPENVIDEO_FFMPEG and OPENVIDEO_FFPROBE).` : undefined };

if (args.has('--dry-run')) {
  process.stdout.write(`${JSON.stringify({ root: ROOT, problems, steps: steps.map((s) => ({ name: s.name, command: [s.name === 'doctor' ? 'node' : s.cmd, ...s.argv].join(' '), optional: s.optional === true })) }, null, 2)}\n`);
  process.exit(0);
}

if (problems.node !== undefined) {
  process.stderr.write(`${problems.node}\n`);
  process.exit(1);
}
if (problems.ffmpeg !== undefined) process.stderr.write(`Warning: ${problems.ffmpeg} Rendering videos needs it; the build continues.\n`);

let linked = false;
for (const step of steps) {
  process.stdout.write(`\n==> ${step.name}: ${[step.cmd, ...step.argv].join(' ')}\n`);
  const r = spawnSync(step.cmd, step.argv, { cwd: ROOT, stdio: 'inherit', shell: process.platform === 'win32' });
  if (r.status === 0) {
    if (step.name === 'link') linked = true;
    continue;
  }
  if (step.name === 'link') {
    process.stdout.write('Linking `openvideo` globally failed (often missing write access to the global npm folder). Use an alias instead:\n');
    continue;
  }
  if (step.optional === true) continue;
  process.stderr.write(`Step "${step.name}" failed. Fix the error above and run \`npm run setup\` again (finished steps can be skipped with --skip-install/--skip-build/--skip-browser).\n`);
  process.exit(1);
}

process.stdout.write('\nOpenVideo is set up.\n');
if (linked) {
  process.stdout.write('The command `openvideo` is on your PATH (try: openvideo --help).\n');
} else {
  const alias = process.platform === 'win32' ? `doskey openvideo=node "${BIN}" $*` : `alias openvideo="node ${BIN}"`;
  process.stdout.write(`Make the command available with:\n  ${alias}\n`);
}
process.stdout.write('Next: openvideo create hello && cd hello && openvideo render-frame --frame 1s --out out/frame.png\n');
