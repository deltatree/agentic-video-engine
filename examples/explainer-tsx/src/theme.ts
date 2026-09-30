/**
 * Marken-Theme des Erklärvideos: das helle Standard-Theme mit eigenen Farben.
 * Alle Komponenten (Title, Card, ProgressBar …) und `ref('theme.colors.*')` lesen daraus.
 */
import { THEMES } from '@agentic-video/components';

/** Farben der Marke „Tidewise“. */
export const BRAND_COLORS = {
  ...THEMES.light.colors,
  primary: '#0F766E',
  secondary: '#0E7490',
  accent: '#F59E0B',
  background: '#F4F7F6',
  surface: '#FFFFFF',
  text: '#0B1F1C',
  muted: '#5B6B68',
} as const;

/** Vollständiges Theme für `settings.theme`. */
export const BRAND_THEME = { ...THEMES.light, colors: BRAND_COLORS };
