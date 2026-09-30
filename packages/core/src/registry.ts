/**
 * Register für Node-Typen, Komponenten, Backends und Plugins (AD-12, FR-84).
 *
 * Es gibt kein globales Register. Jede Anwendung erzeugt ein `Registry`-Objekt
 * und reicht es explizit weiter.
 */
import { NODE_SCHEMAS, OpenVideoError, type Diagnostic, type IrNode, type Theme } from '@agentic-video/schema';
import type { TObject } from 'typebox';
import type { RenderBackend, RgbaImage } from './contracts.js';

/** Kontext beim Expandieren von Komponenten und Makro-Nodes. */
export interface ExpandContext {
  readonly id: string;
  /** Lokaler Frame der expandierten Node. */
  readonly frame: number;
  readonly fps: number;
  readonly seed: number;
  readonly durationFrames: number;
  readonly compositionWidth: number;
  readonly compositionHeight: number;
  readonly theme: Theme;
  /** Die gesamte IR (nur lesen), z. B. für Untertitel-Tracks. */
  readonly project: Readonly<Record<string, unknown>>;
  readonly compositionId: string;
}

/** Eine Komponente: reine Funktion von Props, Theme und Kontext auf IR-Nodes (AD-11). */
export interface ComponentDefinition {
  readonly name: string;
  readonly description: string;
  /** Schema der Props (für Validierung und Doku). */
  readonly propsSchema?: TObject;
  /** Kleines, lauffähiges Beispiel (FR-93). */
  readonly example: Readonly<Record<string, unknown>>;
  /** Erzeugt Kind-Nodes mit lokalen IDs; Animationen laufen in lokaler Zeit der Komponente. */
  expand(props: Readonly<Record<string, unknown>>, ctx: ExpandContext): IrNode[];
}

/** Ein Makro-Node-Typ, der zur Auswertungszeit in normale Nodes expandiert (z. B. `subtitles`). */
export interface NodeExpander {
  readonly type: string;
  expand(node: Readonly<Record<string, unknown>>, ctx: ExpandContext): IrNode[];
}

/** Zusätzlicher Node-Typ aus einem Plugin. */
export interface NodeTypeDefinition {
  readonly type: string;
  readonly schema: TObject;
  /** Standard-Backend für diesen Typ. */
  readonly backend: string;
}

/** Layer-Effekt aus einem Plugin; der Compositor ruft ihn auf. */
export interface EffectDefinition {
  readonly type: string;
  readonly schema: TObject;
  apply(image: RgbaImage, params: Readonly<Record<string, unknown>>): RgbaImage;
}

/**
 * Lädt und untersucht einen Asset-Typ. Die Asset-Pipeline nutzt den Loader für Dateien mit einer
 * seiner Endungen (vor der eingebauten Erkennung); `inspect` liefert die Metadaten.
 */
export interface AssetLoaderDefinition {
  readonly id: string;
  /** Dateiendungen ohne Punkt, klein geschrieben, z. B. `['csv']`. */
  readonly extensions: readonly string[];
  /** Asset-Typ aus dem Schema (`image`, `data` …), unter dem das Asset geführt wird. */
  readonly type: string;
  inspect(bytes: Uint8Array, fileName: string): Promise<Readonly<Record<string, unknown>>>;
}

