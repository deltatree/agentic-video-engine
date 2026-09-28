/**
 * Statische TypeScript-Typen der IR, abgeleitet aus der TypeBox-Definition (AD-1).
 */
import type { Static } from 'typebox';
import type { IrNode } from './nodes.js';
import type { Composition as CompositionSchema, Project as ProjectSchema } from './project.js';

/** Eine Composition mit typisierten Nodes. */
export type IrComposition = Omit<Static<typeof CompositionSchema>, 'nodes'> & { nodes: IrNode[] };

/** Ein vollständiges Project mit typisierten Nodes. */
export type IrProject = Omit<Static<typeof ProjectSchema>, 'compositions'> & { compositions: IrComposition[] };

/** Eine animierbare Property beliebigen Werttyps. */
export type AnimatedValue<T> =
  | T
  | { $keyframes: { t: number | string; v: T; ease?: string }[]; loop?: 'none' | 'repeat' | 'pingpong'; repeat?: number | 'infinite'; delay?: number | string }
  | { $spring: { from: T; to: T; at?: number | string; stiffness?: number; damping?: number; mass?: number; velocity?: number } }
  | { $expr: string }
  | { $sampled: { start: number; values: T[] } }
  | { $ref: string };
