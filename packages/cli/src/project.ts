/**
 * Projektordner für die CLI: Anlegen (`create`), Laden (JSON oder TSX) und
 * Einbinden in einen Ein-Projekt-Workspace (für `dev`, `studio`, `serve`).
 */
import { existsSync } from 'node:fs';
import { lstat, mkdir, readFile, readlink, symlink, unlink, writeFile } from 'node:fs/promises';
import { basename, dirname, join, relative, resolve } from 'node:path';
import { isSourceEntry, readProjectConfig, safeJoin, type SourceService } from '@agentic-video/agent';
import { OpenVideoError, SCHEMA_VERSION, isRecord } from '@agentic-video/core';

/** Ein geladenes Projekt. */
export interface LoadedProject {
  readonly dir: string;
  readonly entry: string;
  readonly project: Record<string, unknown>;
}

/** Wie viele Ordner über einer Datei nach `openvideo.json` gesucht wird. */
const PROJECT_SEARCH_DEPTH = 4;

/**
 * Findet den Projektordner zu einem Pfad (Ordner, `project.json` oder TSX-/TS-Datei).
 * Bei einer Datei ist der Projektordner der nächste Ordner darüber mit `openvideo.json`,
 * sonst der Ordner der Datei. Der Einstieg ist relativ zum Projektordner.
 *
 * @example
 * ```ts
 * projectDirOf('/work/demo/src/video.tsx'); // { dir: '/work/demo', entry: 'src/video.tsx' }
 * ```
 */
export function projectDirOf(path: string): { dir: string; entry?: string } {
  const full = resolve(path);
  if (full.endsWith('.json') || isSourceEntry(full)) {
    let dir = dirname(full);
    for (let candidate = dir, i = 0; i < PROJECT_SEARCH_DEPTH; i++, candidate = dirname(candidate)) {
      if (existsSync(join(candidate, 'openvideo.json'))) {
        dir = candidate;
        break;
      }
      if (dirname(candidate) === candidate) break;
    }
    return { dir, entry: relative(dir, full) };
  }
  return { dir: full };
}

/**
 * Lädt ein Projekt. TSX-Projekte kompiliert der Compiler (in der Sandbox; mit `trusted` auf dem Host).
 *
 * @example
 * ```ts
 * const { project } = await loadProject('examples/hello', { sources });
 * ```
 */
export async function loadProject(path: string, options: { readonly sources?: SourceService } = {}): Promise<LoadedProject> {
  const located = projectDirOf(path);
  const config = await readProjectConfig(located.dir);
  const entry = located.entry !== undefined && existsSync(join(located.dir, located.entry)) ? located.entry : config.entry;
  const file = join(located.dir, entry);
  if (!existsSync(file)) {
    throw new OpenVideoError({ code: 'OV_PROJECT_UNKNOWN', errorClass: 'ProjectError', problem: `No project found at ${file}.`, suggestions: ['Run `openvideo create <name>` to create a project.', 'Pass the project folder or its project.json.'] });
  }
  if (isSourceEntry(entry)) {
    if (options.sources === undefined) {
      throw new OpenVideoError({ code: 'OV_SOURCE_UNAVAILABLE', errorClass: 'ProjectError', problem: 'TSX projects need the compiler, which is not available.', suggestions: ['Install @agentic-video/compiler, or use a JSON project.'] });
    }
    const compiled = await options.sources.compile(located.dir, entry);
    const errors = compiled.diagnostics.filter((d) => d.severity === 'error');
    if (errors[0] !== undefined) throw new OpenVideoError(errors[0]);
    await writeFile(join(located.dir, 'project.json'), `${JSON.stringify(compiled.project, null, 2)}\n`);
    return { dir: located.dir, entry, project: compiled.project };
  }
  const raw: unknown = JSON.parse(await readFile(file, 'utf8'));
  if (!isRecord(raw)) throw new OpenVideoError({ code: 'OV_PROJECT_INVALID', errorClass: 'ProjectError', problem: `${file} is not a JSON object.`, suggestions: ['A project.json must contain one object: { "schemaVersion": "1.0.0", "compositions": [ … ] }.', 'Create a fresh project with `openvideo create <name>` and compare.'] });
  return { dir: located.dir, entry, project: raw };
}

/** Standardprojekt für `openvideo create`. */
export function helloProject(name: string): Record<string, unknown> {
  return {
    schemaVersion: SCHEMA_VERSION,
    metadata: { title: name, createdWith: 'openvideo create' },
    settings: { theme: { colors: { primary: '#FF5A1F', background: '#0B0D12', text: '#F5F7FF' } } },
    compositions: [
      {
        id: 'main',
        width: 1920,
        height: 1080,
        fps: 30,
        duration: '5s',
        background: '#0B0D12',
        nodes: [
          {
            id: 'glow',
            type: 'ellipse',
            x: 660,
            y: 240,
            width: 600,
            height: 600,
            fill: { type: 'radial', stops: [{ offset: 0, color: '#FF5A1F66' }, { offset: 1, color: '#FF5A1F00' }] },
            scale: { $spring: { from: { x: 0.6, y: 0.6 }, to: { x: 1, y: 1 }, at: 0, stiffness: 120, damping: 14 } },
          },
          {
            id: 'headline',
            type: 'text',
            text: name,
            fontSize: 120,
            fontWeight: 800,
            x: 96,
            width: 1728,
            textAlign: 'center',
            y: 440,
            fill: { $ref: 'theme.colors.text' },
            textAnimation: { unit: 'char', stagger: 2, duration: 18, from: { opacity: 0, y: 40 } },
          },
          {
            id: 'subline',
            type: 'text',
            text: 'Made with OpenVideo',
            fontSize: 40,
            x: 96,
            width: 1728,
            textAlign: 'center',
            y: 600,
            fill: { $ref: 'theme.colors.primary' },
            opacity: { $keyframes: [{ t: '0.8s', v: 0 }, { t: '1.4s', v: 1, ease: 'easeOutCubic' }] },
          },
        ],
      },
    ],
    renderProfiles: [{ id: 'web', format: 'mp4', codec: 'h264', quality: 80 }],
  };
}