/**
 * Ergänzt einen Video-Codec (`codec: 'plugin:<id>'` im Render-Profil). Der Encoder nutzt die
 * Argumente von `encoderArgs` an Stelle der eingebauten Video-Argumente (nach der Eingabe,
 * vor dem Muxer).
 *
 * Vertrag für `encoderArgs` (Allowlist, geprüft von `checkCustomCodecArgs` in
 * `@agentic-video/ffmpeg`, sonst `OV_ENCODE_CODEC_ARGS`):
 * - Die Liste besteht nur aus Paaren `-option wert`; jedes Nicht-Optionsargument folgt direkt
 *   auf eine erlaubte wertbehaftete Option. Positionale Argumente (z. B. eine zweite Ausgabe)
 *   sind damit ausgeschlossen.
 * - Erlaubt sind Video-Encoder-Optionen: `-c:v`/`-codec:v`/`-vcodec` (Pflicht, Encoder-Name),
 *   `-crf`, `-qp`, `-q:v`, `-cq`, `-global_quality`, `-qmin`, `-qmax`, `-b:v`, `-minrate`,
 *   `-maxrate`, `-bufsize`, `-preset`, `-tune`, `-profile:v`, `-level`, `-pix_fmt`, `-tag:v`,
 *   `-colorspace`, `-color_primaries`, `-color_trc`, `-color_range`, `-g`, `-keyint_min`, `-bf`,
 *   `-refs`, `-sc_threshold`, `-row-mt`, `-cpu-used`, `-deadline`, `-quality`, `-speed`,
 *   `-tiles`, `-tile-columns`, `-tile-rows`, `-lag-in-frames`, `-auto-alt-ref`, `-aq-mode`,
 *   `-lossless` (jeweils auch mit `:v`), `-x264-params`/`-x265-params`/`-svtav1-params`/`-aom-params`
 *   (nur bekannte Schlüssel, Werte ohne Pfade) und `-movflags` (nur bekannte Flags).
 * - Verboten sind u. a. Eingaben (`-i`), Ausgaben, Muxer (`-f`), Mappings, alle Filter
 *   (`-vf`, `-filter*`, `-lavfi`), `-threads` (setzt OpenVideo), `-r`, `-s`, `-progress`,
 *   `-report`, Statistik-/Log-Dateien und URLs.
 */
export interface CodecDefinition {
  readonly id: string;
  /** Container-Formate, in denen der Codec erlaubt ist, z. B. `['mp4', 'mov']`. */
  readonly formats: readonly string[];
  /** FFmpeg-Argumente für den Video-Encoder, z. B. `['-c:v', 'libx264', '-crf', '18', '-pix_fmt', 'yuv420p']`. */
  encoderArgs(options: { readonly quality: number; readonly alpha: boolean }): readonly string[];
  /** Lizenz des Encoders (für das Render-Manifest). */
  readonly license: string;
}

/** Ergebnis einer Sprachsynthese. */
export interface VoiceResult {
  /** WAV-Bytes. */
  readonly audio: Uint8Array;
  /** Wortzeiten in Sekunden, falls der Provider sie liefert. */
  readonly words?: readonly { readonly text: string; readonly start: number; readonly end: number }[];
}

/** Anfrage an einen Voice-Provider. */
export interface VoiceRequest {
  readonly text: string;
  readonly voice?: string;
  readonly language?: string;
  readonly rate?: number;
  readonly options?: Readonly<Record<string, string | number | boolean>>;
}

/** Lokale Sprachsynthese (FR-58). */
export interface VoiceProvider {
  readonly id: string;
  /** Version des Modells/Programms; Teil des Cache-Schlüssels. */
  version(): Promise<string>;
  available(): Promise<boolean>;
  synthesize(request: VoiceRequest): Promise<VoiceResult>;
}

/** Ergebnis einer Transkription. */
export interface Transcript {
  readonly language?: string;
  readonly cues: readonly {
    readonly start: number;
    readonly end: number;
    readonly text: string;
    readonly words?: readonly { readonly text: string; readonly start: number; readonly end: number }[];
  }[];
}

/** Lokale Spracherkennung (FR-57). */
export interface AsrProvider {
  readonly id: string;
  version(): Promise<string>;
  available(): Promise<boolean>;
  transcribe(wavPath: string, options?: { readonly language?: string }): Promise<Transcript>;
}

/**
 * Exportiert ein gerendertes Ergebnis in ein eigenes Ausgabeformat (`format: 'plugin:<id>'`).
 * Der Host rendert die Frames als PNG-Folge (`frame-000000.png` …, gerades Alpha) nach
 * `framesDir`, mischt den Ton als WAV (`audioPath`, falls vorhanden) und ruft dann `export`.
 */
