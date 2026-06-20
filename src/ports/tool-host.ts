import type { Effect } from "../domain/effect.js";

export type JsonSchema = Readonly<Record<string, unknown>>;

export interface ToolDescriptor {
  readonly name: string;
  readonly description: string;
  /** Normalized effect class — missing in the registry becomes "irreversible". */
  readonly effect: Effect;
  readonly inputSchema: JsonSchema;
}

export interface ToolCall {
  readonly name: string;
  readonly args: Readonly<Record<string, unknown>>;
}

export interface ToolResult {
  readonly ok: boolean;
  readonly output: unknown;
}

/** A registerable tool: a descriptor plus its executor. Skills contribute these
 *  (ADR-0012). Missing `effect` normalizes to "irreversible" (fail closed, ADR-0004). */
export interface ToolDefinition {
  readonly name: string;
  readonly description: string;
  readonly effect?: Effect;
  readonly inputSchema?: Readonly<Record<string, unknown>>;
  execute(args: Readonly<Record<string, unknown>>): Promise<ToolResult>;
}

export class NotPermittedError extends Error {
  constructor(public readonly tool: string) {
    super(`tool not permitted: ${tool}`);
    this.name = "NotPermittedError";
  }
}

/**
 * The capabilities a single worker may use (ADR-0004 §2). Per-worker, built from the
 * registry + a Grant. Does NOT check the lease — the worker runtime does that using the
 * effect classes from `available()`, keeping the gate in one place (ADR-0003 §2).
 */
export interface ToolHost {
  /** Registry filtered by the worker's grant (allowlist ∩ maxEffect ceiling). */
  available(): readonly ToolDescriptor[];
  /** Execute a permitted tool. Throws NotPermittedError if outside the grant. */
  invoke(call: ToolCall): Promise<ToolResult>;
}
