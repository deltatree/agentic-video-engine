/**
 * Gemeinsame Datentypen zwischen Node-Host und Seiten-Laufzeit.
 *
 * Die Typen gehen per Playwright `page.evaluate` als JSON über die Prozessgrenze.
 * Deshalb enthalten sie nur serialisierbare Werte.
 */
import type { EvaluatedNode } from '@agentic-video/core';

/** Art eines Browser-Layers: `html` (DOM), `three` (scene3d) oder `pixi` (2D-Nodes). */
export type BrowserLayerKind = 'html' | 'three' | 'pixi';

/**
 * Auftrag für einen Browser-Layer.
 *
 * @example
 * ```ts
 * const payload: BrowserLayerPayload = { nodes: [htmlNode], width: 640, height: 360, scale: 1, frame: 0, time: 0, fps: 30, seed: 1 };
 * ```
 */
export interface BrowserLayerPayload {
  /** Nodes des Layers in Zeichenreihenfolge. */
  readonly nodes: readonly EvaluatedNode[];
  /** Ausgabegröße in Pixeln. */
  readonly width: number;
  readonly height: number;
  /** Skalierung Composition → Ausgabe. */
  readonly scale: number;
  /** Composition-Frame und -Zeit in Sekunden. */
  readonly frame: number;
  readonly time: number;
  readonly fps: number;
  readonly seed: number;
  /** Composition-Größe (für Pixi); Standard: Ausgabegröße geteilt durch `scale`. */
  readonly compositionWidth?: number;
  readonly compositionHeight?: number;
  /** Standardschrift für Pixi-Text. */
  readonly defaultFont?: string;
  readonly debug?: { readonly showCameraFrustum?: boolean; readonly showLightHelpers?: boolean };
}

/** Konfiguration eines HTML-Dokuments, übergeben über `window.name` vor dem Laden. */
export interface DocumentConfig {
  readonly seed: number;
  readonly key: string;
  readonly fps: number;
}

/** Präfix von `window.name` in HTML-Layer-Dokumenten. */
export const DOCUMENT_NAME_PREFIX = 'ov:';

/** Zustand eines Frames für ein HTML-Dokument. */
export interface FrameState {
  /** Lokale Zeit in Millisekunden (virtuelle Uhr). */
  readonly timeMs: number;
  readonly frame: number;
  readonly fps: number;
  readonly progress: number;
  readonly seed: number;
  /** Zusätzlicher Schlüssel für `Math.random` (z. B. Node-ID). */
  readonly key: string;
}

/** Öffentliche API `window.openvideo` in HTML-Layern. */
export interface OpenVideoPageApi {
  frame: number;
  time: number;
  fps: number;
  progress: number;
  onFrame(callback: (state: { frame: number; time: number; fps: number; progress: number }) => void): () => void;
}

/** Virtuelle Uhr eines Dokuments (siehe `runtime/clock.ts`). */
export interface VirtualClock {
  /** Aktuelle virtuelle Zeit in Millisekunden. */
  readonly now: number;
  /** Setzt die Zeit, führt fällige Timer, `requestAnimationFrame` und `onFrame` aus und setzt Web Animations. */
  frame(state: FrameState): void;
  /** Nur Zufall neu säen (Dokumente ohne Timer-Virtualisierung). */
  reseed(seed: number, key: string): void;
}

/** Seiten-Laufzeit `window.__ovRuntime` (siehe `runtime/page.ts`). */
export interface PageRuntime {
  renderHtml(payload: BrowserLayerPayload): Promise<void>;
  renderThree(payload: BrowserLayerPayload, frameUrl: string): Promise<void>;
  renderPixi(payload: BrowserLayerPayload, frameUrl: string): Promise<void>;
  versions(): Readonly<Record<string, string>>;
}

declare global {
  interface Window {
    __ovClock?: VirtualClock;
    __ovRuntime?: PageRuntime;
    openvideo?: OpenVideoPageApi;
  }
}
