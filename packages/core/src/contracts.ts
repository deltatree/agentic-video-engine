/**
 * Invariante Verträge zwischen Kern und Adaptern (A52):
 * Evaluated Scene, Renderer-Schnittstelle (AD-5) und Asset-Modell (FR-49).
 */
import type { ColorSpace, Diagnostic } from '@agentic-video/schema';

// ---------------------------------------------------------------------------
// Evaluated Scene
// ---------------------------------------------------------------------------

/** Zeitinformation einer ausgewerteten Node. */
export interface NodeTime {
  /** Frame, an dem Animationen der Node ausgewertet wurden. */
  readonly localFrame: number;
  /** Frame relativ zum Start der Node. */
  readonly relFrame: number;
  readonly durationFrames: number;
  readonly progress: number;
  /** Composition-Frame dieses Renders. */
  readonly compositionFrame: number;
}

/** Aufdeck-Clip aus Wipe- und Iris-Übergängen, in lokalen Box-Koordinaten der Node. */
export interface Reveal {
  readonly shape: 'rect' | 'ellipse';
  /** Richtung, aus der aufgedeckt wird. `center` für Iris. */
  readonly direction: 'left' | 'right' | 'up' | 'down' | 'center';
  /** 0 = verdeckt, 1 = vollständig sichtbar. */
  readonly progress: number;
}

/** Eine Node mit aufgelösten Werten für genau einen Frame (AD-2). */
export interface EvaluatedNode {
  readonly id: string;
  readonly type: string;
  /** Aufgelöste Properties ohne Struktur-Felder (id, type, children, mask, timing …). */
  readonly props: Readonly<Record<string, unknown>>;
  readonly children: readonly EvaluatedNode[];
  readonly mask?: { readonly node: EvaluatedNode; readonly mode: 'alpha' | 'luminance'; readonly invert: boolean };
  readonly reveal?: Reveal;
  readonly time: NodeTime;
  /** Explizit gewähltes Backend, sonst `undefined`. */
  readonly renderer?: string;
  /** JSON Pointer der Quelle in der IR (für Diagnosen und Rückschreiben). */
  readonly pointer: string;
  /** Quellposition in TSX, falls bekannt. */
  readonly source?: { readonly file: string; readonly line: number; readonly column: number };
}

/** Eine ganze Composition für einen Frame. */
export interface EvaluatedScene {
  readonly compositionId: string;
  readonly width: number;
  readonly height: number;
  readonly fps: number;
  readonly frame: number;
  readonly time: number;
  readonly seed: number;
  readonly durationFrames: number;
  readonly background: string;
  /** Arbeitsfarbraum des Compositors: `composition.colorSpace`, sonst `settings.workingColorSpace`, sonst `srgb`. */
  readonly colorSpace: ColorSpace;
  /** Kodierung der Ausgabe-Pixel aus `settings.outputColorSpace`; fehlt er, gilt `srgb`. */
  readonly outputColorSpace?: ColorSpace;
  readonly safeArea: { readonly action: number; readonly title: number };
  readonly nodes: readonly EvaluatedNode[];
  readonly diagnostics: readonly Diagnostic[];
  /**
   * Hash der Subframe-Zustände von Motion-Blur-Nodes (Blender `motionBlur`, `layer.motionBlur`);
   * fehlt ohne solche Nodes. Teil des Frame-Schlüssels.
   */
  readonly motionKey?: string;
}

// ---------------------------------------------------------------------------
// Bilder
// ---------------------------------------------------------------------------

/**
 * RGBA-Bild: 8 Bit je Kanal, vormultipliziertes Alpha, sRGB-kodiert, zeilenweise von oben links.
 *
 * @example
 * ```ts
 * const img: RgbaImage = { width: 2, height: 1, data: new Uint8Array([255, 0, 0, 255, 0, 0, 0, 0]) };
 * ```
 */
export interface RgbaImage {
  readonly width: number;
  readonly height: number;
  readonly data: Uint8Array;
}

/** Erzeugt ein transparentes Bild. */
export function createImage(width: number, height: number): RgbaImage {
  return { width, height, data: new Uint8Array(width * height * 4) };
}

// ---------------------------------------------------------------------------
// Assets (FR-49)
// ---------------------------------------------------------------------------

/** Vollständiger Asset-Datensatz nach Import und Normalisierung. */
export interface AssetRecord {
  readonly id: string;
  readonly type: string;
  /** Ursprüngliche Quelle aus der IR (Pfad oder URL). */
  readonly src: string;
  /** Lokaler Pfad der normalisierten Datei im Content Store. */
  readonly path: string;
  readonly hash: string;
  readonly metadata: Readonly<Record<string, unknown>>;
  /** Dauer in Sekunden (Video, Audio, Lottie). */
  readonly duration?: number;
  readonly dimensions?: { readonly width: number; readonly height: number };
  readonly codec?: string;
  readonly colorSpace?: string;
  readonly frameRate?: number;
  readonly hasAlpha?: boolean;
  readonly licenseMetadata?: Readonly<Record<string, string>>;
}

