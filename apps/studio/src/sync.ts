/**
 * Live-Synchronisation (Story 20.1): Der Server meldet jede neue Revision von `project.json`
 * als Server-Sent Event. Das Studio vergleicht sie mit der Revision, die es zuletzt geladen hat,
 * und lädt bei Fremdänderungen (Agent, CLI, Editor, `openvideo dev`) neu.
 *
 * `EventSource` kann keinen `Authorization`-Header senden; darum liest das Studio den Stream mit `fetch`.
 */
import { authHeaders } from './api.js';

/** Ein Server-Sent Event. */
export interface SseEvent {
  readonly event: string;
  readonly data: string;
}

/**
 * Zerlegt gepufferten SSE-Text in vollständige Ereignisse; der unvollständige Rest bleibt stehen.
 *
 * @example
 * ```ts
 * parseSse('event: revision\ndata: {"revision":"a"}\n\n: ping\n\nevent: x');
 * // { events: [{ event: 'revision', data: '{"revision":"a"}' }], rest: 'event: x' }
 * ```
 */
export function parseSse(buffer: string): { events: SseEvent[]; rest: string } {
  const normalized = buffer.replace(/\r\n?/gu, '\n');
  const blocks = normalized.split('\n\n');
  const rest = blocks.pop() ?? '';
  const events: SseEvent[] = [];
  for (const block of blocks) {
    let event = 'message';
    const data: string[] = [];
    for (const line of block.split('\n')) {
      if (line === '' || line.startsWith(':')) continue;
      const colon = line.indexOf(':');
      const field = colon < 0 ? line : line.slice(0, colon);
      const value = colon < 0 ? '' : line.slice(colon + 1).replace(/^ /u, '');
      if (field === 'event') event = value;
      else if (field === 'data') data.push(value);
    }
    if (data.length > 0) events.push({ event, data: data.join('\n') });
  }
  return { events, rest };
}

/**
 * Entscheidet, ob eine gemeldete Revision auf eine Fremdänderung hindeuten kann.
 *
 * Ereignisse sind nur Hinweise: Das Echo einer eigenen Speicherung kann vor oder nach deren Antwort
 * eintreffen, der Anfangsstand eines neuen Stroms kann älter sein als eine gerade laufende Speicherung.
 * Eine abweichende Revision heißt darum nur „prüfen“: Der Store liest die Revision der Datei in der
 * Schreib-Warteschlange nach (`acknowledge`) und lädt nur neu, wenn sie wirklich von der geladenen abweicht.
 * Während eigener Schreibvorgänge (`busy`) wird eine Meldung nur vorgemerkt.
 *
 * @example
 * ```ts
 * const t = new RevisionTracker();
 * t.loaded('a');
 * t.remote('b', false); // true → Datei-Revision prüfen
 * t.acknowledge('b'); // geprüft; pending() ist wieder false
 * ```
 */
export class RevisionTracker {
  private known: string | undefined;
  private latest: string | undefined;

  /** Revision der zuletzt geladenen Daten. */
  get current(): string | undefined {
    return this.known;
  }

  /** Zuletzt gemeldete, noch nicht geprüfte Revision. */
  get reported(): string | undefined {
    return this.latest;
  }

  /** Das Studio hat Daten mit dieser Revision geladen. */
  loaded(revision: string | undefined): void {
    if (revision !== undefined) this.known = revision;
  }

  /**
   * Der Server meldet eine Revision. Liefert `true`, wenn jetzt geprüft werden muss.
   * Während eigener Schreibvorgänge (`busy`) wird nur vorgemerkt.
   */
  remote(revision: string, busy: boolean): boolean {
    this.latest = revision;
    if (busy || this.known === undefined) return false;
    return revision !== this.known;
  }

  /**
   * Die gemeldete Revision `revision` ist geprüft (die Datei wurde danach gelesen). Kam inzwischen
   * eine neuere Meldung, bleibt diese vorgemerkt.
   */
  acknowledge(revision: string | undefined): void {
    if (this.latest === revision) this.latest = undefined;
  }

