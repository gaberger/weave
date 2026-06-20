import type { TaskAssignment, WorkerContext, WorkerResult } from "./worker.js";
import type { ToolDefinition } from "./tool-host.js";

/**
 * A skill (ADR-0012): a named, self-describing capability — a Worker plus a `match`
 * predicate and the tools it needs. Skills are how weave "knows what to do"; the router
 * dispatches each task to a matching skill. Built-in and external-plugin skills implement
 * the same contract.
 */
export interface Skill {
  readonly name: string;
  readonly description: string;
  /** Tools this skill contributes to the shared ToolHost. */
  readonly tools?: readonly ToolDefinition[];
  /** Can this skill handle the task? (predicate routing) */
  match(task: TaskAssignment): boolean;
  run(task: TaskAssignment, ctx: WorkerContext): Promise<WorkerResult>;
}
