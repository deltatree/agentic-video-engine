/**
 * Plugins aus `settings.plugins` (Story 21.1, ADR 0012): Laden mit Rechteprüfung und Anbindung
 * der Registry-Einträge an Encoder (Codecs) und Export (Exporter).
 *
 * - Plugins sind Code im Prozess. Sie laden nur, wenn der Host es erlaubt (`trusted`/`--trusted`
 *   oder `OPENVIDEO_ALLOW_PLUGINS=1`); sonst bricht die Umgebung mit `OV_PLUGIN_NOT_ALLOWED` ab.
 * - Rechte sind ausdrücklich: Der Host gewährt nur, was in `permissions` bzw.
 *   `OPENVIDEO_PLUGIN_PERMISSIONS` steht. Fordert ein Plugin mehr, bricht `Registry.use` ab.
 * - Einträge: relativer Pfad (`./plugins/hello.mjs`, im Projektordner) oder Paketname
 *   (`openvideo-plugin-hello`, aus `node_modules` des Projekts).
 */
import { execFile } from 'node:child_process';
import { existsSync, lstatSync, readFileSync, realpathSync } from 'node:fs';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { fetchAsset } from '@agentic-video/assets';
import { OpenVideoError, isPermission, minimalChildEnv, isPlugin, isRecord, type ExporterDefinition, type HostServices, type Permission, type Plugin, type Registry, type RgbaImage } from '@agentic-video/core';
import { encodePng } from '@agentic-video/png';
import type { EncodeOptions, FrameEncoder } from './environment.js';

/** Erlaubnis des Hosts für Plugins. */
export interface PluginPolicy {
  /** Plugins aus `settings.plugins` überhaupt laden. */
  readonly load: boolean;
  /** Ausdrücklich gewährte Rechte. */
  readonly permissions: readonly Permission[];
}

/**
 * Leitet die Plugin-Erlaubnis aus Vertrauen und Umgebung ab: laden mit `trusted` oder
 * `OPENVIDEO_ALLOW_PLUGINS=1`; Rechte nur aus `OPENVIDEO_PLUGIN_PERMISSIONS` (Kommaliste).
 *
 * @example
 * ```ts
 * pluginPolicyFromEnv({ OPENVIDEO_ALLOW_PLUGINS: '1', OPENVIDEO_PLUGIN_PERMISSIONS: 'fs:write' }, false);
 * // { load: true, permissions: ['fs:write'] }
 * ```
 */
export function pluginPolicyFromEnv(env: Readonly<Record<string, string | undefined>>, trusted: boolean): PluginPolicy {
  const raw = (env['OPENVIDEO_PLUGIN_PERMISSIONS'] ?? '').split(',').map((p) => p.trim()).filter((p) => p !== '');
  const unknown = raw.filter((p) => !isPermission(p));
  if (unknown.length > 0) {
    throw new OpenVideoError({
      code: 'OV_PLUGIN_PERMISSION_UNKNOWN',
      errorClass: 'PluginError',
      problem: `OPENVIDEO_PLUGIN_PERMISSIONS names unknown permissions: ${unknown.join(', ')}.`,
      suggestions: ['Use a comma-separated list of: fs:read, fs:write, net, process:spawn, env.'],
    });
  }
  return { load: trusted || env['OPENVIDEO_ALLOW_PLUGINS'] === '1', permissions: raw.filter(isPermission) };
}

function isInside(root: string, full: string): boolean {
  const rel = relative(root, full);
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
}

function notFound(spec: string, projectDir: string, cause?: unknown): OpenVideoError {
  return new OpenVideoError({
    code: 'OV_PLUGIN_NOT_FOUND',
    errorClass: 'PluginError',
    problem: `Plugin "${spec}" from settings.plugins was not found.`,
    details: { plugin: spec },
    ...(cause !== undefined ? { cause } : {}),
    suggestions: [`Install it in the project: npm install ${spec.startsWith('.') ? '<package>' : spec} (in ${projectDir}).`, 'Or reference a module file inside the project, e.g. "./plugins/my-plugin.mjs".'],
  });
}

/** Einstieg eines Pakets aus `package.json` (`exports['.']` mit `import`/`default`, `module`, `main`). */
function packageEntry(pkgDir: string, pkg: Readonly<Record<string, unknown>>): string {
  const exp = pkg['exports'];
  const dot = isRecord(exp) && '.' in exp ? exp['.'] : exp;
  const pick = (v: unknown): string | undefined => {
    if (typeof v === 'string') return v;
    if (isRecord(v)) return pick(v['import']) ?? pick(v['default']) ?? pick(v['node']);
    return undefined;
  };
  const rel = pick(dot) ?? (typeof pkg['module'] === 'string' ? pkg['module'] : undefined) ?? (typeof pkg['main'] === 'string' ? pkg['main'] : 'index.js');
  return resolve(pkgDir, rel);
}

