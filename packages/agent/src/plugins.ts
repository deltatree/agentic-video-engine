/**
 * Plugins in der Agent API (Story 21.1): `plugins.list` beschreibt, was die Plugins eines Projekts
 * registrieren; Agent Tools sind Operationen `plugin.<name>` (API, MCP, `openvideo op`); Studio
 * Panels werden als eigene, sandboxed Seiten ausgeliefert.
 */
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { readFile, realpath } from 'node:fs/promises';
import { dirname, isAbsolute, relative, resolve } from 'node:path';
import Type from 'typebox';
import { OpenVideoError, isRecord, validateValue, type Registry } from '@agentic-video/core';
import type { OperationContext, OperationDefinition } from './operation.js';
import { formatSegments } from './patch-schema.js';
import { assertProjectAccess } from './project-access.js';
import type { AgentServices } from './services.js';
import { AnyObject, ProjectId, loadProject, withEnv } from './shared.js';

/** Präfix der Operationen aus Agent Tools. */
export const PLUGIN_OPERATION_PREFIX = 'plugin.';

/** Präfix der Studio-Panel-Seiten (ohne Bearer-Token erreichbar, durch Signatur geschützt). */
export const PLUGIN_PANEL_PATH = '/plugin-panels/';

// Schlüssel je Dienste-Objekt (kein globaler Zustand): signiert Panel-URLs für die Dauer des Servers.
const secrets = new WeakMap<AgentServices, Buffer>();

function secretOf(services: AgentServices): Buffer {
  let s = secrets.get(services);
  if (s === undefined) {
    s = randomBytes(32);
    secrets.set(services, s);
  }
  return s;
}

function signature(services: AgentServices, projectId: string, panelId: string): string {
  return createHmac('sha256', secretOf(services)).update(`${projectId}\n${panelId}`).digest('hex').slice(0, 32);
}

/**
 * URL der Seite eines Studio-Panels. Die Signatur ersetzt das Bearer-Token, das ein iframe nicht
 * senden kann; sie gilt nur für dieses Projekt, dieses Panel und diesen Serverprozess.
 *
 * @example
 * ```ts
 * pluginPanelUrl(services, 'demo', 'hello-panel'); // '/plugin-panels/demo/hello-panel/3f…/'
 * ```
 */
export function pluginPanelUrl(services: AgentServices, projectId: string, panelId: string): string {
  return `${PLUGIN_PANEL_PATH}${projectId}/${panelId}/${signature(services, projectId, panelId)}/`;
}

/** Beschreibung aller Plugin-Einträge eines Registers. */
function describeRegistry(services: AgentServices, projectId: string, registry: Registry): Record<string, unknown> {
  return {
    plugins: registry.plugins.map((p) => ({ name: p.name, version: p.version, permissions: [...p.permissions] })),
    tools: [...registry.agentTools.values()].map((t) => ({ operation: `${PLUGIN_OPERATION_PREFIX}${t.name}`, description: t.description, plugin: t.plugin ?? null, input: t.inputSchema })),
    codecs: [...registry.codecs.values()].map((c) => ({ codec: `plugin:${c.id}`, formats: [...c.formats], license: c.license })),
    exporters: [...registry.exporters.values()].map((e) => ({ format: `plugin:${e.id}`, description: e.description, ...(e.extension !== undefined ? { extension: e.extension } : {}) })),
    assetLoaders: [...registry.assetLoaders.values()].map((l) => ({ id: l.id, type: l.type, extensions: [...l.extensions] })),
    studioPanels: [...registry.studioPanels.values()].map((p) => ({ id: p.id, title: p.title, plugin: p.plugin ?? null, url: pluginPanelUrl(services, projectId, p.id) })),
  };
}

