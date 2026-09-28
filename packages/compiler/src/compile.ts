/**
 * TSX → IR (FR-17, FR-18): esbuild bündelt, die Sandbox wertet aus, `toIR` erzeugt die IR.
 * Laufzeitfehler werden per Sourcemap auf Datei und Zeile der TSX-Quelle abgebildet.
 */
import { build, type Message, type Plugin } from 'esbuild';
import { existsSync } from 'node:fs';
import { SourceMap, builtinModules, type SourceMapPayload } from 'node:module';
import { isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { OpenVideoError, isRecord, sha256Hex, validateProject, type Diagnostic, type IrProject } from '@agentic-video/core';
import { runSandboxed, type SandboxLimits, type SandboxMode } from '@agentic-video/sandbox';
import { isIrProjectShape } from '@agentic-video/sdk';

/** Dateiname des Bündels in Stacktraces. */
export const BUNDLE_FILENAME = '__openvideo_bundle.js';
const GLOBAL_NAME = '__openvideo';
/** Ordner `packages/` dieses Repositorys (für Workspace-Quellen des SDK). */
const PACKAGES_DIR = fileURLToPath(new URL('../../', import.meta.url));
const BUILTINS: ReadonlySet<string> = new Set(builtinModules);

/** Optionen für {@link compileTsx}. */
export interface CompileOptions {
  /** Projektwurzel; Quellpfade in Diagnosen und `meta.source` sind relativ dazu. */
  readonly projectDir: string;
  /** Standard `docker`. `trusted-host` nur für eigene Projekte. */
  readonly mode?: SandboxMode;
  readonly limits?: Partial<SandboxLimits>;
}

/** Ergebnis von {@link compileTsx}. */
export interface CompileResult {
  readonly project: IrProject;
  /** Warnungen des SDK und Ergebnis von `validateProject`, mit Quellpositionen. */
  readonly diagnostics: readonly Diagnostic[];
  /** `sha256:<hex>` des Bündels. */
  readonly bundleHash: string;
  /** `true`, wenn ohne Container ausgewertet wurde. */
  readonly trusted: boolean;
}

/** Ein gebündeltes Programm mit Sourcemap. */
export interface Bundle {
  readonly code: string;
  readonly map: string;
}

function compileError(code: string, problem: string, suggestions: readonly string[], details?: Readonly<Record<string, string | number | boolean>>): OpenVideoError {
  return new OpenVideoError({ code, errorClass: 'CompileError', problem, suggestions, ...(details !== undefined ? { details } : {}) });
}

const noNodeBuiltins: Plugin = {
  name: 'openvideo-no-node-builtins',
  setup(b) {
    b.onResolve({ filter: /.*/ }, (args) => {
      const bare = args.path.startsWith('node:') ? args.path.slice(5) : args.path;
      if (args.path.startsWith('node:') || BUILTINS.has(bare) || BUILTINS.has(bare.split('/')[0] ?? '')) {
        return { errors: [{ text: `Node built-in module "${args.path}" is not available in compositions.`, detail: 'OV_COMPILE_NODE_BUILTIN' }] };
      }
      return undefined;
    });
  },
};

const workspaceSources: Plugin = {
  name: 'openvideo-workspace-sources',
  setup(b) {
    b.onResolve({ filter: /^@agentic-video\/[a-z0-9-]+(\/[a-z0-9-]+)?$/ }, (args) => {
      const [, name = '', sub] = /^@agentic-video\/([a-z0-9-]+)(?:\/([a-z0-9-]+))?$/u.exec(args.path) ?? [];
      const file = join(PACKAGES_DIR, name, 'src', `${sub ?? 'index'}.ts`);
      return existsSync(file) ? { path: file } : undefined;
    });
  },
};

function messageDetails(m: Message): Record<string, string | number | boolean> {
  return m.location === null ? {} : { file: m.location.file, line: m.location.line, column: m.location.column + 1 };
}

/**
 * Bündelt eine TSX-Datei samt SDK als IIFE. Node-Builtins sind verboten.
 *
 * @example
 * ```ts
 * const { code, map } = await bundleTsx('/proj/video.tsx', '/proj');
 * ```
 */
export async function bundleTsx(entryPath: string, projectDir: string): Promise<Bundle> {
  const entry = isAbsolute(entryPath) ? entryPath : resolve(projectDir, entryPath);
  if (!existsSync(entry)) throw compileError('OV_COMPILE_ENTRY', `Entry file ${entryPath} does not exist.`, ['Pass the path of a .tsx file that exports a composition.']);
  const contents = [
    `import definition from ${JSON.stringify(entry)};`,
    `import { toIR } from '@agentic-video/sdk';`,
    'const diagnostics = [];',
    'export const result = { project: toIR(definition, { onDiagnostic: (d) => { diagnostics.push(d); } }), diagnostics };',
  ].join('\n');
  try {
    const out = await build({
      stdin: { contents, resolveDir: projectDir, sourcefile: '__openvideo_entry__.ts', loader: 'ts' },
      bundle: true,
      write: false,
      format: 'iife',
      globalName: GLOBAL_NAME,
      platform: 'neutral',
      mainFields: ['module', 'main'],
      target: 'es2022',
      jsx: 'automatic',
      jsxDev: true,
      jsxImportSource: '@agentic-video/sdk',
      sourcemap: 'external',
      sourcesContent: false,
      absWorkingDir: projectDir,
      outfile: join(projectDir, BUNDLE_FILENAME),
      legalComments: 'none',
      logLevel: 'silent',
      plugins: [noNodeBuiltins, workspaceSources],
    });
    const code = out.outputFiles.find((f) => f.path.endsWith('.js'))?.text;
    const map = out.outputFiles.find((f) => f.path.endsWith('.map'))?.text;
    if (code === undefined || map === undefined) throw compileError('OV_COMPILE_BUNDLE', 'esbuild produced no output.', ['Check the entry file.']);
    return { code, map };
  } catch (error) {
    const errors: unknown = isRecord(error) ? error['errors'] : undefined;
    if (!Array.isArray(errors)) throw error;
    const messages = errors.filter(isMessage);
    const first = messages[0];
    if (first === undefined) throw error;
    const builtin = messages.find((m) => m.detail === 'OV_COMPILE_NODE_BUILTIN');
    if (builtin !== undefined) {
      throw compileError('OV_COMPILE_NODE_BUILTIN', builtin.text, ['Remove the import; compositions run without Node APIs.', 'Load data as assets or pass it as JSON input.'], { ...messageDetails(builtin), errors: messages.length });
    }
    throw compileError('OV_COMPILE_SYNTAX', first.text, ['Fix the reported line and compile again.'], { ...messageDetails(first), errors: messages.length });
  }
}

function isMessage(value: unknown): value is Message {
  return isRecord(value) && typeof value['text'] === 'string' && 'location' in value;
}

function isSourceMapPayload(value: unknown): value is SourceMapPayload {
  return isRecord(value) && typeof value['version'] === 'number' && Array.isArray(value['sources']) && typeof value['mappings'] === 'string' && Array.isArray(value['names']);
}

/** Quellposition, 1-basiert. */
export interface SourcePosition {
  readonly file: string;
  readonly line: number;
  readonly column: number;
}

/**
 * Bildet einen Stacktrace des Bündels auf die TSX-Quelle ab. Bevorzugt werden
 * Dateien des Projekts (nicht SDK, nicht `node_modules`).
 *
 * @example
 * ```ts
 * mapStack('Error: x\n    at __openvideo_bundle.js:120:7', bundle.map, '/proj'); // { file: 'video.tsx', line: 12, column: 7 }
 * ```
 */
export function mapStack(stack: string, map: string, projectDir: string): SourcePosition | undefined {
  const payload: unknown = JSON.parse(map);
  if (!isSourceMapPayload(payload)) return undefined;
  const sourceMap = new SourceMap(payload);
  const positions: { readonly abs: string; readonly pos: SourcePosition }[] = [];
  const pattern = new RegExp(`${BUNDLE_FILENAME.replace(/\./gu, '\\.')}:(\\d+):(\\d+)`, 'gu');
  for (const m of stack.matchAll(pattern)) {
    const entry = sourceMap.findEntry(Number(m[1]) - 1, Number(m[2]) - 1);
    if (!('originalSource' in entry)) continue;
    const source = entry.originalSource.startsWith('file://') ? fileURLToPath(entry.originalSource) : entry.originalSource;
    const abs = resolve(projectDir, source);
    positions.push({ abs, pos: { file: relative(projectDir, abs), line: entry.originalLine + 1, column: entry.originalColumn + 1 } });
  }
  const own = positions.find((p) => !p.abs.startsWith(PACKAGES_DIR) && !p.abs.includes('/node_modules/'));
  return (own ?? positions[0])?.pos;
}

function isDiagnostic(value: unknown): value is Diagnostic {
  return isRecord(value) && typeof value['code'] === 'string' && typeof value['problem'] === 'string' && typeof value['errorClass'] === 'string' && Array.isArray(value['suggestions']) && (value['severity'] === 'error' || value['severity'] === 'warning' || value['severity'] === 'info');
}

function runtimeError(error: OpenVideoError, map: string, projectDir: string): OpenVideoError {
  const details = error.diagnostic.details ?? {};
  const stack = details['stack'];
  const pos = typeof stack === 'string' ? mapStack(stack, map, projectDir) : undefined;
  const where = pos === undefined ? {} : { file: pos.file, line: pos.line, column: pos.column };
  const raw = details['diagnostic'];
  const inner: unknown = typeof raw === 'string' ? JSON.parse(raw) : undefined;
  if (isDiagnostic(inner)) {
    return new OpenVideoError({ ...inner, details: { ...where, ...(inner.details ?? {}) }, cause: error });
  }
  const at = pos === undefined ? '' : ` (${pos.file}:${String(pos.line)}:${String(pos.column)})`;
  return new OpenVideoError({
    code: 'OV_COMPILE_RUNTIME',
    errorClass: 'CompileError',
    problem: `${String(details['errorName'])}: ${String(details['errorMessage'])}${at}`,
    details: { ...where, ...(typeof stack === 'string' ? { stack } : {}) },
    suggestions: pos === undefined ? ['Check the stack in the details.'] : [`Fix ${pos.file} line ${String(pos.line)}.`],
    cause: error,
  });
}

/** Sucht `meta.source` einer Node in allen Compositions. */
function sourceOf(project: IrProject, nodeId: string | undefined, compositionId: string | undefined): SourcePosition | undefined {
  if (nodeId === undefined) return undefined;
  const walk = (list: readonly unknown[]): SourcePosition | undefined => {
    for (const n of list) {
      if (!isRecord(n)) continue;
      if (n['id'] === nodeId) {
        const meta = n['meta'];
        const source = isRecord(meta) ? meta['source'] : undefined;
        if (isRecord(source) && typeof source['file'] === 'string' && typeof source['line'] === 'number' && typeof source['column'] === 'number') {
          return { file: source['file'], line: source['line'], column: source['column'] };
        }
        return undefined;
      }
      const children = n['children'];
      const hit = Array.isArray(children) ? walk(children) : undefined;
      if (hit !== undefined) return hit;
    }
    return undefined;
  };
  for (const c of project.compositions) {
    if (compositionId !== undefined && c.id !== compositionId) continue;
    const hit = walk(c.nodes);
    if (hit !== undefined) return hit;
  }
  return undefined;
}

function withSource(project: IrProject, d: Diagnostic): Diagnostic {
  const pos = sourceOf(project, d.nodeId, d.compositionId);
  return pos === undefined ? d : { ...d, details: { ...(d.details ?? {}), file: pos.file, line: pos.line, column: pos.column } };
}

/**
 * Kompiliert eine TSX-Composition zur IR. Standard ist die Auswertung im Docker-Container.
 *
 * @example
 * ```ts
 * const { project, diagnostics } = await compileTsx('video.tsx', { projectDir: '/proj' });
 * ```
 */
export async function compileTsx(entryPath: string, options: CompileOptions): Promise<CompileResult> {
  const projectDir = resolve(options.projectDir);
  const bundle = await bundleTsx(entryPath, projectDir);
  const code = `${bundle.code}\n;${GLOBAL_NAME}.result;\n`;
  let result;
  try {
    result = await runSandboxed({ code, mode: options.mode ?? 'docker', filename: BUNDLE_FILENAME, ...(options.limits !== undefined ? { limits: options.limits } : {}) });
  } catch (error) {
    if (error instanceof OpenVideoError && error.diagnostic.code === 'OV_SANDBOX_CRASH' && error.diagnostic.details?.['stack'] !== undefined) {
      throw runtimeError(error, bundle.map, projectDir);
    }
    throw error;
  }
  const output = result.output;
  const project = isRecord(output) ? output['project'] : undefined;
  const sdkDiagnostics = isRecord(output) && Array.isArray(output['diagnostics']) ? output['diagnostics'].filter(isDiagnostic) : [];
  if (!isIrProjectShape(project)) {
    throw compileError('OV_COMPILE_OUTPUT', 'The composition did not produce an IR project.', ['export default composition({ … }) or project({ … }) from the entry file.']);
  }
  const validation = validateProject(project).diagnostics;
  return {
    project,
    diagnostics: [...sdkDiagnostics, ...validation].map((d) => withSource(project, d)),
    bundleHash: `sha256:${sha256Hex(bundle.code)}`,
    trusted: result.trusted,
  };
}
