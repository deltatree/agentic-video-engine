/**
 * Lebensdauer von CanvasKit-Objekten. CanvasKit-Objekte liegen im WASM-Speicher
 * und müssen mit `delete()` freigegeben werden; ein Scope sammelt sie und gibt sie
 * am Ende eines Render-Auftrags gemeinsam frei.
 */

/** Ein Objekt mit WASM-Speicher. */
export interface Deletable {
  delete(): void;
}

/**
 * Sammelt CanvasKit-Objekte und gibt sie gemeinsam frei.
 *
 * @example
 * ```ts
 * const scope = new Scope();
 * const paint = scope.add(new ck.Paint());
 * scope.dispose();
 * ```
 */
export class Scope {
  #items: Deletable[] = [];

  /** Merkt ein Objekt zur Freigabe vor und gibt es zurück. */
  add<T extends Deletable>(item: T): T {
    this.#items.push(item);
    return item;
  }

  /** Gibt alle Objekte in umgekehrter Reihenfolge frei. */
  dispose(): void {
    const items = this.#items;
    this.#items = [];
    for (let i = items.length - 1; i >= 0; i--) items[i]?.delete();
  }
}

/**
 * Macht einen Rückgabewert explizit nullbar. CanvasKit-Fabriken liefern zur Laufzeit
 * `null`, obwohl ihre Typen das nicht immer sagen.
 *
 * @example
 * ```ts
 * const image = nullable(ck.MakeImageFromEncoded(bytes));
 * if (image === null) throw decodeError();
 * ```
 */
export function nullable<T>(value: T): T | null {
  return value;
}