export interface ExporterDefinition {
  readonly id: string;
  readonly description: string;
  /** Dateiendung der Ausgabe (ohne Punkt), nur zur Information für Agents und Doku. */
  readonly extension?: string;
  /** Erzeugt `outPath`; darf `{ outputs: string[] }` mit weiteren geschriebenen Dateien liefern. */
  export(input: { readonly framesDir: string; readonly frameCount: number; readonly width: number; readonly height: number; readonly audioPath?: string; readonly outPath: string; readonly fps: number }): Promise<unknown>;
}

/**
 * Zusätzliches Studio-Panel: ein ES-Modul, das das Studio in einem Panel-Tab lädt (sandboxed iframe).
 * Das Modul exportiert `default(root: HTMLElement, ctx)`; siehe docs/guide/plugins.md.
 */
export interface StudioPanelDefinition {
  readonly id: string;
  readonly title: string;
  /** Modul-Pfad relativ zum Einstiegsmodul des Plugins. */
  readonly module: string;
  /** Name des Plugins, das das Panel registriert hat (setzt {@link Registry.use}). */
  readonly plugin?: string;
}

/**
 * Zusätzliches Agent-Werkzeug. API, MCP und `openvideo op` bieten es als Operation
 * `plugin.<name>` an (Eingabe: `projectId` plus `inputSchema`).
 */
export interface AgentToolDefinition {
  /** Name ohne Präfix, z. B. `hello.greet` → Operation `plugin.hello.greet`. */
  readonly name: string;
  readonly description: string;
  readonly inputSchema: TObject;
  handler(input: unknown): Promise<unknown>;
  /** Name des Plugins, das das Werkzeug registriert hat (setzt {@link Registry.use}). */
  readonly plugin?: string;
}

/** Alle Rechte, die ein Plugin anfordern kann. */
export const PERMISSIONS = ['fs:read', 'fs:write', 'net', 'process:spawn', 'env'] as const;

/** Rechte, die ein Plugin anfordern kann. */
export type Permission = (typeof PERMISSIONS)[number];

/**
 * Prüft, ob ein Wert ein Recht ist.
 *
 * @example
 * ```ts
 * isPermission('net'); // true
 * ```
 */
export function isPermission(value: unknown): value is Permission {
  return PERMISSIONS.some((p) => p === value);
}

/** Dienste, die der Host bereitstellt; Plugins sehen nur die freigegebenen. */
export interface HostServices {
  readFile(path: string): Promise<Uint8Array>;
  writeFile(path: string, data: Uint8Array): Promise<void>;
  fetch(url: string): Promise<Uint8Array>;
  spawn(command: string, args: readonly string[], options?: { readonly input?: Uint8Array; readonly timeoutMs?: number }): Promise<{ readonly code: number; readonly stdout: Uint8Array; readonly stderr: string }>;
  env(name: string): string | undefined;
}

/** Kontext, den ein Plugin bei `setup` erhält. Enthält nur freigegebene Dienste. */
export interface PluginContext {
  readonly name: string;
  readonly readFile?: HostServices['readFile'];
  readonly writeFile?: HostServices['writeFile'];
  readonly fetch?: HostServices['fetch'];
  readonly spawn?: HostServices['spawn'];
  readonly env?: HostServices['env'];
  registerNodeType(def: NodeTypeDefinition): void;
  registerComponent(def: ComponentDefinition): void;
  registerExpander(def: NodeExpander): void;
  registerBackend(backend: RenderBackend): void;
  registerAssetLoader(def: AssetLoaderDefinition): void;
  registerEffect(def: EffectDefinition): void;
  registerCodec(def: CodecDefinition): void;
  registerVoiceProvider(def: VoiceProvider): void;
  registerAsrProvider(def: AsrProvider): void;
  registerExporter(def: ExporterDefinition): void;
  registerStudioPanel(def: StudioPanelDefinition): void;
  registerAgentTool(def: AgentToolDefinition): void;
}