/** Zugriff auf aufgelöste Assets während des Renderns. */
export interface AssetResolver {
  /** Datensatz oder `undefined`, wenn das Asset unbekannt ist. */
  get(assetId: string): AssetRecord | undefined;
  /** Bytes der normalisierten Datei. */
  bytes(assetId: string): Promise<Uint8Array>;
  /** Frame eines Videos zur Quellzeit in Sekunden (frame-genau). */
  videoFrame(assetId: string, seconds: number): Promise<RgbaImage>;
  /** Alle bekannten Assets. */
  all(): readonly AssetRecord[];
}

/** Eine geladene Schrift. */
export interface FontFace {
  readonly family: string;
  readonly weight: number | readonly [number, number];
  readonly style: 'normal' | 'italic';
  readonly hash: string;
  readonly path: string;
  readonly bytes: Uint8Array;
  readonly variable: boolean;
}

/** Zugriff auf geladene Schriften. */
export interface FontResolver {
  /** Alle geladenen Schriften. */
  all(): readonly FontFace[];
  /** Prüft, ob eine Familie verfügbar ist. */
  has(family: string): boolean;
  /** Ersatzfamilien für fehlende Glyphen (z. B. Emoji). */
  fallbacks(): readonly string[];
}

// ---------------------------------------------------------------------------
// Renderer-Schnittstelle (AD-5)
// ---------------------------------------------------------------------------

/** Optionales Debug-Rendering (FR-27). */
export interface DebugOptions {
  readonly showBounds?: boolean;
  readonly showAnchors?: boolean;
  readonly showSafeArea?: boolean;
  readonly showBaseline?: boolean;
  readonly showGrid?: boolean;
  readonly showNodeIds?: boolean;
  readonly showCameraFrustum?: boolean;
  readonly showLightHelpers?: boolean;
}

/** Auftrag an ein Backend, einen Layer zu rendern. */
export interface LayerRequest {
  readonly layerId: string;
  readonly scene: EvaluatedScene;
  /** Die Nodes dieses Layers in Zeichenreihenfolge. */
  readonly nodes: readonly EvaluatedNode[];
  /** Ausgabegröße; bei Vorschau kleiner als die Composition. */
  readonly width: number;
  readonly height: number;
  /** Skalierung Composition → Ausgabe (1 = volle Auflösung). */
  readonly scale: number;
  readonly assets: AssetResolver;
  readonly fonts: FontResolver;
  readonly debug?: DebugOptions;
  /** Abbruchsignal (kompatibel zu AbortSignal). */
  readonly signal?: { readonly aborted: boolean };
}

/** Ergebnis der Vorab-Prüfung einer Node durch ein Backend (FR-44). */
export interface BackendCheck {
  readonly supported: boolean;
  readonly diagnostics: readonly Diagnostic[];
}

/**
 * Ein Renderer-Backend. Es rendert Evaluated Nodes zu einem RGBA-Layer und
 * komponiert nie selbst mit anderen Layern (AD-5).
 */
export interface RenderBackend {
  /** Stabile ID, z. B. `skia`, `pixi`, `browser`, `three`, `blender`. */
  readonly id: string;
  /** Node-Typen, die das Backend direkt rendert. */
  readonly nodeTypes: readonly string[];
  /** Benannte Fähigkeiten, z. B. `three.webgpu`. */
  readonly capabilities: readonly string[];
  /** Dürfen benachbarte Nodes in einen gemeinsamen Layer? */
  readonly fusable: boolean;
  /** Versionen der beteiligten Bibliotheken (für Manifest und Cache-Schlüssel). */
  versions(): Readonly<Record<string, string>>;
  /** Prüft eine IR-Node vor dem Render auf nicht unterstützte Features. */
  check(node: Readonly<Record<string, unknown>>): BackendCheck;
  /** Rendert einen Layer. */
  renderLayer(request: LayerRequest): Promise<RgbaImage>;
  /** Gibt Ressourcen frei (Browser, Prozesse). */
  dispose(): Promise<void>;
}

/** Misst Text für Bounding Boxes und Überlauf-Diagnosen. */
export interface TextMeasurer {
  measure(node: EvaluatedNode): { readonly width: number; readonly height: number; readonly lines: number; readonly overflow: boolean; readonly missingGlyphs: number; readonly baseline: number };
}
