/**
 * Projektordner für die CLI: Anlegen (`create`), Laden (JSON oder TSX) und
 * Einbinden in einen Ein-Projekt-Workspace (für `dev`, `studio`, `serve`).
 */
import { existsSync } from 'node:fs';
import { mkdir, readFile, symlink, writeFile } from 'node:fs/promises';
import { basename, join, resolve } from 'node:path';
import { readProjectConfig, type SourceService } from '@agentic-video/agent';
import { OpenVideoError, SCHEMA_VERSION, isRecord } from '@agentic-video/core';

/** Ein geladenes Projekt. */
export interface LoadedProject {
  readonly dir: string;
  readonly entry: string;
  readonly project: Record<string, unknown>;
}

/** Findet den Projektordner zu einem Pfad (Ordner, `project.json` oder TSX-Datei). */
export function projectDirOf(path: string): { dir: string; entry?: string } {
  const full = resolve(path);
  if (full.endsWith('.json') || full.endsWith('.tsx') || full.endsWith('.ts')) {
    const dir = full.slice(0, full.length - basename(full).length - 1);
    const relEntry = full.slice(dir.length + 1);
    return { dir: existsSync(join(dir, 'openvideo.json')) || !full.includes('/src/') ? dir : resolve(dir, '..'), entry: relEntry };
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
  if (entry.endsWith('.tsx') || entry.endsWith('.ts')) {
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
  if (!isRecord(raw)) throw new OpenVideoError({ code: 'OV_PROJECT_INVALID', errorClass: 'ProjectError', problem: `${file} is not a JSON object.`, suggestions: [] });
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

const PROJECT_AGENTS_MD = (name: string) => `# ${name} – Hinweise für Coding Agents

Dieses Projekt ist ein OpenVideo-Projekt. Die Composition steht in \`project.json\` (Composition IR).

## Kreislauf

1. \`openvideo validate --json\` – prüft Schema, Assets, Schriften, Backends.
2. \`openvideo render-frame --frame 2s --out out/frame.png\` – Ergebnis ansehen.
3. Gezielt ändern (eine Property), nicht die ganze Datei neu schreiben.
4. \`openvideo render --format mp4\` – Video und \`render-manifest.json\`.

## Regeln

- Zeiten: Frames (\`48\`) oder Text (\`"2s"\`, \`"500ms"\`, \`"marker:intro+10f"\`).
- Animation: \`{"$keyframes": [{"t": 0, "v": 0}, {"t": "1s", "v": 100, "ease": "easeOutCubic"}]}\`.
- Koordinaten: Pixel, \`x\`/\`y\` ist die linke obere Ecke; Rotation in Grad.
- Referenz: https://github.com/deltatree/agentic-video-engine/blob/main/docs/ai/AGENTS.md
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
  if (existsSync(join(full, 'openvideo.json'))) {
    throw new OpenVideoError({ code: 'OV_PROJECT_EXISTS', errorClass: 'ProjectError', problem: `${full} already contains an OpenVideo project.`, suggestions: ['Choose another directory name.'] });
  }
  const name = options.name ?? basename(full);
  await mkdir(join(full, 'assets'), { recursive: true });
  await mkdir(join(full, 'out'), { recursive: true });
  const entry = options.source !== undefined ? 'src/video.tsx' : 'project.json';
  if (options.source !== undefined) {
    await mkdir(join(full, 'src'), { recursive: true });
    await writeFile(join(full, entry), options.source);
  }
  for (const [rel, text] of Object.entries(options.files ?? {})) {
    const target = join(full, rel);
    await mkdir(target.slice(0, target.lastIndexOf('/')), { recursive: true });
    await writeFile(target, text);
  }
  await writeFile(join(full, 'project.json'), `${JSON.stringify(options.project, null, 2)}\n`);
  await writeFile(join(full, 'openvideo.json'), `${JSON.stringify({ name, entry, outDir: 'out' }, null, 2)}\n`);
  await writeFile(join(full, '.gitignore'), '.openvideo/\nout/\n');
  await writeFile(join(full, 'AGENTS.md'), PROJECT_AGENTS_MD(name));
  return full;
}

/**
 * Bindet einen Projektordner als einziges Projekt in einen Workspace ein (Symlink),
 * damit Agent API und Studio ihn bearbeiten. Liefert Workspace-Pfad und Projekt-ID.
 */
export async function singleProjectWorkspace(projectDir: string): Promise<{ workspaceDir: string; projectId: string }> {
  const id = basename(projectDir).toLowerCase().replace(/[^a-z0-9]+/gu, '-').replace(/^-+|-+$/gu, '') || 'project';
  const workspaceDir = join(projectDir, '.openvideo', 'workspace');
  await mkdir(join(workspaceDir, 'projects'), { recursive: true });
  const link = join(workspaceDir, 'projects', id);
  if (!existsSync(link)) await symlink(projectDir, link, 'dir');
  return { workspaceDir, projectId: id };
}