/**
 * Ein Plugin.
 *
 * @example
 * ```ts
 * const plugin: Plugin = {
 *   name: 'my-voice',
 *   version: '1.0.0',
 *   permissions: ['process:spawn'],
 *   setup(ctx) { ctx.registerVoiceProvider(createMyProvider(ctx.spawn!)); },
 * };
 * ```
 */
export interface Plugin {
  readonly name: string;
  readonly version: string;
  readonly permissions: readonly Permission[];
  setup(ctx: PluginContext): void | Promise<void>;
}

/**
 * Prüft die Form eines geladenen Plugin-Moduls (Name, Version, bekannte Rechte, `setup`).
 *
 * @example
 * ```ts
 * const mod: unknown = await import(url);
 * if (isRecord(mod) && isPlugin(mod['default'])) await registry.use(mod['default'], host);
 * ```
 */
export function isPlugin(value: unknown): value is Plugin {
  if (typeof value !== 'object' || value === null) return false;
  if (!('name' in value) || typeof value.name !== 'string' || value.name === '') return false;
  if (!('version' in value) || typeof value.version !== 'string') return false;
  if (!('permissions' in value) || !Array.isArray(value.permissions) || !value.permissions.every(isPermission)) return false;
  return 'setup' in value && typeof value.setup === 'function';
}

/** Eintrag eines geladenen Plugins in {@link Registry.plugins}. */
export interface LoadedPlugin {
  readonly name: string;
  readonly version: string;
  readonly permissions: readonly Permission[];
  /** Absoluter Pfad des Einstiegsmoduls (für Studio-Panels relativ dazu), falls bekannt. */
  readonly origin?: string;
}

/** Eingebauter Standard-Backend je Node-Typ. */
export const DEFAULT_BACKENDS: Readonly<Record<string, string>> = {
  group: 'skia',
  rect: 'skia',
  ellipse: 'skia',
  line: 'skia',
  polyline: 'skia',
  polygon: 'skia',
  path: 'skia',
  text: 'skia',
  'rich-text': 'skia',
  image: 'skia',
  video: 'skia',
  svg: 'skia',
  sprite: 'skia',
  lottie: 'skia',
  shader: 'skia',
  particles: 'skia',
  html: 'browser',
  scene3d: 'three',
  blender: 'blender',
};

/** Node-Typen, die ein 2D-Backend (skia, pixi) als Einheit behandeln kann. */
export const NODE_TYPES_2D: readonly string[] = ['group', 'rect', 'ellipse', 'line', 'polyline', 'polygon', 'path', 'text', 'rich-text', 'image', 'video', 'svg', 'sprite', 'lottie', 'shader', 'particles'];

/** Namen, die in Operationen (`plugin.<name>`), Formaten (`plugin:<id>`) und URLs vorkommen. */
const PLUGIN_NAME = /^[A-Za-z][A-Za-z0-9_.-]{0,63}$/u;

function checkName(kind: string, name: string): void {
  if (!PLUGIN_NAME.test(name)) {
    throw new OpenVideoError({
      code: 'OV_REGISTRY_NAME',
      errorClass: 'RegistryError',
      problem: `${kind} name "${name}" is not valid; it is used in operation names, output formats and URLs.`,
      expected: '^[A-Za-z][A-Za-z0-9_.-]{0,63}$',
      received: JSON.stringify(name),
      suggestions: ['Use letters, digits, ".", "_" and "-", starting with a letter (e.g. "hello.greet").'],
    });
  }
}

function duplicate(kind: string, name: string): OpenVideoError {
  return new OpenVideoError({
    code: 'OV_REGISTRY_DUPLICATE',
    errorClass: 'RegistryError',
    problem: `${kind} "${name}" is already registered.`,
    suggestions: ['Use a unique name, or create a separate Registry.'],
  });
}

