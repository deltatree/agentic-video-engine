/**
 * Warteschlangen des Studios (Story 20.3, 20.5): Schreibende Aufrufe laufen streng nacheinander,
 * Vorschau-Renders dagegen „nur der neueste zählt“ mit Mindestabstand.
 */

/**
 * Führt asynchrone Aufgaben nacheinander aus; ein Fehler bricht die Kette nicht ab.
 *
 * @example
 * ```ts
 * const q = new SerialQueue();
 * await Promise.all([q.run(() => save(a)), q.run(() => save(b))]); // b startet erst nach a
 * ```
 */
export class SerialQueue {
  private tail: Promise<unknown> = Promise.resolve();
  private count = 0;
  private readonly idleWaiters: (() => void)[] = [];

  /** Anzahl wartender und laufender Aufgaben. */
  get pending(): number {
    return this.count;
  }

  /** Hängt eine Aufgabe an. */
  run<T>(task: () => Promise<T>): Promise<T> {
    this.count++;
    const result = this.tail.then(task);
    this.tail = result
      .catch(() => undefined)
      .finally(() => {
        this.count--;
        if (this.count === 0) for (const w of this.idleWaiters.splice(0)) w();
      });
    return result;
  }

  /** Wartet, bis keine Aufgabe mehr läuft. */
  idle(): Promise<void> {
    if (this.count === 0) return Promise.resolve();
    return new Promise((resolve) => this.idleWaiters.push(resolve));
  }
}

/**
 * Drosselt eine teure Aufgabe: Höchstens ein Aufruf läuft; kommen währenddessen neue Werte,
 * läuft danach nur der neueste, frühestens `intervalMs` nach dem Start des vorigen.
 *
 * @example
 * ```ts
 * const preview = new LatestOnly<Patch[]>((p) => renderPreview(p), 80);
 * preview.push(patches); // während des Ziehens beliebig oft
 * ```
 */
export class LatestOnly<T> {
  private running = false;
  private next: { value: T } | undefined;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private lastStart = -Infinity;

  constructor(
    private readonly task: (value: T) => Promise<void>,
    private readonly intervalMs: number,
    private readonly now: () => number = () => performance.now(),
  ) {}

  /** Legt einen neuen Wert ab (ältere, noch nicht gestartete Werte verfallen). */
  push(value: T): void {
    this.next = { value };
    this.pump();
  }

  /** Verwirft einen noch nicht gestarteten Wert. */
  cancel(): void {
    this.next = undefined;
    if (this.timer !== undefined) clearTimeout(this.timer);
    this.timer = undefined;
  }

  private pump(): void {
    if (this.running || this.next === undefined || this.timer !== undefined) return;
    const wait = this.lastStart + this.intervalMs - this.now();
    if (wait > 0) {
      this.timer = setTimeout(() => {
        this.timer = undefined;
        this.pump();
      }, wait);
      return;
    }
    const { value } = this.next;
    this.next = undefined;
    this.running = true;
    this.lastStart = this.now();
    void this.task(value)
      .catch(() => undefined)
      .finally(() => {
        this.running = false;
        this.pump();
      });
  }
}
