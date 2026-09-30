// ADR 0029: Der Wrapper `openvideo` reicht Argumente unverändert durch, veröffentlicht Ports nur auf
// Loopback, hält das Token von der Kommandozeile fern und spiegelt unter Kubernetes den Projektordner.
// Geprüft mit Stub-Programmen (setup-fakes.mjs) statt echter Container.
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { skipUnless } from '@agentic-video/testing';
import { describe, expect, it } from 'vitest';
import { fakeEnv } from './setup-fakes.mjs';
import { HOST_ONLY_ENV, cmdWrapper, containerWrapper, kubernetesWrapper, powershellWrapper } from '../setup/wrapper.mjs';

const TOKEN = 'tok_0123456789abcdefghijklmnopqrstuvwxyzABCDEFG';

function container(engine = 'docker', options = {}) {
  const f = fakeEnv([engine]);
  const envFile = join(f.dir, 'api.env');
  writeFileSync(envFile, `OPENVIDEO_API_TOKEN=${TOKEN}\n`, { mode: 0o600 });
  const wrapper = join(f.dir, 'openvideo');
  writeFileSync(wrapper, containerWrapper({ engine, enginePath: join(f.fakebin, engine), image: 'openvideo-local:9.9.9', envFile, runtimeInfo: `${engine}, image openvideo-local:9.9.9`, ...options }));
  chmodSync(wrapper, 0o755);
  const work = join(f.dir, 'work dir');
  mkdirSync(work);
  const run = (args, extraEnv = {}, input = '') => {
    const r = spawnSync(wrapper, args, { cwd: work, env: { ...f.env, ...extraEnv }, encoding: 'utf8', input });
    const call = f.calls().filter((c) => c.name === engine).at(-1);
    return { ...r, call, argv: call?.args ?? [] };
  };
  return { f, wrapper, work: realpathSync(work), run, envFile };
}

/** Argumente nach dem Image = Argumente an openvideo im Container. */
const after = (argv) => argv.slice(argv.indexOf('openvideo-local:9.9.9') + 1);
const before = (argv) => argv.slice(0, argv.indexOf('openvideo-local:9.9.9'));

const scriptPath = spawnSync('sh', ['-c', 'command -v script'], { encoding: 'utf8' }).stdout.trim();
const hasScript = scriptPath !== '' && spawnSync(scriptPath, ['--version'], { encoding: 'utf8' }).status === 0;
const gnuTar = /GNU tar/u.test(spawnSync('tar', ['--version'], { encoding: 'utf8' }).stdout ?? '');