/**
 * Register aller Erweiterungen. Kein Singleton: jede Instanz ist unabhängig.
 *
 * @example
 * ```ts
 * const registry = new Registry();
 * registry.registerBackend(createSkiaBackend(canvasKit));
 * await registry.use(myPlugin, hostServices);
 * ```
 */
export class Registry {
  readonly nodeTypes = new Map<string, NodeTypeDefinition>();
  readonly components = new Map<string, ComponentDefinition>();
  readonly expanders = new Map<string, NodeExpander>();
  readonly backends = new Map<string, RenderBackend>();
  readonly assetLoaders = new Map<string, AssetLoaderDefinition>();
  readonly effects = new Map<string, EffectDefinition>();
  readonly codecs = new Map<string, CodecDefinition>();
  readonly voiceProviders = new Map<string, VoiceProvider>();
  readonly asrProviders = new Map<string, AsrProvider>();
  readonly exporters = new Map<string, ExporterDefinition>();
  readonly studioPanels = new Map<string, StudioPanelDefinition>();
  readonly agentTools = new Map<string, AgentToolDefinition>();
  readonly plugins: LoadedPlugin[] = [];

  registerNodeType(def: NodeTypeDefinition): void {
    if (def.type in NODE_SCHEMAS || this.nodeTypes.has(def.type)) throw duplicate('Node type', def.type);
    this.nodeTypes.set(def.type, def);
  }

  registerComponent(def: ComponentDefinition): void {
    if (this.components.has(def.name)) throw duplicate('Component', def.name);
    this.components.set(def.name, def);
  }

  registerExpander(def: NodeExpander): void {
    if (this.expanders.has(def.type)) throw duplicate('Expander', def.type);
    this.expanders.set(def.type, def);
  }

  registerBackend(backend: RenderBackend): void {
    if (this.backends.has(backend.id)) throw duplicate('Backend', backend.id);
    this.backends.set(backend.id, backend);
  }

  registerAssetLoader(def: AssetLoaderDefinition): void {
    checkName('Asset loader', def.id);
    if (this.assetLoaders.has(def.id)) throw duplicate('Asset loader', def.id);
    this.assetLoaders.set(def.id, def);
  }

  registerEffect(def: EffectDefinition): void {
    if (this.effects.has(def.type)) throw duplicate('Effect', def.type);
    this.effects.set(def.type, def);
  }

  registerCodec(def: CodecDefinition): void {
    checkName('Codec', def.id);
    if (this.codecs.has(def.id)) throw duplicate('Codec', def.id);
    this.codecs.set(def.id, def);
  }

  registerVoiceProvider(def: VoiceProvider): void {
    if (this.voiceProviders.has(def.id)) throw duplicate('Voice provider', def.id);
    this.voiceProviders.set(def.id, def);
  }

  registerAsrProvider(def: AsrProvider): void {
    if (this.asrProviders.has(def.id)) throw duplicate('ASR provider', def.id);
    this.asrProviders.set(def.id, def);
  }

  registerExporter(def: ExporterDefinition): void {
    checkName('Exporter', def.id);
    if (this.exporters.has(def.id)) throw duplicate('Exporter', def.id);
    this.exporters.set(def.id, def);
  }

  registerStudioPanel(def: StudioPanelDefinition): void {
    checkName('Studio panel', def.id);
    if (this.studioPanels.has(def.id)) throw duplicate('Studio panel', def.id);
    this.studioPanels.set(def.id, def);
  }

  registerAgentTool(def: AgentToolDefinition): void {
    checkName('Agent tool', def.name);
    if (this.agentTools.has(def.name)) throw duplicate('Agent tool', def.name);
    this.agentTools.set(def.name, def);
  }

  /** Standard-Backend eines Node-Typs. */
  backendFor(type: string, renderer2d: string = 'skia'): string | undefined {
    const plugin = this.nodeTypes.get(type);
    if (plugin !== undefined) return plugin.backend;
    const builtin = DEFAULT_BACKENDS[type];
    if (builtin === 'skia' && renderer2d !== 'skia') return renderer2d;
    return builtin;
  }

