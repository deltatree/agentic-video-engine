/**
 * Panel-Layout (Story 20.8): Größen und eingeklappte Panels bleiben pro Browser gespeichert.
 * Schmale Fenster starten mit eingeklappten Seitenpanels.
 */
import { isRecord } from '@agentic-video/core';

/** Ein verstellbares Panel. */
export type PanelId = 'left' | 'right' | 'timeline' | 'bottom';

/** Größen und Einklapp-Zustand. */
export interface Layout {
  readonly sizes: Readonly<Record<PanelId, number>>;
  readonly collapsed: Readonly<Record<PanelId, boolean>>;
}

/** Grenzen je Panel (Pixel). */
export const PANEL_LIMITS: Readonly<Record<PanelId, { readonly min: number; readonly max: number }>> = {
  left: { min: 160, max: 600 },
  right: { min: 220, max: 700 },
  timeline: { min: 100, max: 600 },
  bottom: { min: 80, max: 700 },
};

const PANELS: readonly PanelId[] = ['left', 'right', 'timeline', 'bottom'];

/** Speicherschlüssel im `localStorage`. */
export const LAYOUT_KEY = 'openvideo.studio.layout';

/**
 * Startlayout für eine Fensterbreite: unter 1000 px sind die Seitenpanels eingeklappt.
 *
 * @example
 * ```ts
 * defaultLayout(800).collapsed.left; // true
 * ```
 */
export function defaultLayout(viewportWidth: number): Layout {
  const narrow = viewportWidth < 1000;
  return {
    sizes: { left: 260, right: 320, timeline: 220, bottom: 240 },
    collapsed: { left: narrow, right: narrow, timeline: false, bottom: false },
  };
}

/**
 * Liest ein gespeichertes Layout; ungültige oder fehlende Werte kommen aus dem Standard.
 *
 * @example
 * ```ts
 * parseLayout('{"sizes":{"left":300}}', defaultLayout(1600)).sizes.left; // 300
 * ```
 */
export function parseLayout(text: string | null, fallback: Layout): Layout {
  if (text === null) return fallback;
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return fallback;
  }
  if (!isRecord(raw)) return fallback;
  const sizes = isRecord(raw['sizes']) ? raw['sizes'] : {};
  const collapsed = isRecord(raw['collapsed']) ? raw['collapsed'] : {};
  const outSizes: Record<PanelId, number> = { ...fallback.sizes };
  const outCollapsed: Record<PanelId, boolean> = { ...fallback.collapsed };
  for (const p of PANELS) {
    const s = sizes[p];
    if (typeof s === 'number' && Number.isFinite(s)) outSizes[p] = Math.max(PANEL_LIMITS[p].min, Math.min(PANEL_LIMITS[p].max, s));
    const c = collapsed[p];
    if (typeof c === 'boolean') outCollapsed[p] = c;
  }
  return { sizes: outSizes, collapsed: outCollapsed };
}

/**
 * Lädt das Layout aus dem Browser-Speicher (gesperrter Speicher → Standard).
 *
 * @example
 * ```ts
 * const layout = loadLayout(window.innerWidth);
 * ```
 */
export function loadLayout(viewportWidth: number): Layout {
  const fallback = defaultLayout(viewportWidth);
  try {
    return parseLayout(localStorage.getItem(LAYOUT_KEY), fallback);
  } catch {
    return fallback;
  }
}

/**
 * Speichert das Layout (gesperrter Speicher wird still übergangen: das Layout gilt dann nur für diese Sitzung).
 *
 * @example
 * ```ts
 * saveLayout(layout);
 * ```
 */
export function saveLayout(layout: Layout): void {
  try {
    localStorage.setItem(LAYOUT_KEY, JSON.stringify(layout));
  } catch (error) {
    console.warn('OpenVideo Studio: layout not stored', error);
  }
}