/**
 * Löst einen Eintrag aus `settings.plugins` zu einer Moduldatei auf. Relative Pfade müssen im
 * Projektordner liegen (außer `allowOutsidePaths`); Paketnamen kommen aus `node_modules`.
 *
 * @example
 * ```ts
 * resolvePluginModule('/work/demo', './plugins/hello.mjs'); // '/work/demo/plugins/hello.mjs'
 * ```
 */
export function resolvePluginModule(projectDir: string, spec: string, allowOutsidePaths = false): string {
  if (spec.startsWith('.') || isAbsolute(spec)) {
    const file = resolve(projectDir, spec);
    if (!existsSync(file)) throw notFound(spec, projectDir);
    const real = realpathSync(file);
    if (!allowOutsidePaths && !isInside(realpathSync(projectDir), real)) {
      throw new OpenVideoError({
        code: 'OV_PATH_OUTSIDE',
        errorClass: 'SecurityError',
        problem: `Plugin "${spec}" is outside the project directory.`,
        suggestions: ['Copy the plugin into the project, or install it as a package in the project.'],
      });
    }
    return real;
  }
  if (!/^(@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/u.test(spec)) {
    throw new OpenVideoError({ code: 'OV_PLUGIN_NAME', errorClass: 'PluginError', problem: `"${spec}" is neither a relative module path nor an npm package name.`, suggestions: ['Use "./plugins/x.mjs" or "openvideo-plugin-x".'] });
  }
  const require = createRequire(join(projectDir, 'package.json'));
  try {
    return require.resolve(spec);
  } catch (error) {
    // ESM-only-Pakete ohne `require`-Bedingung: Einstieg selbst aus package.json lesen.
    for (let dir = projectDir; ; dir = dirname(dir)) {
      const pkgDir = join(dir, 'node_modules', spec);
      if (existsSync(join(pkgDir, 'package.json'))) {
        const pkg: unknown = JSON.parse(readFileSync(join(pkgDir, 'package.json'), 'utf8'));
        if (isRecord(pkg)) {
          const entry = packageEntry(pkgDir, pkg);
          if (existsSync(entry)) return entry;
        }
      }
      if (dirname(dir) === dir) break;
    }
    throw notFound(spec, projectDir, error);
  }
}

/**
 * Pfad mit aufgelösten Symlinks: `realpath` des nächsten existierenden Vorfahren plus der Rest.
 * `undefined`, wenn ein vorhandener Eintrag nicht auflösbar ist (z. B. ein Symlink ins Leere).
 */
function realPathOf(full: string): string | undefined {
  const rest: string[] = [];
  let at = full;
  for (;;) {
    try {
      lstatSync(at);
      break;
    } catch (error: unknown) {
      if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) return undefined;
    }
    const parent = dirname(at);
    if (parent === at) return undefined;
    rest.unshift(basename(at));
    at = parent;
  }
  try {
    return join(realpathSync(at), ...rest);
  } catch (error: unknown) {
    // Vorhandener, aber nicht auflösbarer Eintrag (Symlink ins Leere, Schleife): nicht zulassen.
    if (error instanceof Error) return undefined;
    throw error;
  }
}

/**
 * Dienste des Hosts für Plugins. Dateizugriffe sind auf den Projektordner begrenzt (außer
 * `allowOutsidePaths`), auch über Symlinks hinweg (realpath des nächsten existierenden
 * Vorfahren, Review Q4). Netz geht über den abgesicherten Fetcher (keine privaten Adressen),
 * Prozesse laufen ohne Shell mit Timeout und erben nur die minimale Umgebung
 * (`minimalChildEnv`); erst mit dem Recht `env` die volle Umgebung des Hosts.
 * Umgebungsvariablen sind nur lesbar.
 *
 * @example
 * ```ts
 * const host = pluginHostServices('/work/demo', ['fs:read'], process.env);
 * await host.readFile?.('data/table.csv');
 * ```
 */