  /**
   * Wählt das Backend einer IR-Node (oder der Eigenschaften einer ausgewerteten Node) und
   * entscheidet über den Rückfall auf Skia (ADR 0018): Ist `renderer2d` nicht `skia`, die Node
   * ohne explizites `renderer` und meldet das gewählte 2D-Backend für ihre eigenen Eigenschaften
   * (ohne Kinder und Maske) eine Warnung oder einen Fehler, rendert Skia die Node. `fallback`
   * enthält dann die Info-Diagnose `OV_PIXI_FALLBACK` (bzw. `OV_<BACKEND>_FALLBACK`).
   *
   * @example
   * ```ts
   * const { backend, fallback } = registry.resolveBackend({ id: 't', type: 'text', text: 'Hi', shadow: { color: '#000', blur: 4 } }, 'pixi');
   * // backend === 'skia', fallback?.code === 'OV_PIXI_FALLBACK'
   * ```
   */
  resolveBackend(node: Readonly<Record<string, unknown>>, renderer2d: string = 'skia'): { readonly backend: string | undefined; readonly fallback?: Diagnostic } {
    const type = typeof node['type'] === 'string' ? node['type'] : '';
    const explicit = typeof node['renderer'] === 'string' ? node['renderer'] : undefined;
    if (explicit !== undefined) return { backend: explicit };
    const chosen = this.backendFor(type, renderer2d);
    if (chosen === undefined || renderer2d === 'skia' || chosen !== renderer2d || DEFAULT_BACKENDS[type] !== 'skia') return { backend: chosen };
    const backend2d = this.backends.get(chosen);
    if (backend2d === undefined || !this.backends.has('skia')) return { backend: chosen };
    const { children: _children, mask: _mask, ...own } = node;
    const blocking = backend2d.check(own).diagnostics.filter((d) => d.severity !== 'info');
    if (blocking.length === 0) return { backend: chosen };
    const features = [...new Set(blocking.map((d) => { const f = d.details?.['feature']; return typeof f === 'string' ? f : d.code; }))];
    const id = typeof node['id'] === 'string' ? node['id'] : '(unknown)';
    return {
      backend: 'skia',
      fallback: {
        code: `OV_${chosen.toUpperCase().replace(/[^A-Z0-9]/g, '_')}_FALLBACK`,
        severity: 'info',
        errorClass: 'RendererError',
        problem: `The ${chosen} renderer cannot draw ${type} node "${id}" as specified (${features.join(', ')}); Skia renders this node instead.`,
        nodeId: id,
        details: { from: chosen, to: 'skia', features: features.join(', ') },
        suggestions: [`Nothing to do: the node is rendered by Skia. Set renderer: '${chosen}' on the node to force ${chosen} and accept its limits.`],
      },
    };
  }

  /** Zusätzliche Node-Schemas für die Validierung. */
  extraNodeSchemas(): Record<string, TObject> {
    return Object.fromEntries([...this.nodeTypes.values()].map((d) => [d.type, d.schema]));
  }

