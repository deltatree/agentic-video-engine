/**
 * Die Render-Umgebung: alle Fähigkeiten, die die Pipeline braucht, als schmale Schnittstellen.
 *
 * Die Pipeline hängt nur von diesen Verträgen ab. `createNodeEnvironment` (node-env.ts)
 * verdrahtet die echten Pakete (Skia, Browser, Blender, Compositor, FFmpeg, Audio, Fonts, Assets).
 * Tests können einzelne Teile ersetzen.
 */
import type { AssetResolver, DebugOptions, EffectDefinition, EvaluatedNode, EvaluatedScene, FontResolver, NodeBounds, Registry, RgbaImage, TextMeasurer } from '@agentic-video/core';
import type { Cache } from '@agentic-video/cache';
import type { Telemetry } from '@agentic-video/telemetry';

/** Knoten des Compositor-Baums (Vertrag des Pakets `compositor`). */
export type CompositorNode =
  | { readonly kind: 'image'; readonly image: RgbaImage }
  | {
      readonly kind: 'group';
      readonly node: EvaluatedNode;
      readonly children: CompositorNode[];
      readonly mask?: { readonly image: RgbaImage; readonly mode: 'alpha' | 'luminance'; readonly invert: boolean };
    };

/** Eine Farbnachschlagetabelle (Vertrag des Pakets `compositor`). */
export interface LutLike {
  readonly size: number;
}

/** Eingabe des Compositors (Vertrag des Pakets `compositor`). */
export interface CompositeRequest {
  readonly width: number;
  readonly height: number;
  readonly scale: number;
  readonly background: string;
  readonly workingSpace: 'srgb' | 'linear' | 'rec709';
  readonly outputSpace?: 'srgb' | 'rec709';
  readonly layers: CompositorNode[];
  readonly frame: number;
  readonly seed: number;
  readonly resolveLut?: (assetId: string) => LutLike | undefined;
  readonly effects?: ReadonlyMap<string, EffectDefinition>;
}

/** Optionen für einen Video-Encoder. */
export interface EncodeOptions {
  readonly outPath: string;
  readonly format: string;
  readonly codec?: string;
  readonly width: number;
  readonly height: number;
  readonly fps: number;
  readonly alpha: boolean;
  readonly quality: number;
  readonly hardware: string;
  readonly colorSpace: 'srgb' | 'rec709' | 'linear';
  readonly audioPath?: string;
  readonly audioCodec?: string;
  readonly audioBitrate?: number;
}

/** Ergebnis eines Encoders. */
export interface EncodeOutcome {
  readonly outputs: readonly string[];
  readonly frames: number;
  readonly encoder: string;
  readonly args: readonly string[];
}

/** Ein laufender Encoder. */
export interface FrameEncoder {
  write(image: RgbaImage): Promise<void>;
  finish(): Promise<EncodeOutcome>;
  abort(): Promise<void>;
}

/** Audio-Puffer: ein Float32Array je Kanal. */
export interface AudioBufferLike {
  readonly sampleRate: number;
  readonly channels: readonly Float32Array[];
}

/** Audio-Fähigkeiten der Umgebung. */
export interface AudioEngine {
  /** Mischt und mastert die Tonspuren einer Composition und schreibt eine WAV-Datei. */
  renderComposition(input: {
    readonly project: Readonly<Record<string, unknown>>;
    readonly composition: Readonly<Record<string, unknown>>;
    readonly startFrame: number;
    readonly endFrame: number;
    readonly outPath: string;
  }): Promise<{ readonly path: string; readonly durationSeconds: number; readonly loudness?: number } | undefined>;
}

/** Medien-Werkzeuge (FFmpeg). */
export interface MediaTools {
  createEncoder(options: EncodeOptions): Promise<FrameEncoder>;
  /** Versionen und Lizenzen für das Manifest. */
  info(): Promise<{ readonly version: string; readonly license: string; readonly configuration: string; readonly codecLicenses: Readonly<Record<string, string>> }>;
}

/** Hilfen, die ein 2D-Renderer liefert (Skia). */
export interface OverlayTools {
  debugOverlay(scene: EvaluatedScene, bounds: readonly NodeBounds[], options: DebugOptions, size: { readonly width: number; readonly height: number; readonly scale: number }): RgbaImage;
  contactSheet(frames: readonly { readonly image: RgbaImage; readonly label: string }[], options: { readonly columns: number; readonly cellWidth: number; readonly background: string }): RgbaImage;
}

/** Alles, was die Pipeline zum Rendern braucht. */
export interface RenderEnvironment {
  readonly registry: Registry;
  readonly assets: AssetResolver;
  readonly fonts: FontResolver;
  readonly cache: Cache;
  readonly telemetry: Telemetry;
  readonly measurer?: TextMeasurer;
  readonly overlays?: OverlayTools;
  readonly media?: MediaTools;
  readonly audio?: AudioEngine;
  composite(request: CompositeRequest): RgbaImage;
  accumulate(images: readonly RgbaImage[]): RgbaImage;
  resolveLut?(assetId: string): LutLike | undefined;
  /** Versionen aller Komponenten (Renderer, Compositor, OpenVideo) für Manifest und Cache-Schlüssel. */
  readonly versions: Readonly<Record<string, string>>;
  /** `true`, wenn nicht vertrauenswürdiger Code auf dem Host laufen darf (`--trusted`). */
  readonly trusted: boolean;
  /** Umgebungsbeschreibung für das Manifest (Betriebssystem, Container-Image, GPU). */
  readonly platform: { readonly os: string; readonly containerImage?: string; readonly gpu?: string };
}
