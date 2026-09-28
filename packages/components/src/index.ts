/**
 * @packageDocumentation
 * Komponentenbibliothek von OpenVideo (FR-82) mit Theme-Tokens (FR-83).
 * Jede Komponente ist ein IR-Makro (ADR 0011): eine reine Funktion von Props,
 * Theme und lokaler Zeit auf normale IR-Nodes.
 *
 * @example
 * ```ts
 * import { Registry, evaluateScene } from '@agentic-video/core';
 * import { registerComponents } from '@agentic-video/components';
 * const registry = new Registry();
 * registerComponents(registry);
 * const scene = evaluateScene(project, 'main', 30, { registry });
 * ```
 */
import type { ComponentDefinition, Registry } from '@agentic-video/core';
import { CodeEditor, Terminal } from './components/code.js';
import { BarChart, Chart, LineChart, PieChart, Table } from './components/charts.js';
import { BrowserWindow, Card, DeviceFrame, GlassPanel, Laptop, Phone } from './components/frames.js';
import { Arrow, Connector, Cursor, GradientBackground, Grid, Logo, ParticleField, ProgressBar, Spotlight } from './components/graphics.js';
import { Badge, Callout, Counter, LowerThird, Subtitle, Title, Typewriter } from './components/text.js';

export * from './theme.js';
export * from './define.js';
export * from './tokenizer.js';
export * from './components/text.js';
export * from './components/frames.js';
export * from './components/code.js';
export * from './components/charts.js';
export * from './components/graphics.js';

/** Alle Komponenten der Bibliothek in fester Reihenfolge. */
export const COMPONENTS: readonly ComponentDefinition[] = [
  Title,
  Subtitle,
  LowerThird,
  Callout,
  Badge,
  Card,
  BrowserWindow,
  CodeEditor,
  Terminal,
  Chart,
  BarChart,
  LineChart,
  PieChart,
  Table,
  Logo,
  DeviceFrame,
  Phone,
  Laptop,
  Cursor,
  Arrow,
  Connector,
  Grid,
  ParticleField,
  GradientBackground,
  Spotlight,
  GlassPanel,
  ProgressBar,
  Counter,
  Typewriter,
];

/** Namen aller Komponenten (für `validateProject({ components })`). */
export const COMPONENT_NAMES: readonly string[] = COMPONENTS.map((c) => c.name);

/**
 * Registriert alle Komponenten in einem Register.
 *
 * @example
 * ```ts
 * const registry = new Registry();
 * registerComponents(registry);
 * registry.components.has('LowerThird'); // true
 * ```
 */
export function registerComponents(registry: Pick<Registry, 'registerComponent'>): void {
  for (const c of COMPONENTS) registry.registerComponent(c);
}
