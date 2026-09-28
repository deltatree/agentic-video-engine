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

/** Lädt und untersucht einen Asset-Typ. */
export interface AssetLoaderDefinition {
  readonly id: string;
  readonly extensions: readonly string[];
  readonly type: string;
  inspect(bytes: Uint8Array, fileName: string): Promise<Readonly<Record<string, unknown>>>;
}

/** Ergänzt einen Video-Codec. */
export interface CodecDefinition {
  readonly id: string;
  readonly formats: readonly string[];
  /** FFmpeg-Argumente für den Encoder. */
  encoderArgs(options: { readonly quality: number; readonly alpha: boolean }): readonly string[];
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

/** Exportiert ein gerendertes Ergebnis in ein weiteres Format. */
export interface ExporterDefinition {
  readonly id: string;
  readonly description: string;
  export(input: { readonly framesDir: string; readonly audioPath?: string; readonly outPath: string; readonly fps: number }): Promise<void>;
}

/** Zusätzliches Studio-Panel (ES-Modul, das im Studio geladen wird). */
export interface StudioPanelDefinition {
  readonly id: string;
  readonly title: string;
  /** Modul-Pfad relativ zum Plugin-Paket. */
  readonly module: string;
}

/** Zusätzliches Agent-Werkzeug. */
export interface AgentToolDefinition {
  readonly name: string;
  readonly description: string;
  readonly inputSchema: TObject;
  handler(input: unknown): Promise<unknown>;
}

/** Rechte, die ein Plugin anfordern kann. */
export type Permission = 'fs:read' | 'fs:write' | 'net' | 'process:spawn' | 'env';

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
  readonly plugins: { readonly name: string; readonly version: string; readonly permissions: readonly Permission[] }[] = [];

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
    if (this.assetLoaders.has(def.id)) throw duplicate('Asset loader', def.id);
    this.assetLoaders.set(def.id, def);
  }

  registerEffect(def: EffectDefinition): void {
    if (this.effects.has(def.type)) throw duplicate('Effect', def.type);
    this.effects.set(def.type, def);
  }

  registerCodec(def: CodecDefinition): void {
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
    if (this.exporters.has(def.id)) throw duplicate('Exporter', def.id);
    this.exporters.set(def.id, def);
  }

  registerStudioPanel(def: StudioPanelDefinition): void {
    if (this.studioPanels.has(def.id)) throw duplicate('Studio panel', def.id);
    this.studioPanels.set(def.id, def);
  }

  registerAgentTool(def: AgentToolDefinition): void {
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

  /** Zusätzliche Node-Schemas für die Validierung. */
  extraNodeSchemas(): Record<string, TObject> {
    return Object.fromEntries([...this.nodeTypes.values()].map((d) => [d.type, d.schema]));
  }

  /**
   * Lädt ein Plugin. Das Plugin erhält nur die Dienste, die es in `permissions` deklariert.
   */
  async use(plugin: Plugin, host: Partial<HostServices> = {}): Promise<void> {
    const allowed = new Set(plugin.permissions);
    const missing = (p: Permission) =>
      new OpenVideoError({
        code: 'OV_PLUGIN_PERMISSION',
        errorClass: 'PluginError',
        problem: `Plugin "${plugin.name}" requests "${p}", but the host does not provide it.`,
        suggestions: ['Run the plugin in a host that grants this permission, or remove it from the plugin.'],
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
        this.registerStudioPanel(d);
      },
      registerAgentTool: (d) => {
        this.registerAgentTool(d);
      },
    };
    await plugin.setup(ctx);
    this.plugins.push({ name: plugin.name, version: plugin.version, permissions: [...plugin.permissions] });
  }

  /** Prüft alle Nodes eines Projects gegen die Backends (FR-44). */
  checkNodes(nodes: Iterable<Readonly<Record<string, unknown>>>, renderer2d = 'skia'): Diagnostic[] {
    const out: Diagnostic[] = [];
    for (const node of nodes) {
      const type = typeof node['type'] === 'string' ? node['type'] : '';
      const explicit = typeof node['renderer'] === 'string' ? node['renderer'] : undefined;
      const backendId = explicit ?? this.backendFor(type, renderer2d);
      if (backendId === undefined) continue;
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
      out.push(...backend.check(node).diagnostics);
    }
    return out;
  }
}
