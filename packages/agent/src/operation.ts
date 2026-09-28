/**
 * Operationsdefinition (AD-9): Name, Schemas, Beispiel und Handler an genau einer Stelle.
 * HTTP-Server, MCP-Server und CLI nutzen dieselben Definitionen.
 */
import type { Static, TSchema } from 'typebox';
import { OpenVideoError, validateValue, type Diagnostic } from '@agentic-video/core';
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
        suggestions: [`Use one of: ${[...operations.keys()].join(', ')}.`],
      },
    };
  }
  const issues = validateValue(op.input, input ?? {});
  if (issues.length > 0) {
    const first = issues[0];
    return {
      ok: false,
      error: {
        code: 'OV_API_INPUT',
        severity: 'error',
        errorClass: 'ApiError',
        problem: `Invalid input for ${name}: ${issues.map((i) => `${i.segments.join('.') || '(root)'}: ${i.message}`).join('; ')}`,
        ...(first !== undefined ? { path: first.segments.join('.'), expected: first.expected } : {}),
        suggestions: [`Example input: ${JSON.stringify(op.example.input)}`],
      },
    };
  }
  try {
    const run = () => op.handler(input ?? {}, ctx);
    const result = await ctx.services.telemetry.withRemoteParent(ctx.traceparent, () => ctx.services.telemetry.withSpan(`op.${name}`, { via: ctx.via }, run));
    return { ok: true, result };
  } catch (error) {
    if (error instanceof OpenVideoError) return { ok: false, error: error.diagnostic };
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
