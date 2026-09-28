/**
 * Web Animations und CSS-Variablen eines Dokuments auf eine Zeit setzen.
 * Genutzt von der virtuellen Uhr (Dokumente mit Skripten) und vom HTML-Layer
 * (Dokumente ohne Skripte, die der Host von außen steuert).
 */
import type { FrameState } from '../protocol.js';

/**
 * Sammelt alle Web Animations inklusive offener Shadow Roots.
 *
 * @example
 * ```ts
 * allAnimations(document).length; // 2
 * ```
 */
export function allAnimations(doc: Document): Animation[] {
  const out = doc.getAnimations();
  for (const el of doc.querySelectorAll('*')) {
    if (el.shadowRoot !== null) out.push(...el.shadowRoot.getAnimations());
  }
  return out;
}

/**
 * Setzt `--ov-time`, `--ov-frame`, `--ov-progress` und alle Animationen auf den Frame.
 *
 * @example
 * ```ts
 * applyFrame(document, { timeMs: 500, frame: 15, fps: 30, progress: 0.25, seed: 1, key: 'n' });
 * ```
 */
export function applyFrame(doc: Document, state: FrameState): void {
  const root = doc.documentElement;
  root.style.setProperty('--ov-time', String(state.timeMs / 1000));
  root.style.setProperty('--ov-frame', String(state.frame));
  root.style.setProperty('--ov-progress', String(state.progress));
}

/**
 * Pausiert alle Animationen und setzt sie auf `timeMs`.
 *
 * @example
 * ```ts
 * seekAnimations(document, 500);
 * ```
 */
export function seekAnimations(doc: Document, timeMs: number): void {
  for (const animation of allAnimations(doc)) {
    animation.pause();
    animation.currentTime = timeMs;
  }
}