/** AGENTS.md für neue Projekte (Englisch, Team-Entscheidung T2); Kurzfassung von docs/ai/AGENTS.md. */
const PROJECT_AGENTS_MD = (name: string): string => `# ${name} – notes for coding agents

This is an OpenVideo project. The video is described in \`project.json\` (Composition IR).

## The loop

1. \`openvideo validate --json\` – checks schema, assets, fonts and backends.
2. \`openvideo render-frame --frame 2s --out out/frame.png\` – look at the result.
3. Change precisely (one property, \`openvideo patch\`), do not rewrite the whole file.
4. \`openvideo render --format mp4\` – the video and its \`render-manifest.json\`.

## Rules

- Time: frames (\`48\`) or text (\`"2s"\`, \`"500ms"\`, \`"marker:intro+10f"\`).
- Animation: \`{"$keyframes": [{"t": 0, "v": 0}, {"t": "1s", "v": 100, "ease": "easeOutCubic"}]}\`.
- Coordinates: pixels, \`x\`/\`y\` is the top left corner; rotation in degrees.
- Every error has \`code\`, \`problem\` and \`suggestions\`; follow the first suggestion.

Full reference: https://github.com/deltatree/agentic-video-engine/blob/main/docs/ai/AGENTS.md
`;

/**
 * Legt einen Projektordner an.
 *
 * @example
 * ```ts
 * await createProjectDir('hello', { project: helloProject('Hello') });
 * ```
 */
export async function createProjectDir(dir: string, options: { readonly name?: string; readonly project: Record<string, unknown>; readonly source?: string; readonly files?: Readonly<Record<string, string>> }): Promise<string> {
  const full = resolve(dir);
  const name = options.name ?? basename(full);
  const entry = options.source !== undefined ? 'src/video.tsx' : 'project.json';
  // Alle Zieldateien zuerst prüfen (B15): kein Ausbruch mit "..", keine Nutzerdatei überschreiben.
  const planned: [string, string][] = [
    ...(options.source !== undefined ? [[entry, options.source] satisfies [string, string]] : []),
    ...Object.entries(options.files ?? {}),
    ['project.json', `${JSON.stringify(options.project, null, 2)}\n`],
    ['openvideo.json', `${JSON.stringify({ name, entry, outDir: 'out' }, null, 2)}\n`],
    ['.gitignore', '.openvideo/\nout/\n'],
    ['AGENTS.md', PROJECT_AGENTS_MD(name)],
  ];
  const targets = planned.map(([rel, text]): [string, string] => [safeJoin(full, rel), text]);
  const taken = targets.map(([file]) => file).filter((file) => existsSync(file));
  if (taken.length > 0) {
    throw new OpenVideoError({
      code: 'OV_PROJECT_EXISTS',
      errorClass: 'ProjectError',
      problem: `${full} already contains ${taken.map((f) => relative(full, f)).join(', ')}; nothing was written.`,
      suggestions: ['Choose another directory name, or move the existing files away.'],
    });
  }
  await mkdir(join(full, 'assets'), { recursive: true });
  await mkdir(join(full, 'out'), { recursive: true });
  for (const [file, text] of targets) {
    await mkdir(dirname(file), { recursive: true });
    // `wx`: schlägt fehl, falls die Datei inzwischen jemand anderes angelegt hat.
    await writeFile(file, text, { flag: 'wx' });
  }
  return full;
}

/**
 * Bindet einen Projektordner als einziges Projekt in einen Workspace ein (Symlink),
 * damit Agent API und Studio ihn bearbeiten. Liefert Workspace-Pfad und Projekt-ID.
 * Die ID hat höchstens 63 Zeichen; ein veralteter oder hängender Symlink wird ersetzt (B15).
 *
 * @example
 * ```ts
 * const { workspaceDir, projectId } = await singleProjectWorkspace('/work/demo');
 * ```
 */
export async function singleProjectWorkspace(projectDir: string): Promise<{ workspaceDir: string; projectId: string }> {
  const id = basename(projectDir).toLowerCase().replace(/[^a-z0-9]+/gu, '-').replace(/^-+/gu, '').slice(0, 63).replace(/-+$/gu, '') || 'project';
  const workspaceDir = join(projectDir, '.openvideo', 'workspace');
  await mkdir(join(workspaceDir, 'projects'), { recursive: true });
  const link = join(workspaceDir, 'projects', id);
  let current: string | undefined;
  try {
    current = (await lstat(link)).isSymbolicLink() ? await readlink(link) : link;
  } catch (error) {
    if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error;
  }
  if (current === projectDir) return { workspaceDir, projectId: id };
  if (current !== undefined) {
    if (current === link) {
      throw new OpenVideoError({ code: 'OV_PROJECT_WORKSPACE', errorClass: 'ProjectError', problem: `${link} exists and is not a link to the project.`, suggestions: ['Delete the .openvideo/workspace folder of the project and start again.'] });
    }
    await unlink(link);
  }
  await symlink(projectDir, link, 'dir');
  return { workspaceDir, projectId: id };
}
