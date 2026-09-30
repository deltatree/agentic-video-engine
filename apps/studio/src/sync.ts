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
 * Entscheidet, ob eine gemeldete Revision eine Fremdänderung ist.
 *
 * Eigene Schreibvorgänge laufen über die Patch-Warteschlange; solange sie arbeitet, wird eine
 * gemeldete Revision nur vorgemerkt. Nach dem Neuladen („loaded“) zählt die Revision der geladenen
 * Datei. Weicht die zuletzt gemeldete danach noch ab, kam die Änderung von außen.
 *
 * @example
 * ```ts
 * const t = new RevisionTracker();
 * t.loaded('a');
 * t.remote('b', false); // true → Fremdänderung, neu laden
 * ```
 */
export class RevisionTracker {
  private known: string | undefined;
  private latest: string | undefined;

  /** Revision der zuletzt geladenen Daten. */
  get current(): string | undefined {
    return this.known;
  }

  /** Das Studio hat Daten mit dieser Revision geladen. */
  loaded(revision: string | undefined): void {
    if (revision !== undefined) this.known = revision;
  }

  /**
   * Der Server meldet eine Revision. Liefert `true`, wenn jetzt neu geladen werden muss
   * (Fremdänderung). Während eigener Schreibvorgänge (`busy`) wird nur vorgemerkt.
   */
  remote(revision: string, busy: boolean): boolean {
    this.latest = revision;
    if (busy || this.known === undefined) return false;
    return revision !== this.known;
  }

  /** Nach eigenen Schreibvorgängen und Neuladen: Steht eine Fremdänderung aus? */
  pending(): boolean {
    return this.latest !== undefined && this.known !== undefined && this.latest !== this.known;
  }
}

/** Zustand der Verbindung. */
export type LiveState = 'connecting' | 'live' | 'offline';

/**
 * Abonniert `/v1/events` und meldet Revisionen; bricht die Verbindung ab, wird mit wachsender
 * Wartezeit (1 s … 15 s) neu verbunden.
 *
 * @example
 * ```ts
 * const stop = subscribeRevisions('demo', (rev) => studio.onRemoteRevision(rev), (s) => console.log(s));
 * ```
 */
export function subscribeRevisions(projectId: string, onRevision: (revision: string) => void, onState: (state: LiveState) => void): () => void {
  let stopped = false;
  let controller: AbortController | undefined;
  let retry = 1000;
  let timer: ReturnType<typeof setTimeout> | undefined;

  const connect = async (): Promise<void> => {
    controller = new AbortController();
    onState('connecting');
    try {
      const response = await fetch(`/v1/events?projectId=${encodeURIComponent(projectId)}`, { headers: { accept: 'text/event-stream', ...authHeaders() }, signal: controller.signal, cache: 'no-store' });
      const body = response.body;
      if (!response.ok || body === null) throw new Error(`HTTP ${String(response.status)}`);
      const reader = body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      onState('live');
      retry = 1000;
      for (;;) {
        const chunk = await reader.read();
        if (chunk.done) break;
        buffer += decoder.decode(chunk.value, { stream: true });
        const parsed = parseSse(buffer);
        buffer = parsed.rest;
        for (const e of parsed.events) {
          if (e.event !== 'revision') continue;
          const data: unknown = JSON.parse(e.data);
          if (typeof data === 'object' && data !== null && 'revision' in data && typeof data.revision === 'string') onRevision(data.revision);
        }
      }
    } catch (error) {
      if (stopped) return;
      console.warn('OpenVideo Studio: live updates interrupted', error);
    }
    if (stopped) return;
    onState('offline');
    timer = setTimeout(() => {
      void connect();
    }, retry);
    retry = Math.min(15_000, retry * 2);
  };

  void connect();
  return () => {
    stopped = true;
    if (timer !== undefined) clearTimeout(timer);
    controller?.abort();
  };
}
