/**
 * Operationsdefinition (AD-9): Name, Schemas, Beispiel und Handler an genau einer Stelle.
 * HTTP-Server, MCP-Server und CLI nutzen dieselben Definitionen.
 */
import type { Static, TSchema } from 'typebox';
import { OpenVideoError, closest, isRecord, validateValue, type Diagnostic } from '@agentic-video/core';
import { formatSegments } from './patch-schema.js';
import { assertProjectAccess } from './project-access.js';
import type { AgentServices } from './services.js';

/** Kontext eines Operationsaufrufs. */
export interface OperationContext {
  readonly services: AgentServices;
  /** Quelle des Aufrufs, z. B. `http`, `mcp`, `cli`. */
  readonly via: 'http' | 'mcp' | 'cli' | 'test';
  /** W3C-traceparent des Aufrufers (Request-Korrelation). */
  readonly traceparent?: string;
}

/** Eine Agent-Operation. */
export interface OperationDefinition<I extends TSchema = TSchema, O extends TSchema = TSchema> {
  /** Name der Form `bereich.verb`, z. B. `frame.render`. */
  readonly name: string;
  /** Ein Satz: was die Operation tut. */
  readonly summary: string;
  readonly input: I;
  readonly output: O;
  /** Kleines, eindeutiges Beispiel (FR-93). */
  readonly example: { readonly input: Static<I> };
  /** Lang laufend (liefert eine Job-ID)? */
  readonly job?: boolean;
  /**
   * Genauere Eingabeprüfung vor der Schema-Prüfung (z. B. Patch-Listen mit Diskriminator `op`).
   * Liefert die erste Diagnose oder `undefined`.
   */
  readonly check?: (input: unknown) => Diagnostic | undefined;
  handler(input: Static<I>, ctx: OperationContext): Promise<Static<O>>;
}

/** Hilfsfunktion mit Typinferenz. */
export function defineOperation<I extends TSchema, O extends TSchema>(def: OperationDefinition<I, O>): OperationDefinition<I, O> {
  return def;
}

/** Ergebnis eines Aufrufs über {@link invokeOperation}. */
export type InvocationResult = { readonly ok: true; readonly result: unknown } | { readonly ok: false; readonly error: Diagnostic };

/**
 * Validiert die Eingabe und ruft den Handler. Fehler werden zu Diagnosen.
 *
 * @example
 * ```ts
 * const r = await invokeOperation(ops, 'composition.validate', { projectId: 'demo' }, ctx);
 * ```
 */
export async function invokeOperation(operations: ReadonlyMap<string, OperationDefinition>, name: string, input: unknown, ctx: OperationContext): Promise<InvocationResult> {
  const op = operations.get(name);
  if (op === undefined) {
    return {
      ok: false,
      error: {
        code: 'OV_API_UNKNOWN_OPERATION',
        severity: 'error',
        errorClass: 'ApiError',
        problem: `Unknown operation "${name}".`,
        received: JSON.stringify(name),
        suggestions: [...didYouMean(name, [...operations.keys()]), `Use one of: ${[...operations.keys()].join(', ')}.`],
      },
    };
  }
  const special = op.check?.(input ?? {});
  if (special !== undefined) return { ok: false, error: withSuggestions(special, op) };
  const issues = validateValue(op.input, input ?? {});
  if (issues.length > 0) {
    const first = issues[0];
    return {
      ok: false,
      error: {
        code: 'OV_API_INPUT',
        severity: 'error',
        errorClass: 'ApiError',
        problem: `Invalid input for ${name}: ${issues.map((i) => `${formatSegments(i.segments) || '(root)'}: ${i.message}`).join('; ')}`,
        ...(first !== undefined ? { path: formatSegments(first.segments), expected: first.expected, received: receivedText(first.received) } : {}),
        suggestions: [...(first?.suggestion !== undefined ? [first.suggestion] : []), `Example input: ${JSON.stringify(op.example.input)}`],
      },
    };
  }
  try {
    // Eingebundene Projekte bei jedem Aufruf gegen die aktuellen Wurzeln prüfen (Review M3).
    if (isRecord(input) && typeof input['projectId'] === 'string') await assertProjectAccess(ctx.services, input['projectId']);
    const run = () => op.handler(input ?? {}, ctx);
    const result = await ctx.services.telemetry.withRemoteParent(ctx.traceparent, () => ctx.services.telemetry.withSpan(`op.${name}`, { via: ctx.via }, run));
    return { ok: true, result };
  } catch (error) {
    if (error instanceof OpenVideoError) return { ok: false, error: withSuggestions(error.diagnostic, op) };
    // Rohe Fehlertexte enthalten oft Host-Pfade; nach außen geht nur eine neutrale Meldung (B18).
    ctx.services.telemetry.logger.error('operation failed', { operation: name, via: ctx.via, traceparent: ctx.traceparent, error: error instanceof Error ? (error.stack ?? error.message) : String(error) });
    return {
      ok: false,
      error: {
        code: 'OV_INTERNAL',
        severity: 'error',
        errorClass: 'InternalError',
        problem: `Operation ${name} failed with an internal error.`,
        suggestions: ['This is a bug in OpenVideo. Please report it with the input; the server log has the details.'],
      },
    };
  }
}

/** Vorschlag „Did you mean …?“ für einen Namen aus einer Liste (leer, wenn nichts nah genug ist). */
function didYouMean(word: string, candidates: readonly string[]): string[] {
  const hit = closest(word, candidates);
  return hit !== undefined ? [`Did you mean "${hit}"?`] : [];
}

function receivedText(value: unknown): string {
  if (value === undefined) return 'undefined (missing)';
  const text = JSON.stringify(value);
  return text.length > 200 ? `${text.slice(0, 197)}...` : text;
}

/**
 * Stellt sicher, dass jede Fehlerdiagnose einer Operation mindestens einen konkreten Vorschlag
 * trägt (Story 19.6). Fehlt einer, wird auf das Beispiel und `diagnostics.get` verwiesen.
 */
function withSuggestions(d: Diagnostic, op: OperationDefinition): Diagnostic {
  if (d.suggestions.length > 0) return d;
  return { ...d, suggestions: [`Check the input against the example: ${JSON.stringify(op.example.input)}`, 'Call diagnostics.get for the full list of project diagnostics.'] };
}
