// Native Laufzeit (Rückfall oder ausdrücklich gewählt): Node.js auf dem Host, wie vor ADR 0029.
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';

const MIN_NODE = [22, 13];

/** Prüft Node-Version und FFmpeg; liefert Meldungen oder `undefined` je Punkt. */
export function nativeProblems(env, platform = process.platform) {
  const [major, minor] = process.versions.node.split('.').map(Number);
  const node = major > MIN_NODE[0] || (major === MIN_NODE[0] && minor >= MIN_NODE[1]) ? undefined : `Node ${process.versions.node} is too old; OpenVideo needs Node ${MIN_NODE.join('.')} or newer (https://nodejs.org, or nvm install 22).`;
  const cmd = env.OPENVIDEO_FFMPEG ?? 'ffmpeg';
  const r = spawnSync(cmd, ['-version'], { encoding: 'utf8', env });
  const hint = platform === 'darwin' ? 'brew install ffmpeg' : platform === 'win32' ? 'winget install Gyan.FFmpeg' : 'sudo apt-get install -y ffmpeg   (Debian/Ubuntu; other distros: package "ffmpeg")';
  const ffmpeg = r.status === 0 ? undefined : `FFmpeg not found. Install it: ${hint} (or set OPENVIDEO_FFMPEG and OPENVIDEO_FFPROBE).`;
  return { node, ffmpeg };
}

/** Schritte: npm ci, build, Chromium, globaler Link, doctor (Schalter wie bisher). */
export function nativeSteps(root, opts, platform = process.platform) {
  const npm = platform === 'win32' ? 'npm.cmd' : 'npm';
  const npx = platform === 'win32' ? 'npx.cmd' : 'npx';
  const steps = [];
  if (!opts.skipInstall) steps.push({ name: 'install', cmd: npm, argv: ['ci'] });
  if (!opts.skipBuild) steps.push({ name: 'build', cmd: npm, argv: ['run', 'build'] });
  if (!opts.skipBrowser) steps.push({ name: 'browser', cmd: npx, argv: ['playwright', 'install', ...(opts.withDeps ? ['--with-deps'] : []), 'chromium', 'chromium-headless-shell'] });
  if (!opts.noLink) steps.push({ name: 'link', cmd: npm, argv: ['install', '-g', './packages/cli'], optional: true });
  steps.push({ name: 'doctor', cmd: process.execPath, argv: [join(root, 'packages', 'cli', 'dist', 'bin.js'), 'doctor'], optional: true });
  return steps;
}
