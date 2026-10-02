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

/** Element mit Inline-Stil (HTML, SVG, MathML). */
type StyledElement = HTMLElement | SVGElement | MathMLElement;

/** Inline-Stil eines Elements vor dem Einfrieren; `undefined`: Das Element hatte kein `style`-Attribut. */
interface SavedStyle {
  readonly element: StyledElement;
  readonly cssText: string | undefined;
}

/** Eingefrorene Animationen eines Dokuments: Zeit, Animationen und die vorherigen Inline-Stile. */
interface FrozenAnimations {
  readonly timeMs: number;
  readonly animations: readonly Animation[];
  readonly styles: readonly SavedStyle[];
}

const frozenByDocument = new WeakMap<Document, FrozenAnimations>();

/**
 * Ziel-Element einer Keyframe-Animation (ohne Pseudo-Elemente). Die Objekte stammen aus dem Realm
 * des iframes; darum die Konstruktoren seines Fensters.
 */
function animatedElement(view: Window & typeof globalThis, animation: Animation): StyledElement | undefined {
  const effect = animation.effect;
  if (!(effect instanceof view.KeyframeEffect) || effect.pseudoElement !== null) return undefined;
  const target = effect.target;
  return target instanceof view.HTMLElement || target instanceof view.SVGElement || target instanceof view.MathMLElement ? target : undefined;
}

/**
 * Friert alle Animationen eines Dokuments für die Aufnahme ein: Ihr Wert zur gesetzten Zeit wird
 * mit `commitStyles()` als Inline-Stil geschrieben, die Animation danach mit `cancel()` gelöst.
 *
 * Grund: Ein Element mit aktiver (auch pausierter) Transform- oder Opacity-Animation bekommt in
 * Chromium eine eigene Compositor-Ebene. Ihre Raster-Skala wählt der Compositor nach Vorgeschichte
 * und rastert asynchron nach; die Aufnahme zeigte dann je nach Last die alte oder die neue Rasterung
 * (Kantenpixel einer `scaleX`-Animation verschieden, DoD-Determinismus). Eingefroren ist das
 * Dokument statisch und wird wie ein Dokument mit festen Inline-Stilen gezeichnet.
 * {@link thawAnimations} stellt den vorherigen Zustand vor dem nächsten Frame wieder her.
 * Animationen auf Pseudo-Elementen und auf nicht gezeichneten Elementen bleiben pausiert.
 *
 * @example
 * ```ts
 * seekAnimations(doc, 500);
 * freezeAnimations(doc, 500);
 * // … Aufnahme …
 * thawAnimations(doc);
 * ```
 */
export function freezeAnimations(doc: Document, timeMs: number): void {
  const view = doc.defaultView;
  if (view === null) return;
  const animations: Animation[] = [];
  const styles: SavedStyle[] = [];
  const saved = new Set<StyledElement>();
  for (const animation of allAnimations(doc)) {
    const element = animatedElement(view, animation);
    if (element === undefined) continue;
    const cssText = element.hasAttribute('style') ? element.style.cssText : undefined;
    try {
      animation.commitStyles();
    } catch (error) {
      // Nicht gezeichnete Elemente (z. B. `display: none`) lehnen commitStyles ab; sie bleiben pausiert.
      if (error instanceof view.DOMException || error instanceof DOMException) continue;
      throw error;
    }
    if (!saved.has(element)) {
      saved.add(element);
      styles.push({ element, cssText });
    }
    animation.cancel();
    animations.push(animation);
  }
  if (animations.length > 0) frozenByDocument.set(doc, { timeMs, animations, styles });
}

/**
 * Hebt {@link freezeAnimations} auf: stellt die Inline-Stile wieder her (über das CSSOM, das eine
 * CSP des Dokuments nicht sperrt) und setzt die Animationen pausiert auf ihre Zeit zurück. Ohne
 * eingefrorene Animationen ohne Wirkung.
 *
 * @example
 * ```ts
 * thawAnimations(doc);
 * seekAnimations(doc, 533.3);
 * ```
 */
export function thawAnimations(doc: Document): void {
  const frozen = frozenByDocument.get(doc);
  if (frozen === undefined) return;
  frozenByDocument.delete(doc);
  for (const { element, cssText } of frozen.styles) {
    if (cssText === undefined) element.removeAttribute('style');
    else element.style.cssText = cssText;
  }
  for (const animation of frozen.animations) {
    animation.pause();
    animation.currentTime = frozen.timeMs;
  }
}
