/**
 * Theme-Tokens der Komponenten (FR-83).
 *
 * Komponenten lesen Farben, Schriften, Größen, Abstände, Radien, Schatten,
 * Timing und Easing nur aus Tokens. Fehlt ein Token in `settings.theme`,
 * gilt der Wert aus {@link DEFAULT_THEME}.
 */
import type { Theme, TimeValue } from '@agentic-video/core';

/** Ein Schatten-Token. */
export interface ThemeShadowToken {
  readonly color: string;
  readonly blur: number;
  readonly offsetX: number;
  readonly offsetY: number;
}

/** Vollständiges Theme: jedes Token, das eine Komponente liest, hat einen Wert. */
export interface ResolvedTheme {
  readonly colors: {
    readonly background: string;
    readonly surface: string;
    readonly primary: string;
    readonly secondary: string;
    readonly accent: string;
    readonly text: string;
    readonly muted: string;
    readonly success: string;
    readonly warning: string;
    readonly danger: string;
    readonly [token: string]: string;
  };
  readonly fonts: { readonly heading: string; readonly body: string; readonly mono: string; readonly [token: string]: string };
  readonly fontSizes: {
    readonly xs: number;
    readonly sm: number;
    readonly md: number;
    readonly lg: number;
    readonly xl: number;
    readonly xxl: number;
    readonly display: number;
    readonly [token: string]: number;
  };
  readonly spacing: { readonly xs: number; readonly sm: number; readonly md: number; readonly lg: number; readonly xl: number; readonly [token: string]: number };
  readonly radii: { readonly sm: number; readonly md: number; readonly lg: number; readonly full: number; readonly [token: string]: number };
  readonly shadows: { readonly sm: ThemeShadowToken; readonly md: ThemeShadowToken; readonly lg: ThemeShadowToken; readonly [token: string]: ThemeShadowToken };
  readonly motion: { readonly fast: TimeValue; readonly normal: TimeValue; readonly slow: TimeValue; readonly [token: string]: TimeValue };
  readonly easing: { readonly standard: string; readonly enter: string; readonly exit: string; readonly [token: string]: string };
}

const SHARED = {
  fonts: { heading: 'Inter', body: 'Inter', mono: 'JetBrains Mono' },
  fontSizes: { xs: 16, sm: 20, md: 28, lg: 40, xl: 56, xxl: 80, display: 112 },
  spacing: { xs: 4, sm: 8, md: 16, lg: 24, xl: 48 },
  radii: { sm: 6, md: 12, lg: 24, full: 9999 },
  motion: { fast: '0.25s', normal: '0.5s', slow: '1s' },
  easing: { standard: 'easeInOutCubic', enter: 'easeOutCubic', exit: 'easeInCubic' },
} as const;

function shadows(color: string): ResolvedTheme['shadows'] {
  return {
    sm: { color, blur: 4, offsetX: 0, offsetY: 2 },
    md: { color, blur: 12, offsetX: 0, offsetY: 6 },
    lg: { color, blur: 32, offsetX: 0, offsetY: 16 },
  };
}

/**
 * Standard-Theme (dunkel). Dokumentierte Standardwerte:
 *
 * | Gruppe | Tokens |
 * |---|---|
 * | colors | background `#0B1020`, surface `#161C2E`, primary `#4F7CFF`, secondary `#8B5CF6`, accent `#22D3EE`, text `#F5F7FF`, muted `#8A93B2`, success `#22C55E`, warning `#F59E0B`, danger `#EF4444` |
 * | fonts | heading `Inter`, body `Inter`, mono `JetBrains Mono` |
 * | fontSizes | xs 16, sm 20, md 28, lg 40, xl 56, xxl 80, display 112 |
 * | spacing | xs 4, sm 8, md 16, lg 24, xl 48 |
 * | radii | sm 6, md 12, lg 24, full 9999 |
 * | shadows | sm (blur 4, y 2), md (blur 12, y 6), lg (blur 32, y 16), Farbe `#00000080` |
 * | motion | fast `0.25s`, normal `0.5s`, slow `1s` |
 * | easing | standard `easeInOutCubic`, enter `easeOutCubic`, exit `easeInCubic` |
 *
 * @example
 * ```ts
 * DEFAULT_THEME.colors.primary; // '#4F7CFF'
 * ```
 */