describe('Wrapper für Docker/Podman', () => {
  it('reicht Argumente mit Leerzeichen, Anführungszeichen und Shell-Zeichen unverändert durch', () => {
    const c = container();
    const tricky = ['render', 'my project', '--out', 'out/a "quoted" $(touch pwned) `x` * ; | & name.mp4', "it's", '', '--input={"a":"b c"}'];
    const r = c.run(tricky);
    expect(r.status).toBe(0);
    expect(after(r.argv)).toEqual(tricky);
    expect(existsSync(join(c.work, 'pwned'))).toBe(false);
  });

  it('startet sicher: --rm -i, --pull never, no-new-privileges, keine Capabilities, Nutzer-ID, Ordner unter gleichem Pfad', () => {
    const c = container();
    const r = c.run(['validate']);
    const b = before(r.argv);
    expect(b.slice(0, 11)).toEqual(['run', '--rm', '-i', '--pull', 'never', '--security-opt', 'no-new-privileges', '--cap-drop', 'ALL', '--shm-size', '512m']);
    expect(b).not.toContain('--privileged');
    expect(b).not.toContain('-t');
    const uid = spawnSync('id', ['-u'], { encoding: 'utf8' }).stdout.trim();
    const gid = spawnSync('id', ['-g'], { encoding: 'utf8' }).stdout.trim();
    expect(b[b.indexOf('--user') + 1]).toBe(`${uid}:${gid}`);
    expect(b).toContain(`${c.work}:${c.work}`);
    expect(b[b.indexOf('-w') + 1]).toBe(c.work);
    expect(b).toContain(`openvideo-cache-${uid}:/var/cache/openvideo`);
    expect(b).toContain('OPENVIDEO_RUNTIME_INFO=docker, image openvideo-local:9.9.9');
    expect(b).not.toContain('--env-file');
    expect(b.some((a) => a.startsWith('127.0.0.1:'))).toBe(false);
  });

  it('Podman rootless: --userns=keep-id', () => {
    const c = container('podman', { rootless: true });
    expect(before(c.run(['--help']).argv)).toContain('--userns=keep-id');
    expect(before(container('podman').run(['--help']).argv)).not.toContain('--userns=keep-id');
  });

  it('reicht OPENVIDEO_* nur mit Namen durch, außer Host-Pfaden; Werte nie auf der Kommandozeile', () => {
    const c = container();
    const r = c.run(['render'], { OPENVIDEO_WORKERS: '3', OPENVIDEO_FFMPEG: '/opt/ffmpeg', OPENVIDEO_API_TOKEN: 'host-token-should-not-leak' });
    const b = before(r.argv);
    expect(b).toContain('OPENVIDEO_WORKERS');
    expect(b.join(' ')).not.toContain('OPENVIDEO_FFMPEG');
    expect(b.join(' ')).not.toContain('host-token-should-not-leak');
    expect(HOST_ONLY_ENV).toContain('OPENVIDEO_CHROMIUM');
  });

  it('serve: Port nur auf 127.0.0.1, Server im Container auf 0.0.0.0, Token per --env-file statt Kommandozeile', () => {
    const c = container();
    const r = c.run(['serve']);
    const b = before(r.argv);
    expect(b[b.indexOf('-p') + 1]).toBe('127.0.0.1:7788:7788');
    expect(b[b.indexOf('--env-file') + 1]).toBe(c.envFile);
    expect(b).toContain('OPENVIDEO_PUBLIC_URL=http://127.0.0.1:7788');
    expect(after(r.argv)).toEqual(['serve', '--host', '0.0.0.0', '--no-open']);
    expect(r.argv.join(' ')).not.toContain(TOKEN);
    expect(r.stderr).toContain(`http://127.0.0.1:7788/#token=${TOKEN}`);
  });

  it('dev/studio mit eigenem Port und Host: gleicher Port innen und außen, --host bleibt', () => {
    const c = container();
    const r = c.run(['dev', 'hello', '--port=9001']);
    expect(before(r.argv)).toContain('127.0.0.1:9001:9001');
    expect(after(r.argv)).toEqual(['dev', 'hello', '--port=9001', '--host', '0.0.0.0', '--no-open']);
    const h = c.run(['studio', '--host', '0.0.0.0', '--port', '7790']);
    expect(after(h.argv)).toEqual(['studio', '--host', '0.0.0.0', '--port', '7790', '--no-open']);
    expect(c.run(['serve', '--port', 'abc']).status).toBe(2);
  });

  it('macOS: Polling für den Datei-Watcher, außer der Nutzer setzt es selbst', () => {
    const c = container('docker', { pollMs: '1000' });
    expect(before(c.run(['dev']).argv)).toContain('OPENVIDEO_WATCH_POLL_MS=1000');
    const own = before(c.run(['dev'], { OPENVIDEO_WATCH_POLL_MS: '250' }).argv);
    expect(own).toContain('OPENVIDEO_WATCH_POLL_MS');
    expect(own).not.toContain('OPENVIDEO_WATCH_POLL_MS=1000');
  });

  it('mcp: stdin/stdout durchgereicht, nie -t, --workspace außerhalb wird angelegt und eingehängt', () => {
    const c = container();
    const table = { docker: { run: { echoStdin: true } } };
    c.f.setTable(table);
    const ws = join(c.f.dir, 'projects');
    const r = c.run(['mcp', '--workspace', ws], {}, '{"jsonrpc":"2.0","id":1,"method":"initialize"}\n');
    expect(r.status).toBe(0);
    expect(r.stdout).toBe('{"jsonrpc":"2.0","id":1,"method":"initialize"}\n');
    expect(existsSync(ws)).toBe(true);
    expect(before(r.argv)).toContain(`${ws}:${ws}`);
    expect(before(r.argv)).not.toContain('-t');
    // Ein Workspace im aktuellen Ordner braucht keinen zweiten Mount.
    const inner = c.run(['mcp', '--workspace', 'ws'], {}, '');
    expect(before(inner.argv).filter((a) => a.includes(':') && a.includes('/ws'))).toEqual([]);
  });

  it('gibt den Exit-Code des Containers weiter', () => {
    const c = container();
    c.f.setTable({ docker: { run: { status: 3 } } });
    expect(c.run(['validate']).status).toBe(3);
  });

  it.skipIf(skipUnless(hasScript, 'script (util-linux) fehlt: apt-get install bsdutils'))('mit Terminal -t, bei mcp nie', () => {
    const c = container();
    const tty = (args) => {
      const r = spawnSync(scriptPath, ['-qec', [c.wrapper, ...args].map((a) => `'${a}'`).join(' '), '/dev/null'], { cwd: c.work, env: c.f.env, encoding: 'utf8' });
      expect(r.status).toBe(0);
      return c.f.calls().filter((x) => x.name === 'docker').at(-1).args;
    };
    expect(before(tty(['doctor']))).toContain('-t');
    expect(before(tty(['mcp']))).not.toContain('-t');
  });
});

