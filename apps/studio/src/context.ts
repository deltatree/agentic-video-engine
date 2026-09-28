/**
 * React-Anbindung des Stores.
 */
import { createContext, useContext, useSyncExternalStore } from 'react';
import type { Studio, StudioState } from './store.js';

/** Kontext mit dem Store des geöffneten Projekts. */
export const StudioContext = createContext<Studio | undefined>(undefined);

/**
 * Liefert Store und aktuellen Zustand.
 *
 * @example
 * ```tsx
 * const [studio, state] = useStudio();
 * ```
 */
export function useStudio(): [Studio, StudioState] {
  const studio = useContext(StudioContext);
  if (studio === undefined) throw new Error('useStudio needs a StudioContext provider.');
  const state = useSyncExternalStore(studio.subscribe, studio.getState);
  return [studio, state];
}