export function pluginHostServices(projectDir: string, granted: readonly Permission[], env: Readonly<Record<string, string | undefined>>, allowOutsidePaths = false): Partial<HostServices> {
  const grant = new Set(granted);
  const outside = (path: string): OpenVideoError =>
    new OpenVideoError({ code: 'OV_PATH_OUTSIDE', errorClass: 'SecurityError', problem: `Plugin file access "${path}" is outside the project directory.`, suggestions: ['Use paths relative to the project directory.', 'Symbolic links must also point into the project directory.'] });
  const inProject = (path: string): string => {
    const full = resolve(projectDir, path);
    if (allowOutsidePaths) return full;
    if (!isInside(projectDir, full)) throw outside(path);
    const root = realPathOf(resolve(projectDir));
    const real = realPathOf(full);
    if (root === undefined || real === undefined || !isInside(root, real)) throw outside(path);
    return real;
  };
  const childEnv: Record<string, string> = grant.has('env')
    ? Object.fromEntries(Object.entries(env).filter((e): e is [string, string] => e[1] !== undefined))
    : minimalChildEnv(env);
  return {
    ...(grant.has('fs:read') ? { readFile: async (path: string) => new Uint8Array(await readFile(inProject(path))) } : {}),
    ...(grant.has('fs:write')
      ? {
          writeFile: async (path: string, data: Uint8Array) => {
            const full = inProject(path);
            await mkdir(dirname(full), { recursive: true });
            await writeFile(full, data);
          },
        }
      : {}),
    ...(grant.has('net') ? { fetch: async (url: string) => (await fetchAsset(url)).bytes } : {}),
    ...(grant.has('process:spawn')
      ? {
          spawn: (command: string, args: readonly string[], options?: { readonly input?: Uint8Array; readonly timeoutMs?: number }) =>
            new Promise<{ code: number; stdout: Uint8Array; stderr: string }>((done) => {
              const child = execFile(command, [...args], { encoding: 'buffer', timeout: options?.timeoutMs ?? 120_000, maxBuffer: 256 * 1024 * 1024, cwd: projectDir, env: childEnv }, (error, stdout, stderr) => {
                const code = error === null ? 0 : typeof error.code === 'number' ? error.code : 1;
                done({ code, stdout: new Uint8Array(stdout), stderr: stderr.toString('utf8') });
              });
              if (options?.input !== undefined) child.stdin?.end(options.input);
              else child.stdin?.end();
            }),
        }
      : {}),
    ...(grant.has('env') ? { env: (name: string) => env[name] } : {}),
  };
}

/** Plugin aus einem Modul: `default` (Objekt oder Fabrik ohne Argumente) oder benannter Export `plugin`. */
async function pluginOf(mod: unknown, spec: string): Promise<Plugin> {
  const candidates: unknown[] = isRecord(mod) ? [mod['default'], mod['plugin']] : [];
  for (const c of candidates) {
    if (isPlugin(c)) return c;
    if (typeof c === 'function' && c.length === 0) {
      const made: unknown = await Promise.resolve(Reflect.apply(c, undefined, []));
      if (isPlugin(made)) return made;
    }
  }
  throw new OpenVideoError({
    code: 'OV_PLUGIN_INVALID',
    errorClass: 'PluginError',
    problem: `Module "${spec}" does not export an OpenVideo plugin.`,
    details: { plugin: spec },
    suggestions: ['Export default { name, version, permissions: [], setup(ctx) { … } }.', 'See docs/guide/plugins.md and examples/plugin-hello.'],
  });
}

/** Optionen für {@link loadProjectPlugins}. */
export interface LoadPluginsOptions {
  readonly projectDir: string;
  readonly project: Readonly<Record<string, unknown>>;
  readonly policy: PluginPolicy;
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly allowOutsidePaths?: boolean;
}

/**
 * Lädt alle Plugins aus `settings.plugins` in das Register (in Listenreihenfolge). Schon geladene
 * Plugins (gleicher Name) werden übersprungen. Liefert die Namen der neu geladenen Plugins.
 *
 * @example
 * ```ts
 * await loadProjectPlugins(registry, { projectDir, project, policy: { load: true, permissions: ['fs:write'] }, env: process.env });
 * ```
 */
export async function loadProjectPlugins(registry: Registry, options: LoadPluginsOptions): Promise<string[]> {
  const settings = isRecord(options.project['settings']) ? options.project['settings'] : {};
  const specs = Array.isArray(settings['plugins']) ? settings['plugins'].filter((p): p is string => typeof p === 'string') : [];
  if (specs.length === 0) return [];
  if (!options.policy.load) {
    throw new OpenVideoError({
      code: 'OV_PLUGIN_NOT_ALLOWED',
      errorClass: 'PluginError',
      problem: `The project loads plugins (${specs.join(', ')}), but this host does not allow plugin code.`,
      details: { plugins: specs.join(', ') },
      suggestions: ['Plugins run as code in the render process (ADR 0012). For your own projects use --trusted or set OPENVIDEO_ALLOW_PLUGINS=1.', 'Grant permissions explicitly with OPENVIDEO_PLUGIN_PERMISSIONS (e.g. "fs:write").', 'Remove settings.plugins to render without them.'],
    });
  }
  const host = pluginHostServices(options.projectDir, options.policy.permissions, options.env, options.allowOutsidePaths === true);
  const loaded: string[] = [];
  for (const spec of specs) {
    const file = resolvePluginModule(options.projectDir, spec, options.allowOutsidePaths === true);
    let mod: unknown;
    try {
      mod = await import(pathToFileURL(file).href);
    } catch (error) {
      throw new OpenVideoError({ code: 'OV_PLUGIN_LOAD', errorClass: 'PluginError', problem: `Plugin "${spec}" could not be imported: ${error instanceof Error ? error.message : String(error)}`, details: { plugin: spec }, cause: error, suggestions: ['Check that the module is valid ES module JavaScript (build TypeScript plugins first).'] });
    }
    const plugin = await pluginOf(mod, spec);
    if (registry.plugins.some((p) => p.name === plugin.name)) continue;
    await registry.use(plugin, host, { origin: file });
    loaded.push(plugin.name);
  }
  return loaded;
}

