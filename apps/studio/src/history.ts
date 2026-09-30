/**
 * Undo-Verlauf des Studios (Story 20.3). Reine Logik ohne DOM, damit sie testbar ist.
 *
 * Ein Eintrag ist entweder eine Liste inverser Patches (`composition.patch` liefert sie) oder
 * ein ganzer Projektstand (Code-Save über `project.update`). Kurz hintereinander folgende
 * Änderungen mit gleichem Schlüssel (z. B. Pfeiltasten-Nudges derselben Auswahl) werden zu
 * einem Schritt zusammengefasst.
 */
import type { PatchJson, Rec } from './json.js';

/** Ein Schritt, der eine Änderung umkehrt. */
export type HistoryEntry = { readonly kind: 'patches'; readonly patches: readonly PatchJson[] } | { readonly kind: 'project'; readonly project: Readonly<Rec> };

interface Stored {
  readonly entry: HistoryEntry;
  readonly key: string | undefined;
  readonly at: number;
}

/**
 * Undo- und Redo-Stapel.
 *
 * @example
 * ```ts
 * const h = new History();
 * h.record({ kind: 'patches', patches: inverse });
 * const step = h.popUndo(); // → an den Server schicken, Umkehrung mit pushRedo ablegen
 * ```
 */
export class History {
  private undo: Stored[] = [];
  private redo: Stored[] = [];

  /**
   * @param mergeWindowMs Zeitfenster, in dem Einträge mit gleichem Schlüssel verschmelzen.
   * @param limit Höchstzahl gespeicherter Schritte.
   */
  constructor(
    private readonly mergeWindowMs = 1000,
    private readonly limit = 200,
  ) {}

  get canUndo(): boolean {
    return this.undo.length > 0;
  }

  get canRedo(): boolean {
    return this.redo.length > 0;
  }

  /** Anzahl der Undo-Schritte. */
  get size(): number {
    return this.undo.length;
  }

  /**
   * Legt eine neue Änderung ab und leert Redo. Mit `key` verschmilzt sie mit dem letzten Eintrag
   * gleichen Schlüssels, wenn dieser höchstens `mergeWindowMs` alt ist: Die neue Umkehrung läuft
   * zuerst, danach die ältere.
   */
  record(entry: HistoryEntry, key?: string, now = 0): void {
    this.redo = [];
    const top = this.undo[this.undo.length - 1];
    if (key !== undefined && top !== undefined && top.key === key && now - top.at <= this.mergeWindowMs && top.entry.kind === 'patches' && entry.kind === 'patches') {
      this.undo[this.undo.length - 1] = { entry: { kind: 'patches', patches: [...entry.patches, ...top.entry.patches] }, key, at: now };
      return;
    }
    this.undo.push({ entry, key, at: now });
    if (this.undo.length > this.limit) this.undo.shift();
  }

  /** Nimmt den letzten Undo-Schritt. */
  popUndo(): HistoryEntry | undefined {
    return this.undo.pop()?.entry;
  }

  /** Nimmt den letzten Redo-Schritt. */
  popRedo(): HistoryEntry | undefined {
    return this.redo.pop()?.entry;
  }

  /** Legt die Umkehrung eines ausgeführten Undo auf den Redo-Stapel. */
  pushRedo(entry: HistoryEntry): void {
    this.redo.push({ entry, key: undefined, at: 0 });
  }

  /** Legt die Umkehrung eines ausgeführten Redo auf den Undo-Stapel (Redo bleibt erhalten). */
  pushUndo(entry: HistoryEntry): void {
    this.undo.push({ entry, key: undefined, at: 0 });
  }

  /** Stellt einen fehlgeschlagenen Schritt zurück auf seinen Stapel. */
  restore(side: 'undo' | 'redo', entry: HistoryEntry): void {
    (side === 'undo' ? this.undo : this.redo).push({ entry, key: undefined, at: 0 });
  }

  /** Beendet das Zusammenfassen (der nächste Eintrag beginnt einen neuen Schritt). */
  seal(): void {
    const top = this.undo[this.undo.length - 1];
    if (top !== undefined) this.undo[this.undo.length - 1] = { ...top, key: undefined };
  }

  /** Verwirft alles (z. B. nach einer Fremdänderung, deren Stand die Umkehrungen ungültig macht). */
  clear(): void {
    this.undo = [];
    this.redo = [];
  }
}