/** Operation `plugins.list`. */
export const pluginsList: OperationDefinition = {
  name: 'plugins.list',
  summary: 'List the plugins of a project and what they add: agent tools (operations plugin.<name>), codecs, exporters (output formats plugin:<id>), asset loaders and Studio panels.',
  input: Type.Object({ projectId: ProjectId }, { additionalProperties: false }),
  output: Type.Object({ plugins: Type.Array(AnyObject), tools: Type.Array(AnyObject), codecs: Type.Array(AnyObject), exporters: Type.Array(AnyObject), assetLoaders: Type.Array(AnyObject), studioPanels: Type.Array(AnyObject) }),
  example: { input: { projectId: 'launch-video' } },
  async handler(input: unknown, ctx: OperationContext) {
    const projectId = isRecord(input) && typeof input['projectId'] === 'string' ? input['projectId'] : '';
    const loaded = await loadProject(ctx, projectId);
    return withEnv(ctx, loaded, (env) => Promise.resolve(describeRegistry(ctx.services, projectId, env.registry)));
  },
};

/**
 * Ist `name` eine Operation aus einem Agent Tool (`plugin.<name>`)?
 *
 * @example
 * ```ts
 * isPluginOperation('plugin.hello.greet'); // true
 * ```
 */
export function isPluginOperation(name: string): boolean {
  return name.startsWith(PLUGIN_OPERATION_PREFIX) && name.length > PLUGIN_OPERATION_PREFIX.length;
}

/**
 * Operation für ein Agent Tool. Die Eingabe ist `projectId` plus die Felder des Tool-Schemas;
 * das Tool kommt aus den Plugins des Projekts.
 *
 * @example
 * ```ts
 * const op = pluginOperation('plugin.hello.greet');
 * await op.handler({ projectId: 'demo', name: 'Ada' }, ctx);
 * ```
 */
export function pluginOperation(name: string): OperationDefinition {
  const toolName = name.slice(PLUGIN_OPERATION_PREFIX.length);
  return {
    name,
    summary: `Agent tool "${toolName}" from a project plugin (see plugins.list).`,
    input: Type.Object({ projectId: ProjectId }, { additionalProperties: true }),
    output: AnyObject,
    example: { input: { projectId: 'launch-video' } },
    async handler(input: unknown, ctx: OperationContext) {
      if (!isRecord(input) || typeof input['projectId'] !== 'string') throw new OpenVideoError({ code: 'OV_API_INPUT', errorClass: 'ApiError', problem: `${name} needs "projectId".`, suggestions: ['{ "projectId": "launch-video", … }'] });
      const { projectId, ...rest } = input;
      await assertProjectAccess(ctx.services, projectId);
      const loaded = await loadProject(ctx, projectId);
      return withEnv(ctx, loaded, async (env) => {
        const tool = env.registry.agentTools.get(toolName);
        if (tool === undefined) {
          const known = [...env.registry.agentTools.keys()].map((k) => `${PLUGIN_OPERATION_PREFIX}${k}`);
          throw new OpenVideoError({
            code: 'OV_API_UNKNOWN_OPERATION',
            errorClass: 'ApiError',
            problem: `Project "${projectId}" has no plugin agent tool "${toolName}".`,
            received: JSON.stringify(name),
            suggestions: [known.length > 0 ? `Use one of: ${known.join(', ')}.` : 'Add a plugin with agent tools to settings.plugins.', 'Call plugins.list to see the tools of the project.'],
          });
        }
        const issues = validateValue(tool.inputSchema, rest);
        const first = issues[0];
        if (first !== undefined) {
          throw new OpenVideoError({
            code: 'OV_API_INPUT',
            errorClass: 'ApiError',
            problem: `Invalid input for ${name}: ${issues.map((i) => `${formatSegments(i.segments) || '(root)'}: ${i.message}`).join('; ')}`,
            path: formatSegments(first.segments),
            expected: first.expected,
            suggestions: [...(first.suggestion !== undefined ? [first.suggestion] : []), 'Call plugins.list for the input schema of the tool.'],
          });
        }
        const result = await tool.handler(rest);
        return isRecord(result) ? { ...result } : { result: result ?? null };
      });
    },
  };
}

/** Antwort für eine Panel-Anfrage. */
export interface PanelResponse {
  readonly status: number;
  readonly headers: Readonly<Record<string, string>>;
  readonly body: string | Uint8Array;
}