/** Präfix für Formate und Codecs aus Plugins. */
export const PLUGIN_PREFIX = 'plugin:';

/**
 * Exporter eines Formats `plugin:<id>`, falls registriert.
 *
 * @example
 * ```ts
 * pluginExporter(registry, 'plugin:hello-frames')?.id; // 'hello-frames'
 * ```
 */
export function pluginExporter(registry: Registry, format: string): ExporterDefinition | undefined {
  if (!format.startsWith(PLUGIN_PREFIX)) return undefined;
  const id = format.slice(PLUGIN_PREFIX.length);
  const exporter = registry.exporters.get(id);
  if (exporter === undefined) {
    throw new OpenVideoError({
      code: 'OV_RENDER_PROFILE',
      errorClass: 'RenderError',
      problem: `Output format "${format}" needs the exporter "${id}", which no loaded plugin registers.`,
      suggestions: [registry.exporters.size > 0 ? `Use one of: ${[...registry.exporters.keys()].map((k) => PLUGIN_PREFIX + k).join(', ')}.` : 'Add the plugin that provides it to settings.plugins.', 'Or use a built-in format such as mp4.'],
    });
  }
  return exporter;
}

/**
 * Encoder für einen Exporter: schreibt die Frames als PNG-Folge (gerades Alpha) in einen
 * Arbeitsordner neben der Ausgabe und ruft beim Abschluss `export` des Plugins.
 *
 * @example
 * ```ts
 * const enc = exporterEncoder(exporter, { outPath: 'out/v.hello', format: 'plugin:hello-frames', width: 64, height: 64, fps: 30, alpha: false, quality: 80, hardware: 'none', colorSpace: 'srgb' });
 * ```
 */
export function exporterEncoder(exporter: ExporterDefinition, options: EncodeOptions): FrameEncoder {
  const framesDir = `${options.outPath}.frames`;
  let frames = 0;
  let ready: Promise<void> | undefined;
  const prepare = (): Promise<void> => {
    ready ??= rm(framesDir, { recursive: true, force: true }).then(() => mkdir(framesDir, { recursive: true }).then(() => undefined));
    return ready;
  };
  return {
    async write(image: RgbaImage) {
      await prepare();
      await writeFile(join(framesDir, `frame-${String(frames).padStart(6, '0')}.png`), encodePng(image, { level: 1 }));
      frames++;
    },
    async finish() {
      if (frames === 0) throw new OpenVideoError({ code: 'OV_ENCODE_EMPTY', errorClass: 'EncodeError', problem: 'No frames were written.', suggestions: ['Render at least one frame.'] });
      let result: unknown;
      try {
        result = await exporter.export({ framesDir, frameCount: frames, width: options.width, height: options.height, ...(options.audioPath !== undefined ? { audioPath: options.audioPath } : {}), outPath: options.outPath, fps: options.fps });
      } catch (error) {
        if (error instanceof OpenVideoError) throw error;
        throw new OpenVideoError({ code: 'OV_EXPORTER_FAILED', errorClass: 'EncodeError', problem: `Exporter "${exporter.id}" failed: ${error instanceof Error ? error.message : String(error)}`, details: { exporter: exporter.id }, cause: error, suggestions: ['Check the plugin and its permissions.', 'Render with a built-in format to rule out render errors.'] });
      }
      if (!existsSync(options.outPath)) {
        throw new OpenVideoError({ code: 'OV_EXPORTER_OUTPUT', errorClass: 'EncodeError', problem: `Exporter "${exporter.id}" did not write "${options.outPath}".`, details: { exporter: exporter.id }, suggestions: ['The exporter must create input.outPath.'] });
      }
      await rm(framesDir, { recursive: true, force: true });
      const listed: unknown = isRecord(result) ? result['outputs'] : undefined;
      const extra = Array.isArray(listed) ? listed.filter((p): p is string => typeof p === 'string' && p !== options.outPath) : [];
      return { outputs: [options.outPath, ...extra], frames, encoder: `plugin:${exporter.id}`, args: [] };
    },
    async abort() {
      await rm(framesDir, { recursive: true, force: true });
    },
  };
}