  /**
   * Lädt ein Plugin. Das Plugin erhält nur die Dienste, die es in `permissions` deklariert und
   * die der Host bereitstellt (`host`); fehlt ein angefordertes Recht, bricht `use` mit
   * `OV_PLUGIN_PERMISSION` ab, bevor `setup` läuft. `origin` ist der Pfad des Einstiegsmoduls.
   */
  async use(plugin: Plugin, host: Partial<HostServices> = {}, options: { readonly origin?: string } = {}): Promise<void> {
    if (this.plugins.some((p) => p.name === plugin.name)) throw duplicate('Plugin', plugin.name);
    const allowed = new Set(plugin.permissions);
    const missing = (p: Permission) =>
      new OpenVideoError({
        code: 'OV_PLUGIN_PERMISSION',
        errorClass: 'PluginError',
        problem: `Plugin "${plugin.name}" requests "${p}", but the host does not grant it.`,
        details: { plugin: plugin.name, permission: p },
        suggestions: [`Grant it explicitly: OPENVIDEO_PLUGIN_PERMISSIONS=${p} (comma-separated list), or the host option plugins.permissions.`, 'Remove the permission from the plugin if it does not need it.'],
      });
    const need = <T>(perm: Permission, fn: T | undefined): T => {
      if (fn === undefined) throw missing(perm);
      return fn;
    };
    const ctx: PluginContext = {
      name: plugin.name,
      ...(allowed.has('fs:read') ? { readFile: need('fs:read', host.readFile) } : {}),
      ...(allowed.has('fs:write') ? { writeFile: need('fs:write', host.writeFile) } : {}),
      ...(allowed.has('net') ? { fetch: need('net', host.fetch) } : {}),
      ...(allowed.has('process:spawn') ? { spawn: need('process:spawn', host.spawn) } : {}),
      ...(allowed.has('env') ? { env: need('env', host.env) } : {}),
      registerNodeType: (d) => {
        this.registerNodeType(d);
      },
      registerComponent: (d) => {
        this.registerComponent(d);
      },
      registerExpander: (d) => {
        this.registerExpander(d);
      },
      registerBackend: (d) => {
        this.registerBackend(d);
      },
      registerAssetLoader: (d) => {
        this.registerAssetLoader(d);
      },
      registerEffect: (d) => {
        this.registerEffect(d);
      },
      registerCodec: (d) => {
        this.registerCodec(d);
      },
      registerVoiceProvider: (d) => {
        this.registerVoiceProvider(d);
      },
      registerAsrProvider: (d) => {
        this.registerAsrProvider(d);
      },
      registerExporter: (d) => {
        this.registerExporter(d);
      },
      registerStudioPanel: (d) => {
        this.registerStudioPanel({ ...d, plugin: plugin.name });
      },
      registerAgentTool: (d) => {
        this.registerAgentTool({ name: d.name, description: d.description, inputSchema: d.inputSchema, handler: (input) => d.handler(input), plugin: plugin.name });
      },
    };
    await plugin.setup(ctx);
    this.plugins.push({ name: plugin.name, version: plugin.version, permissions: [...plugin.permissions], ...(options.origin !== undefined ? { origin: options.origin } : {}) });
  }

  /** Prüft alle Nodes eines Projects gegen die Backends (FR-44). */
  checkNodes(nodes: Iterable<Readonly<Record<string, unknown>>>, renderer2d = 'skia'): Diagnostic[] {
    const out: Diagnostic[] = [];
    for (const node of nodes) {
      const type = typeof node['type'] === 'string' ? node['type'] : '';
      const resolved = this.resolveBackend(node, renderer2d);
      const backendId = resolved.backend;
      if (backendId === undefined) continue;
      if (resolved.fallback !== undefined) out.push(resolved.fallback);
      const backend = this.backends.get(backendId);
      if (backend === undefined) {
        out.push({
          code: 'OV_BACKEND_MISSING',
          severity: 'error',
          errorClass: 'RendererError',
          problem: `No "${backendId}" backend is available to render ${type} node "${String(node['id'])}".`,
          nodeId: String(node['id']),
          suggestions: [`Run \`openvideo doctor\` to see why the ${backendId} backend is unavailable.`],
        });
        continue;
      }
      // Nach dem Rückfall-Entscheid prüft das 2D-Backend nur die eigenen Eigenschaften;
      // Kinder und Maske werden als eigene Nodes geprüft und fallen einzeln zurück.
      const isDefault2d = renderer2d !== 'skia' && backendId === renderer2d && node['renderer'] === undefined;
      const { children: _children, mask: _mask, ...own } = node;
      out.push(...backend.check(isDefault2d ? own : node).diagnostics);
    }
    return out;
  }
}
