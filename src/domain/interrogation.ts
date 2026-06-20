/** Network interrogation domain types (ADR-0011). */

/** What to interrogate, carried in a task spec's `inputs`. */
export interface ProbeTarget {
  readonly target: string;
  readonly method?: string;
  /** Optional assertion: the HTTP status the target is expected to return. */
  readonly expectStatus?: number;
}

/** Raw result of one interrogation. */
export interface ProbeResult {
  readonly target: string;
  readonly status: number; // 0 = could not connect
  readonly ms: number;
  readonly healthy: boolean; // transport-level reachability (2xx/3xx)
  readonly bytes?: number;
  readonly error?: string;
}

/** A recorded finding = the probe result + assertion outcome (stored in task.completed). */
export interface ProbeFinding extends ProbeResult {
  readonly expectStatus?: number;
  readonly violated: boolean; // assertion failed
  readonly ok: boolean; // healthy AND not violated
}

/** Build a finding from a result + expectation. */
export function evaluateProbe(result: ProbeResult, expectStatus?: number): ProbeFinding {
  const violated = expectStatus !== undefined && result.status !== expectStatus;
  const base = { ...result, violated, ok: result.healthy && !violated };
  return expectStatus !== undefined ? { ...base, expectStatus } : base;
}

/** Short human tag for a finding. */
export function findingTag(f: ProbeFinding): string {
  if (f.status === 0) return "UNREACHABLE"; // could not connect
  if (f.violated) return `VIOLATION(${f.status}!=${String(f.expectStatus)})`;
  if (!f.healthy) return `UNHEALTHY(${f.status})`; // reachable but 4xx/5xx
  return "OK";
}
