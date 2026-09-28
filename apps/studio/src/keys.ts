/**
 * Geteilter Tastaturzustand: Leertaste gedrückt halten schwenkt die Bühne,
 * kurz tippen startet die Wiedergabe.
 */
export const keyState = {
  /** Leertaste ist gedrückt. */
  space: false,
  /** Während die Leertaste gedrückt war, wurde geschwenkt (dann kein Play beim Loslassen). */
  spaceUsed: false,
};

/**
 * Prüft, ob ein Tastendruck in einem Eingabefeld landet (dann gelten keine globalen Kürzel).
 *
 * @example
 * ```ts
 * isTyping(document.activeElement);
 * ```
 */
export function isTyping(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  if (target.isContentEditable) return true;
  if (target.closest('.monaco-editor') !== null) return true;
  const tag = target.tagName;
  return tag === 'TEXTAREA' || tag === 'SELECT' || tag === 'INPUT';
}

/**
 * Prüft, ob die Leertaste ein Bedienelement auslöst (Knopf, Tab …) statt der Wiedergabe.
 *
 * @example
 * ```ts
 * spaceActivates(document.activeElement);
 * ```
 */
export function spaceActivates(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  return isTyping(target) || target.closest('button, a, [role="tab"], [role="treeitem"], [role="option"], summary') !== null;
}