  /** Steht eine ungeprüfte, abweichende Meldung aus? */
  pending(): boolean {
    return this.latest !== undefined && this.known !== undefined && this.latest !== this.known;
  }
}

/** Zustand der Verbindung. */
export type LiveState = 'connecting' | 'live' | 'offline';

/** Wartezeiten der Wiederverbindung. */
export interface ReconnectOptions {
  /** Erste Wartezeit nach einem Abbruch (Standard 1000 ms). */
  readonly minDelayMs?: number;
  /** Obergrenze der wachsenden Wartezeit (Standard 15 000 ms). */
  readonly maxDelayMs?: number;
}

/**
 * Abonniert `/v1/events` und meldet Revisionen; bricht die Verbindung ab, wird mit wachsender
 * Wartezeit (1 s … 15 s) neu verbunden. Der Server schickt bei jeder Verbindung zuerst den
 * aktuellen Stand; dieses Anfangsereignis zählt nicht. Die Wartezeit fällt erst zurück, wenn eine
 * Verbindung danach ein weiteres Ereignis geliefert hat oder mindestens `maxDelayMs` offen war –
 * ein Server, der Ströme nach dem Anfangsstand sofort wieder schließt, erzeugt so keine
 * Sekundentakt-Schleife (Review m5). Die zurückgegebene Funktion beendet Strom und Wiederverbindung
 * endgültig.
 *
 * @example
 * ```ts
 * const stop = subscribeRevisions('demo', (rev) => studio.onRemoteRevision(rev), (s) => console.log(s));
 * ```
 */
export function subscribeRevisions(projectId: string, onRevision: (revision: string) => void, onState: (state: LiveState) => void, options: ReconnectOptions = {}): () => void {
  const minDelay = options.minDelayMs ?? 1000;
  const maxDelay = Math.max(minDelay, options.maxDelayMs ?? 15_000);
  let stopped = false;
  // Als Funktion gelesen: `stop()` setzt den Wert zwischen den awaits.
  const isStopped = (): boolean => stopped;
  let controller: AbortController | undefined;
  let retry = minDelay;
  let timer: ReturnType<typeof setTimeout> | undefined;

  const connect = async (): Promise<void> => {
    if (isStopped()) return;
    controller = new AbortController();
    onState('connecting');
    let events = 0;
    let openedAt: number | undefined;
    try {
      const response = await fetch(`/v1/events?projectId=${encodeURIComponent(projectId)}`, { headers: { accept: 'text/event-stream', ...authHeaders() }, signal: controller.signal, cache: 'no-store' });
      const body = response.body;
      if (!response.ok || body === null) throw new Error(`HTTP ${String(response.status)}`);
      const reader = body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      if (isStopped()) {
        await reader.cancel();
        return;
      }
      onState('live');
      openedAt = Date.now();
      for (;;) {
        const chunk = await reader.read();
        if (chunk.done || isStopped()) break;
        buffer += decoder.decode(chunk.value, { stream: true });
        const parsed = parseSse(buffer);
        buffer = parsed.rest;
        for (const e of parsed.events) {
          if (e.event !== 'revision') continue;
          const data: unknown = JSON.parse(e.data);
          if (typeof data === 'object' && data !== null && 'revision' in data && typeof data.revision === 'string') {
            events++;
            onRevision(data.revision);
          }
        }
      }
    } catch (error) {
      if (isStopped()) return;
      console.warn('OpenVideo Studio: live updates interrupted', error);
    }
    if (isStopped()) return;
    onState('offline');
    // Die Verbindung trug (mehr als den Anfangsstand oder lange genug): wieder kurz warten.
    if (events > 1 || (openedAt !== undefined && Date.now() - openedAt >= maxDelay)) retry = minDelay;
    timer = setTimeout(() => {
      timer = undefined;
      void connect();
    }, retry);
    retry = Math.min(maxDelay, retry * 2);
  };

  void connect();
  return () => {
    stopped = true;
    if (timer !== undefined) clearTimeout(timer);
    timer = undefined;
    controller?.abort();
  };
}