export const DEFAULT_THEME: ResolvedTheme = {
  colors: {
    background: '#0B1020',
    surface: '#161C2E',
    primary: '#4F7CFF',
    secondary: '#8B5CF6',
    accent: '#22D3EE',
    text: '#F5F7FF',
    muted: '#8A93B2',
    success: '#22C55E',
    warning: '#F59E0B',
    danger: '#EF4444',
  },
  ...SHARED,
  shadows: shadows('#00000080'),
};

/**
 * Mitgelieferte Themes. Jedes ist vollständig und kann direkt als `settings.theme` dienen.
 *
 * @example
 * ```ts
 * const project = { ...base, settings: { theme: THEMES.neon } };
 * ```
 */
export const THEMES: Readonly<Record<'dark' | 'light' | 'neon' | 'corporate', ResolvedTheme>> = {
  dark: DEFAULT_THEME,
  light: {
    colors: {
      background: '#F7F8FC',
      surface: '#FFFFFF',
      primary: '#2F5BEA',
      secondary: '#7C3AED',
      accent: '#0891B2',
      text: '#111827',
      muted: '#6B7280',
      success: '#16A34A',
      warning: '#D97706',
      danger: '#DC2626',
    },
    ...SHARED,
    shadows: shadows('#0F172A33'),
  },
  neon: {
    colors: {
      background: '#05010F',
      surface: '#140A2A',
      primary: '#FF2BD6',
      secondary: '#7B2CFF',
      accent: '#00F0FF',
      text: '#FFFFFF',
      muted: '#A08CC8',
      success: '#39FF14',
      warning: '#FFE600',
      danger: '#FF3860',
    },
    ...SHARED,
    fonts: { heading: 'Inter', body: 'Inter', mono: 'JetBrains Mono' },
    radii: { sm: 4, md: 8, lg: 16, full: 9999 },
    shadows: shadows('#FF2BD666'),
    motion: { fast: '0.2s', normal: '0.4s', slow: '0.8s' },
    easing: { standard: 'easeInOutQuart', enter: 'easeOutBack', exit: 'easeInQuart' },
  },
  corporate: {
    colors: {
      background: '#FFFFFF',
      surface: '#F1F4F9',
      primary: '#0A3D91',
      secondary: '#1F7A8C',
      accent: '#E07A1F',
      text: '#1B2430',
      muted: '#5B6778',
      success: '#2E7D32',
      warning: '#ED8B00',
      danger: '#C62828',
    },
    ...SHARED,
    radii: { sm: 2, md: 4, lg: 8, full: 9999 },
    shadows: shadows('#1B243026'),
    motion: { fast: '0.3s', normal: '0.6s', slow: '1.2s' },
    easing: { standard: 'easeInOutSine', enter: 'easeOutSine', exit: 'easeInSine' },
  },
};

function merge<V, T extends Readonly<Record<string, V>>>(base: T, extra: Readonly<Record<string, V>> | undefined): T {
  return extra === undefined ? base : { ...base, ...extra };
}

/**
 * Ergänzt ein Teil-Theme (z. B. `settings.theme`) mit {@link DEFAULT_THEME}.
 * Jede Gruppe wird einzeln gemischt: ein eigenes `colors.primary` lässt alle anderen Farben unverändert.
 *
 * @example
 * ```ts
 * resolveTheme({ colors: { primary: '#FF0000' } }).colors.surface; // '#161C2E'
 * ```
 */
export function resolveTheme(partial: Theme | undefined): ResolvedTheme {
  const p: Theme = partial ?? {};
  return {
    colors: merge(DEFAULT_THEME.colors, p.colors),
    fonts: merge(DEFAULT_THEME.fonts, p.fonts),
    fontSizes: merge(DEFAULT_THEME.fontSizes, p.fontSizes),
    spacing: merge(DEFAULT_THEME.spacing, p.spacing),
    radii: merge(DEFAULT_THEME.radii, p.radii),
    shadows: merge(DEFAULT_THEME.shadows, p.shadows),
    motion: merge(DEFAULT_THEME.motion, p.motion),
    easing: merge(DEFAULT_THEME.easing, p.easing),
  };
}
