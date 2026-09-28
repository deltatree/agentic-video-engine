/**
 * Definitionen von Compositions und Projects im SDK (FR-17).
 */
import type { Asset, AudioSource, Composition, Font, Metadata, RenderProfile, Settings } from '@agentic-video/core';
import { isRecord } from '@agentic-video/core';
import type { SdkElement } from './element.js';

/** Argumente einer Frame-Funktion. `time` ist in Sekunden. */
export interface SceneFrame {
  readonly frame: number;
  readonly time: number;
  readonly fps: number;
  readonly width: number;
  readonly height: number;
  readonly durationFrames: number;
}

/** Szene: ein Element oder eine Funktion des Frames. */
export type SceneInput = SdkElement | ((frame: SceneFrame) => SdkElement);

/** Felder einer Composition-Definition: wie in der IR, aber `id` optional und `scene` statt `nodes`. */
export type CompositionInit = Omit<Composition, 'id' | 'nodes'> & { readonly id?: string; readonly scene: SceneInput };

/** Eine Composition-Definition (Ergebnis von {@link composition}). */
export interface CompositionDefinition {
  readonly kind: 'openvideo.composition';
  readonly definition: CompositionInit;
}

/** Felder einer Project-Definition. */
export interface ProjectInit {
  readonly metadata?: Metadata;
  readonly settings?: Settings;
  readonly compositions: readonly CompositionDefinition[];
  readonly assets?: readonly Asset[];
  readonly fonts?: readonly Font[];
  readonly audio?: readonly AudioSource[];
  readonly renderProfiles?: readonly RenderProfile[];
}

/** Eine Project-Definition (Ergebnis von {@link project}). */
export interface ProjectDefinition {
  readonly kind: 'openvideo.project';
  readonly definition: ProjectInit;
}

/**
 * Definiert eine Composition. `scene` ist ein Element oder eine Funktion
 * `({ frame, time, fps, width, height, durationFrames }) => Element`.
 *
 * @example
 * ```tsx
 * export default composition({
 *   width: 1920, height: 1080, fps: 30, duration: '5s',
 *   scene: ({ frame }) => <Scene><Rect x={frame * 2} width={100} height={100} /></Scene>,
 * });
 * ```
 */
export function composition(definition: CompositionInit): CompositionDefinition {
  return { kind: 'openvideo.composition', definition };
}

/**
 * Definiert ein Project mit mehreren Compositions.
 *
 * @example
 * ```ts
 * export default project({ compositions: [intro, main], metadata: { title: 'Launch' } });
 * ```
 */
export function project(definition: ProjectInit): ProjectDefinition {
  return { kind: 'openvideo.project', definition };
}

/**
 * Prüft, ob ein Wert eine Composition-Definition ist.
 *
 * @example
 * ```ts
 * isCompositionDefinition(composition({ … })); // true
 * ```
 */
export function isCompositionDefinition(value: unknown): value is CompositionDefinition {
  return isRecord(value) && value['kind'] === 'openvideo.composition' && isRecord(value['definition']);
}

/**
 * Prüft, ob ein Wert eine Project-Definition ist.
 *
 * @example
 * ```ts
 * isProjectDefinition(project({ compositions: [] })); // true
 * ```
 */
export function isProjectDefinition(value: unknown): value is ProjectDefinition {
  return isRecord(value) && value['kind'] === 'openvideo.project' && isRecord(value['definition']);
}
