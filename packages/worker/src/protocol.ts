/**
 * Worker-Protokoll über stdio: `[u32 Länge][JSON]`, optional gefolgt von Binärdaten.
 *
 * Nachrichten: `init`, `chunk`, `frame`, `result`, `error`, `log`, `shutdown`.
 * Die Implementierung liegt in `@agentic-video/scheduler`, weil beide Seiten sie brauchen
 * und `worker` von `scheduler` abhängt (AD-14). Dieses Modul ist die Worker-Sicht darauf.
 *
 * @example
 * ```ts
 * import { MessageDecoder, encodeMessage } from '@agentic-video/worker';
 * process.stdout.write(encodeMessage({ type: 'log', line: '{"message":"ready"}' }));
 * ```
 */
export {
  MessageDecoder,
  encodeMessage,
  parseMessage,
  isChunkRequest,
  isChunkResult,
  isDiagnostic,
  MAX_HEADER_BYTES,
  type ChunkMessage,
  type ErrorMessage,
  type FrameMessage,
  type InitMessage,
  type LogMessage,
  type ProjectFile,
  type ProtocolMessage,
  type ResultMessage,
  type SharedInitMessage,
  type ShutdownMessage,
  type StreamInitMessage,
  type WorkerRunOptions,
} from '@agentic-video/scheduler';
