import { Worker as ThreadWorker } from "node:worker_threads";

import type { Worker, TaskAssignment, WorkerContext, WorkerResult } from "../../ports/worker.js";
import type { ToolCall } from "../../ports/tool-host.js";

/** Resource ceiling for a sandboxed skill run (ADR-0017 §4). */
export interface SandboxLimits {
  /** Hard wall-clock cap; on breach the thread is terminated and the run fails. */
  readonly timeoutMs: number;
  /** V8 old-space cap (MB); on breach the thread dies and the run fails. */
  readonly maxOldGenerationSizeMb?: number;
}

/** Maps a task to the code-skill file that should run it. Composition decides the policy. */
export type ResolveSkillFile = (task: TaskAssignment) => string | undefined;

type FromWorker =
  | { type: "tool"; id: number; call: ToolCall }
  | { type: "progress"; note: string }
  | { type: "done"; result: WorkerResult }
  | { type: "error"; message: string };

/**
 * Runs a self-authored **code skill** in a `worker_threads` thread (ADR-0017 §4) — a `Worker`
 * port adapter, so choosing sandboxed vs. in-process execution is a composition wiring, not a
 * rewrite. The thread reaches tools ONLY by RPC back to this parent, which invokes them on the
 * caller's grant-filtered `ToolHost` — so the grant/effect ceiling (ADR-0004) holds across the
 * thread boundary. A timeout and a memory cap bound a runaway skill.
 *
 * Honest scope: worker_threads gives fault isolation, resource limits, and the tool boundary —
 * NOT OS-level capability confinement (a thread shares process privileges and can touch fs/net
 * directly). True confinement is a child-process/container runner behind this same port — the
 * hex win is that it would be a drop-in swap. See ADR-0017 "Negative / risks".
 */
export class SandboxedSkillRunner implements Worker {
  constructor(
    private readonly resolveFile: ResolveSkillFile,
    private readonly limits: SandboxLimits,
  ) {}

  run(assignment: TaskAssignment, ctx: WorkerContext): Promise<WorkerResult> {
    const skillFile = this.resolveFile(assignment);
    if (skillFile === undefined) {
      return Promise.resolve({
        status: "failed",
        summary: `no code-skill file for "${assignment.spec.goal}"`,
        error: "no_skill_file",
      });
    }

    // Worker entry sits beside this module; match its runtime extension (.ts under tsx, .js in dist).
    const underTsx = import.meta.url.endsWith(".ts");
    const ext = underTsx ? ".ts" : ".js";
    const entry = new URL(`./sandboxed-skill-entry${ext}`, import.meta.url);

    // The thread must be able to import the entry. In dist it's a plain .js — load the file directly.
    // Under tsx (dev/test) the entry is .ts, so the thread needs the TS loader — but `--import tsx` in
    // the worker's execArgv registers it only on Node 22, not Node 20 (where the loader never reaches a
    // worker spawned from a test-runner subprocess → `Unknown file extension ".ts"`). The robust path is
    // to register tsx *inside* the worker via its programmatic API before importing the .ts entry; a
    // tiny eval bootstrap does exactly that, in-thread, independent of how flags propagate.
    const bootstrap = `import('tsx/esm/api').then(function (m) { m.register(); return import(${JSON.stringify(entry.href)}); })`;

    return new Promise<WorkerResult>((resolve) => {
      const thread = underTsx
        ? new ThreadWorker(bootstrap, {
            eval: true,
            workerData: { skillFile, task: assignment },
            resourceLimits:
              this.limits.maxOldGenerationSizeMb !== undefined
                ? { maxOldGenerationSizeMb: this.limits.maxOldGenerationSizeMb }
                : undefined,
          })
        : new ThreadWorker(entry, {
            workerData: { skillFile, task: assignment },
            execArgv: process.execArgv,
            resourceLimits:
              this.limits.maxOldGenerationSizeMb !== undefined
                ? { maxOldGenerationSizeMb: this.limits.maxOldGenerationSizeMb }
                : undefined,
          });

      let settled = false;
      const finish = (result: WorkerResult): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        ctx.signal.removeEventListener("abort", onAbort);
        void thread.terminate();
        resolve(result);
      };

      const timer = setTimeout(() => {
        finish({ status: "failed", summary: `sandbox timed out after ${this.limits.timeoutMs}ms`, error: "timeout" });
      }, this.limits.timeoutMs);
      const onAbort = (): void => {
        finish({ status: "aborted", summary: "cancelled", reason: "cancelled" });
      };
      if (ctx.signal.aborted) return onAbort();
      ctx.signal.addEventListener("abort", onAbort);

      thread.on("message", (msg: FromWorker) => {
        if (msg.type === "tool") {
          // Invoke on the PARENT's grant-filtered host; relay the result (or the gate's denial).
          ctx.tools.invoke(msg.call).then(
            (result) => thread.postMessage({ id: msg.id, result }),
            (err: unknown) =>
              thread.postMessage({ id: msg.id, error: err instanceof Error ? err.message : String(err) }),
          );
        } else if (msg.type === "progress") {
          ctx.onProgress(msg.note);
        } else if (msg.type === "done") {
          finish(msg.result);
        } else {
          finish({ status: "failed", summary: "skill threw in sandbox", error: msg.message });
        }
      });
      thread.on("error", (err) => {
        finish({ status: "failed", summary: "sandbox thread error", error: err.message });
      });
      thread.on("exit", (code) => {
        // A clean done/error already settled; a bare nonzero exit means the thread died
        // (e.g. resource-limit breach) without reporting.
        if (code !== 0) {
          finish({ status: "failed", summary: `sandbox exited (code ${code})`, error: "thread_exit" });
        }
      });
    });
  }
}
