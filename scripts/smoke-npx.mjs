#!/usr/bin/env node
// Smoke-Test der npm-Pakete (Story 22.7, T3): packt alle veröffentlichten Pakete mit `npm pack`,
// installiert die Tarballs in ein leeres Verzeichnis (wie ein Nutzer nach `npm install`) und führt
// `openvideo create`, `validate` und `render-frame` aus. So fällt auf, wenn eine Datei in `files`
// fehlt, eine Abhängigkeit nur im Monorepo auflösbar ist oder das Studio nicht im CLI-Paket liegt.
//
//   npm run build && node scripts/smoke-npx.mjs [--keep]
//
// Braucht Netzzugriff auf die npm-Registry (Drittabhängigkeiten) und FFmpeg nur für `doctor`, nicht
// für die geprüften Befehle. Veröffentlicht nichts.
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { publishedPackages, root } from './release-packages.mjs';

const keep = process.argv.includes('--keep');
const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';

function step(title) {
  process.stdout.write(`\n== ${title}\n`);
}

function run(cmd, args, cwd, options = {}) {
  const r = spawnSync(cmd, args, { cwd, encoding: 'utf8', stdio: options.capture === true ? 'pipe' : 'inherit', env: { ...process.env, npm_config_audit: 'false', npm_config_fund: 'false', npm_config_update_notifier: 'false' }, maxBuffer: 1 << 28 });
  if (r.status !== 0) {
    if (options.capture === true) process.stderr.write(`${r.stdout ?? ''}${r.stderr ?? ''}`);
    throw new Error(`${cmd} ${args.join(' ')} failed with exit code ${String(r.status)} in ${cwd}`);
  }
  return r.stdout ?? '';
}

function fail(message) {
  throw new Error(message);
}

const work = mkdtempSync(join(tmpdir(), 'ov-smoke-npx-'));
try {
  step('Build vorhanden?');
  for (const f of ['packages/cli/dist/bin.js', 'packages/cli/studio/index.html', 'packages/core/dist/index.js']) {
    if (!existsSync(join(root, f))) fail(`${f} is missing. Run "npm run build" first.`);
  }

  step('npm pack (alle veröffentlichten Pakete)');
  const packages = publishedPackages();
  const tarballs = join(work, 'tarballs');
  mkdirSync(tarballs);
  const packed = JSON.parse(run(npm, ['pack', '--json', '--pack-destination', tarballs, ...packages.flatMap((p) => ['-w', p.dir])], root, { capture: true }));
  if (packed.length !== packages.length) fail(`npm pack produced ${String(packed.length)} tarballs for ${String(packages.length)} packages.`);
  const cli = packed.find((p) => p.name === '@agentic-video/cli');
  if (cli === undefined) fail('No tarball for @agentic-video/cli.');
  if (!cli.files.some((f) => f.path === 'studio/index.html')) fail('The @agentic-video/cli tarball does not contain studio/index.html.');
  for (const p of packed) {
    if (!p.files.some((f) => f.path.startsWith('dist/'))) fail(`${p.name}: tarball contains no dist/ files.`);
    if (p.files.some((f) => /(^|\/)(test|src)\//u.test(f.path) && !f.path.startsWith('templates/'))) fail(`${p.name}: tarball contains test/ or src/ files.`);
  }
  process.stdout.write(`${String(packed.length)} tarballs, CLI ${String(Math.round(cli.size / 1024))} KiB (with Studio).\n`);

  step('Installation in ein leeres Verzeichnis');
  const app = join(work, 'app');
  mkdirSync(app);
  writeFileSync(join(app, 'package.json'), `${JSON.stringify({ name: 'openvideo-smoke', version: '1.0.0', private: true, type: 'module' }, null, 2)}\n`);
  const files = readdirSync(tarballs).filter((f) => f.endsWith('.tgz')).map((f) => join(tarballs, f));
  run(npm, ['install', '--no-package-lock', '--loglevel', 'error', ...files], app);
  const installed = join(app, 'node_modules', '@agentic-video', 'cli');
  if (!existsSync(join(installed, 'studio', 'index.html'))) fail('Installed @agentic-video/cli has no studio/index.html.');
  // Keine Auflösung zurück ins Monorepo: Jede @agentic-video-Abhängigkeit liegt im neuen node_modules.
  for (const p of packages) if (!existsSync(join(app, 'node_modules', ...p.pkg.name.split('/'), 'package.json'))) fail(`${p.pkg.name} was not installed.`);

  const openvideo = (args) => run(npm, ['exec', '--no', '--', 'openvideo', ...args], app, { capture: true });

  step('openvideo --help');
  const help = openvideo(['--help']);
  if (!help.includes('render-frame')) fail('openvideo --help does not list render-frame.');

  step('openvideo create demo');
  process.stdout.write(openvideo(['create', 'demo']));
  if (!existsSync(join(app, 'demo', 'project.json'))) fail('openvideo create did not write demo/project.json.');

  step('openvideo validate demo');
  const validation = JSON.parse(openvideo(['validate', 'demo', '--json']));
  const errors = (validation.diagnostics ?? []).filter((d) => d.severity === 'error');
  if (errors.length > 0) fail(`openvideo validate reported errors: ${JSON.stringify(errors)}`);
  process.stdout.write('valid\n');

  step('openvideo render-frame demo --frame 1s');
  const png = join(app, 'demo', 'frame.png');
  process.stdout.write(openvideo(['render-frame', 'demo', '--frame', '1s', '--out', png]));
  if (!existsSync(png) || statSync(png).size < 1000) fail('render-frame did not write a PNG.');
  if (!readFileSync(png).subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) fail('render-frame output is not a PNG.');

  process.stdout.write(`\nSmoke test passed (${work}).\n`);
} catch (error) {
  process.stderr.write(`\nSmoke test FAILED: ${error instanceof Error ? error.message : String(error)}\nWork directory: ${work}\n`);
  process.exitCode = 1;
} finally {
  if (!keep && process.exitCode !== 1) rmSync(work, { recursive: true, force: true });
}
