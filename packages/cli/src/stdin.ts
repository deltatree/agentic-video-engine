import type { Readable } from 'node:stream';

/**
 * Wartet, bis ein Eingabestrom endet (`end` oder `close`). Ist er schon beendet, kehrt die Funktion
 * sofort zurück. So beendet sich `openvideo mcp` sauber mit Exit-Code 0, wenn der Client stdin schließt,
 * auch wenn das schon vor dem Warten geschah.
 *
 * @example
 * ```ts
 * import { stdinClosed } from '@agentic-video/cli';
 * await stdinClosed(process.stdin);
 * ```
 */
export function stdinClosed(stream: Readable): Promise<void> {
  if (stream.readableEnded || stream.destroyed || stream.closed) return Promise.resolve();
  return new Promise<void>((resolve) => {
    const done = (): void => {
      stream.off('end', done);
      stream.off('close', done);
      resolve();
    };
    stream.once('end', done);
    stream.once('close', done);
    stream.resume();
  });
}
