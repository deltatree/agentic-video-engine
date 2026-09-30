// Stub-Programme für die Tests von `npm run setup` (ADR 0029): docker, podman, kubectl, kind, minikube, k3d,
// k3s, nerdctl, buildah … als kleine Node-Skripte in einem eigenen PATH. Jeder Aufruf wird als JSON-Zeile
// protokolliert (Programm, Argumente, Arbeitsordner, ausgewählte Umgebung); die Antworten kommen aus einer
// Tabelle (längstes passendes Argument-Präfix gewinnt).
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/** Basisprogramme, die Wrapper und Setup brauchen (aus dem System verlinkt, ohne docker & Co.). */
const SYSTEM_TOOLS = ['sh', 'id', 'env', 'sed', 'cat', 'mkdir', 'cksum', 'cut', 'tar', 'find', 'rm', 'touch', 'basename', 'dirname', 'printf', 'ls'];

const FAKE = `#!${process.execPath}
// Stub für Setup-Tests.
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const name = path.basename(process.argv[1]);
const args = process.argv.slice(2);
const pick = ['OPENVIDEO_API_TOKEN', 'OPENVIDEO_WORKERS', 'DOCKER_BUILDKIT'];
const env = Object.fromEntries(pick.filter((k) => process.env[k] !== undefined).map((k) => [k, process.env[k]]));
fs.appendFileSync(process.env.FAKE_LOG, JSON.stringify({ name, args, cwd: process.cwd(), env, stdinTty: process.stdin.isTTY === true }) + '\\n');
const table = JSON.parse(fs.readFileSync(process.env.FAKE_TABLE, 'utf8'))[name] ?? {};
// Schlüssel = Anfang der Argumente, durch Leerzeichen getrennt; '*' steht für genau ein Argument.
// Ein Argument mit Leerzeichen (z. B. '{{json .Runtimes}}') entspricht mehreren Wörtern des Schlüssels.
const matches = (key) => {
  const parts = key === '' ? [] : key.split(' ');
  let i = 0;
  for (const arg of args) {
    if (i >= parts.length) return true;
    if (parts[i] === '*') { i++; continue; }
    for (const word of arg.split(' ')) {
      if (parts[i] !== word) return false;
      i++;
    }
  }
  return i >= parts.length;
};
let best;
for (const [key, value] of Object.entries(table)) {
  if (matches(key) && (best === undefined || key.length > best[0])) best = [key.length, value];
}
const r = best?.[1] ?? { status: 0 };
if (r.pod === true) {
  // kubectl exec … -- sh -c SCRIPT sh REMOTE …: im Ordner FAKE_POD ausführen (simulierter Pod).
  const at = args.indexOf('--');
  const rest = args.slice(at + 1);
  const mapped = rest.map((a) => (a.startsWith('/var/cache/openvideo/') ? path.join(process.env.FAKE_POD, a) : a));
  const res = spawnSync(mapped[0], mapped.slice(1), { stdio: 'inherit', env: { ...process.env, PATH: process.env.FAKE_POD_PATH } });
  process.exit(res.status ?? 1);
}
if (r.echoStdin === true) process.stdin.pipe(process.stdout);
if (r.stdout !== undefined) process.stdout.write(r.stdout);
if (r.stderr !== undefined) process.stderr.write(r.stderr);
if (r.echoStdin !== true) process.exit(r.status ?? 0);
process.stdin.on('end', () => process.exit(r.status ?? 0));
`;

/**
 * Legt eine Test-Umgebung an: Stub-Programme `names`, Antworttabelle, Systemwerkzeuge.
 *
 * @example
 * const f = fakeEnv(['docker'], { docker: { 'info': { stdout: '29.0.0' } } });
 * spawnSync(process.execPath, ['scripts/setup.mjs', '--dry-run'], { env: f.env });
 */
export function fakeEnv(names, table = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'ov-setup-'));
  const fakebin = join(dir, 'fakebin');
  const sysbin = join(dir, 'sysbin');
  mkdirSync(fakebin);
  mkdirSync(sysbin);
  for (const n of names) {
    writeFileSync(join(fakebin, n), FAKE);
    chmodSync(join(fakebin, n), 0o755);
  }
  for (const tool of SYSTEM_TOOLS) {
    const found = ['/usr/bin', '/bin'].map((d) => join(d, tool)).find((p) => existsSync(p));
    if (found !== undefined) symlinkSync(found, join(sysbin, tool));
  }
  const log = join(dir, 'calls.jsonl');
  const tablePath = join(dir, 'table.json');
  writeFileSync(tablePath, JSON.stringify(table));
  writeFileSync(log, '');
  const home = join(dir, 'home');
  mkdirSync(home);
  const env = {
    PATH: `${fakebin}:${sysbin}`,
    HOME: home,
    FAKE_LOG: log,
    FAKE_TABLE: tablePath,
    OPENVIDEO_CONFIG_DIR: join(dir, 'config'),
  };
  return {
    dir,
    fakebin,
    sysbin,
    home,
    env,
    calls: () =>
      readFileSync(log, 'utf8')
        .split('\n')
        .filter((l) => l !== '')
        .map((l) => JSON.parse(l)),
    setTable: (t) => writeFileSync(tablePath, JSON.stringify(t)),
    /** Zusätzliches Programm mit festem Shell-Inhalt (z. B. ein falsches `openvideo` im simulierten Pod). */
    script: (bin, name, body) => {
      mkdirSync(bin, { recursive: true });
      writeFileSync(join(bin, name), `#!/bin/sh\n${body}\n`);
      chmodSync(join(bin, name), 0o755);
    },
  };
}

/** Antworten, mit denen docker/podman/kubectl „nutzbar“ sind. */
export const WORKING = {
  docker: { '--version': { stdout: 'Docker version 29.3.1, build test' }, info: { stdout: '29.3.1' }, 'image inspect --format {{.Id}}': { stdout: 'sha256:0123456789abcdef0123' } },
  podman: { info: { stdout: 'true 5.4.2' }, 'image inspect --format {{.Id}}': { stdout: 'fedcba9876543210ffff' } },
  kubectl: { 'config current-context': { stdout: 'kind-dev' }, '--context * version': { stdout: '{"serverVersion":{"gitVersion":"v1.33.1"}}' } },
};

/** Führt ein Skript mit Node aus. */
export function runNode(script, args, env, options = {}) {
  return spawnSync(process.execPath, [script, ...args], { encoding: 'utf8', env, ...options });
}