function panelPage(title: string, nonce: string): string {
  const safe = title.replace(/[<>&"]/gu, (c) => `&#${String(c.charCodeAt(0))};`);
  // Das Modul läuft in einer eigenen, undurchsichtigen Origin (CSP sandbox). Das Studio sendet den
  // Kontext per postMessage; Änderungswünsche gehen per postMessage zurück.
  return `<!doctype html><html><head><meta charset="utf-8"><title>${safe}</title><style>html,body{margin:0;font:13px system-ui,sans-serif;color:#e8e8ea;background:transparent}#root{padding:8px}</style></head><body><div id="root"></div><script type="module" nonce="${nonce}">
const root = document.getElementById('root');
const listeners = new Set();
let project;
const ctx = {
  get project() { return project; },
  onProject(fn) { listeners.add(fn); if (project !== undefined) fn(project); return () => listeners.delete(fn); },
  notify(text) { parent.postMessage({ type: 'openvideo.panel.notify', text: String(text) }, '*'); },
};
addEventListener('message', (e) => {
  if (e.source !== parent || typeof e.data !== 'object' || e.data === null || e.data.type !== 'openvideo.panel.project') return;
  project = e.data.project;
  for (const fn of listeners) fn(project);
});
const mod = await import('./module.js');
if (typeof mod.default === 'function') await mod.default(root, ctx);
parent.postMessage({ type: 'openvideo.panel.ready' }, '*');
</script></body></html>`;
}

function isInside(root: string, full: string): boolean {
  const rel = relative(root, full);
  return rel !== '' && !rel.startsWith('..') && !isAbsolute(rel);
}

/**
 * Liefert die Seite (`…/`) oder das Modul (`…/module.js`) eines Studio-Panels. Ohne gültige
 * Signatur oder ohne Panel kommt 404. Die Seite trägt eine strikte CSP mit `sandbox allow-scripts`.
 *
 * @example
 * ```ts
 * const r = await servePluginPanel(services, '/plugin-panels/demo/hello-panel/3f…/');
 * ```
 */
export async function servePluginPanel(services: AgentServices, pathname: string): Promise<PanelResponse | undefined> {
  if (!pathname.startsWith(PLUGIN_PANEL_PATH)) return undefined;
  const notFound: PanelResponse = { status: 404, headers: { 'content-type': 'text/plain; charset=utf-8' }, body: 'Not found' };
  const parts = pathname.slice(PLUGIN_PANEL_PATH.length).split('/');
  const [projectId, panelId, sig, file] = parts;
  if (projectId === undefined || panelId === undefined || sig === undefined || parts.length !== 4 || (file !== '' && file !== 'module.js')) return notFound;
  const expected = Buffer.from(signature(services, projectId, panelId));
  const given = Buffer.from(sig);
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) return notFound;
  const ctx: OperationContext = { services, via: 'http' };
  await assertProjectAccess(services, projectId);
  const loaded = await loadProject(ctx, projectId);
  return withEnv(ctx, loaded, async (env) => {
    const panel = env.registry.studioPanels.get(panelId);
    const origin = env.registry.plugins.find((p) => p.name === panel?.plugin)?.origin;
    if (panel === undefined || origin === undefined) return notFound;
    const base = dirname(origin);
    const moduleFile = resolve(base, panel.module);
    let real: string;
    try {
      real = await realpath(moduleFile);
    } catch (error) {
      if (error instanceof Error && 'code' in error) return notFound;
      throw error;
    }
    if (!isInside(await realpath(base), real)) return notFound;
    const common = { 'x-content-type-options': 'nosniff', 'referrer-policy': 'no-referrer', 'cache-control': 'no-store' };
    // Die Panel-Seite hat eine undurchsichtige Origin; Modul-Skripte laden mit CORS.
    if (file === 'module.js') return { status: 200, headers: { ...common, 'content-type': 'text/javascript; charset=utf-8', 'access-control-allow-origin': '*' }, body: new Uint8Array(await readFile(real)) };
    const nonce = randomBytes(16).toString('base64');
    return {
      status: 200,
      headers: {
        ...common,
        'content-type': 'text/html; charset=utf-8',
        'content-security-policy': `sandbox allow-scripts; default-src 'none'; script-src 'nonce-${nonce}' 'strict-dynamic'; style-src 'unsafe-inline'; img-src data: blob:; font-src data:; connect-src 'none'; frame-ancestors 'self'; base-uri 'none'; form-action 'none'`,
      },
      body: panelPage(panel.title, nonce),
    };
  });
}