describe('Wrapper für Kubernetes', () => {
  function kube() {
    const f = fakeEnv(['kubectl']);
    const envFile = join(f.dir, 'api.env');
    writeFileSync(envFile, `OPENVIDEO_API_TOKEN=${TOKEN}\n`, { mode: 0o600 });
    const wrapper = join(f.dir, 'openvideo');
    writeFileSync(wrapper, kubernetesWrapper({ kubectlPath: join(f.fakebin, 'kubectl'), context: 'kind-ov', namespace: 'ov', envFile }));
    chmodSync(wrapper, 0o755);
    const work = join(f.dir, 'proj');
    mkdirSync(work);
    const run = (args, input = '') => {
      const n = f.calls().length;
      const r = spawnSync(wrapper, args, { cwd: work, env: f.env, encoding: 'utf8', input });
      return { ...r, calls: f.calls().slice(n).map((c) => c.args) };
    };
    return { f, work, run, wrapper };
  }

  it('mcp: kubectl exec -i ins Deployment, Workspace des Pods, Host-Ordner werden ignoriert', () => {
    const k = kube();
    const r = k.run(['mcp', '--workspace', '/home/me/p', '--project=x', '--verbose']);
    expect(r.status).toBe(0);
    expect(r.calls).toEqual([['--context', 'kind-ov', '-n', 'ov', 'exec', '-i', 'deploy/openvideo', '-c', 'openvideo', '--', 'openvideo', 'mcp', '--verbose', '--workspace', '/workspace']]);
    expect(r.stderr).toContain('--workspace/--project are ignored');
  });

  it('serve/studio: port-forward auf 127.0.0.1, Token aus api.env nur in der ausgegebenen URL', () => {
    const k = kube();
    const r = k.run(['studio']);
    expect(r.calls).toEqual([['--context', 'kind-ov', '-n', 'ov', 'port-forward', '--address', '127.0.0.1', 'svc/openvideo', '7788:7788']]);
    expect(r.stderr).toContain(`http://127.0.0.1:7788/#token=${TOKEN}`);
    expect(r.calls.flat().join(' ')).not.toContain(TOKEN);
  });

  it('dev und worker sind nicht verfügbar (Exit-Code 2 mit Ausweg)', () => {
    const k = kube();
    const r = k.run(['dev']);
    expect(r.status).toBe(2);
    expect(r.stderr).toContain("Use 'openvideo studio'");
    expect(k.run(['worker']).status).toBe(2);
  });

  it('doctor läuft direkt im Pod, ohne Dateien zu kopieren', () => {
    const k = kube();
    expect(k.run(['doctor']).calls).toEqual([['--context', 'kind-ov', '-n', 'ov', 'exec', '-i', 'deploy/openvideo', '-c', 'openvideo', '--', 'openvideo', 'doctor']]);
  });

  it.skipIf(skipUnless(gnuTar, 'GNU tar fehlt (der simulierte Pod braucht es wie das Image)'))('Befehle mit Dateien: Ordner in den Pod, Befehl dort, neue Dateien zurück; Argumente unverändert', () => {
    const k = kube();
    const pod = join(k.f.dir, 'pod');
    const podBin = join(k.f.dir, 'podbin');
    // Ein falsches openvideo im simulierten Pod: legt ein Projekt an bzw. rendert einen Frame und protokolliert argv.
    k.f.script(podBin, 'openvideo', `printf '%s\\n' "$@" > "$FAKE_POD/argv.txt"\nif [ "$1" = create ]; then mkdir -p "$2" && echo '{}' > "$2/project.json"; fi\nif [ "$1" = render-frame ]; then mkdir -p out && printf 'PNG' > out/frame.png; test -f project.json || exit 7; fi\nexit 0`);
    k.f.setTable({ kubectl: { '--context kind-ov -n ov exec': { pod: true } } });
    const env = { ...k.f.env, FAKE_POD: pod, FAKE_POD_PATH: `${podBin}:${k.f.sysbin}` };
    const go = (args) => {
      const n = k.f.calls().length;
      const r = spawnSync(k.wrapper, args, { cwd: k.work, env, encoding: 'utf8' });
      return { ...r, calls: k.f.calls().slice(n).map((c) => c.args) };
    };
    writeFileSync(join(k.work, 'notes.txt'), 'local');
    mkdirSync(join(k.work, 'node_modules'));
    writeFileSync(join(k.work, 'node_modules', 'big.bin'), 'x');
    const c = go(['create', 'hello world']);
    expect(c.stderr).toBe('');
    expect(c.status).toBe(0);
    expect(c.calls).toHaveLength(3);
    expect(readFileSync(join(k.work, 'hello world', 'project.json'), 'utf8')).toBe('{}\n');
    expect(readFileSync(join(pod, 'argv.txt'), 'utf8')).toBe('create\nhello world\n');
    const r = spawnSync(k.wrapper, ['render-frame', '--frame', '1s', '--out', 'out/frame.png'], { cwd: join(k.work, 'hello world'), env, encoding: 'utf8' });
    expect(r.status).toBe(0);
    expect(readFileSync(join(k.work, 'hello world', 'out', 'frame.png'), 'utf8')).toBe('PNG');
    // Der Pod bekam node_modules nicht; unveränderte Dateien kommen nicht zurück.
    const id = spawnSync('sh', ['-c', 'printf %s "$1" | cksum | cut -d " " -f 1', 'sh', realpathSync(k.work)], { encoding: 'utf8' }).stdout.trim();
    expect(existsSync(join(pod, 'var', 'cache', 'openvideo', 'host', id, 'node_modules'))).toBe(false);
    expect(existsSync(join(pod, 'var', 'cache', 'openvideo', 'host', id, 'notes.txt'))).toBe(true);
    // op arbeitet ohne --workspace/--project im Workspace des Pods.
    go(['op', 'project.list', '--input', '{}']);
    expect(readFileSync(join(pod, 'argv.txt'), 'utf8')).toBe('op\nproject.list\n--input\n{}\n--workspace\n/workspace\n');
    // Zurückgeholte Dateien gehören dem Aufrufer, nicht der UID im Pod (65532).
    expect(readFileSync(k.wrapper, 'utf8')).toContain('tar -x -f - -C "$cwd" --no-same-owner');
    // Exit-Code des Befehls im Pod bleibt erhalten.
    const fail = spawnSync(k.wrapper, ['render-frame'], { cwd: k.work, env, encoding: 'utf8' });
    expect(fail.status).toBe(7);
  });

  it('weigert sich, das Home-Verzeichnis in den Pod zu kopieren', () => {
    const k = kube();
    const r = spawnSync(k.wrapper, ['render'], { cwd: k.f.home, env: { ...k.f.env, HOME: realpathSync(k.f.home) }, encoding: 'utf8' });
    expect(r.status).toBe(2);
    expect(r.stderr).toContain('run openvideo in a project folder');
  });
});

describe('Windows-Wrapper', () => {
  it('PowerShell reicht Argumente als Array durch, Token per --env-file, Port auf Loopback', () => {
    const ps = powershellWrapper({ engine: 'docker', enginePath: "C:\\Program Files\\Docker\\docker.exe", image: 'openvideo-local:1', envFile: "C:\\Users\\o'neil\\openvideo\\api.env", runtimeInfo: 'docker, image openvideo-local:1' });
    expect(ps).toContain("$engine = 'C:\\Program Files\\Docker\\docker.exe'");
    expect(ps).toContain("$envFile = 'C:\\Users\\o''neil\\openvideo\\api.env'");
    expect(ps).toContain('& $engine @a');
    expect(ps).toContain("'--env-file', $envFile");
    expect(ps).toContain('"127.0.0.1:${port}:${port}"');
    expect(ps).not.toMatch(/Invoke-Expression|iex /u);
    expect(cmdWrapper()).toContain('powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0openvideo.ps1" %*');
  });
});
