/** A scheduler abstraction (ADR-0005 §4) so the peer loop's heartbeat/sweep cadence is
 *  injectable and deterministic under test rather than bound to wall-clock setInterval. */
export type Cancel = () => void;

export interface Timer {
  /** Invoke `fn` every `ms`. Returns a cancel handle. */
  every(ms: number, fn: () => void): Cancel;
}
