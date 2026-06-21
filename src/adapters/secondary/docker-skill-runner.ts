import { spawn } from "node:child_process";
import { createInterface } from "node:readline";

import type { Worker, TaskAssignment, WorkerContext, WorkerResult } from "../../ports/worker.js";
import type { ToolCall } from "../../ports/tool-host.js";

/** Maps a task to the code-skill file that should run it (composition decides the policy). */
export type ResolveSkillFile = (task: TaskAssignment) => string | undefined;

/** The one trusted edge to a sandboxed process: a line-delimited duplex + a kill (ADR-0018).
 *  Injectable so the parent-drive logic is testable without a real container. */
export interface SandboxProcess {
  send(line: string): void;
  onLine(cb: (line: string) => void): void;
  onError(cb: (err: Error) => void): void;
  onExit(cb: (code: number | null) => void): void;
  kill(): void;
}

export interface DockerSandboxOptions {
  /** Image baked with the executor entry (see sandbox/Dockerfile). */
  readonly image: string;
  readonly timeoutMs: number;
  readonly memory?: string; // e.g. "256m"
  readonly cpus?: string; // e.g. "1"
  readonly pidsLimit?: number; // default 64
  readonly network?: string; // default "none" — the OS confinement that closes the worker_threads gap
  /** Override the spawn (tests inject a fake speaking the line protocol). */
  readonly spawnProcess?: (skillFile: string, name: string) => SandboxProcess;
  /** Unique container-name source; defaults to a per-process counter. */
  readonly newId?: () => string;
}

let nameSeq = 0;

/**
 * Runs a self-authored **code skill** inside a Docker container (ADR-0018) — a `Worker`-port
 * adapter, so swapping worker_threads → Docker is a composition wiring, not a rewrite. With
 * `--network none --read-only --cap-drop ALL`, the container's ONLY I/O path is the stdio RPC
 * back to this parent, which invokes tools on the caller's grant-filtered `ToolHost`. So the
 * ADR-0004 grant becomes a true capability boundary: authored code cannot reach fs/net except
 * by asking for a tool it is granted. This is the OS-level confinement worker_threads lacked.
 */
export class DockerSkillRunner implements Worker {
  constructor(
    private readonly resolveFile: ResolveSkillFile,
    private readonly opts: DockerSandboxOptions,
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

    const name = `weave-sbx-${this.opts.newId?.() ?? `${process.pid}-${nameSeq++}`}`;
    const proc = (this.opts.spawnProcess ?? defaultDockerSpawn(this.opts))(skillFile, name);

    return new Promise<WorkerResult>((resolve) => {
      let settled = false;
      const finish = (result: WorkerResult): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        ctx.signal.removeEventListener("abort", onAbort);
        proc.kill();
        resolve(result);
      };

      const timer = setTimeout(
        () => finish({ status: "failed", summary: `sandbox timed out after ${this.opts.timeoutMs}ms`, error: "timeout" }),
        this.opts.timeoutMs,
      );
      const onAbort = (): void => finish({ status: "aborted", summary: "cancelled", reason: "cancelled" });
      if (ctx.signal.aborted) return onAbort();
      ctx.signal.addEventListener("abort", onAbort);

      proc.onLine((line) => {
        if (line.trim() === "") return;
        let msg: { type?: string; id?: number; call?: ToolCall; note?: string; result?: WorkerResult; message?: string };
        try {
          msg = JSON.parse(line);
        } catch {
          return; // ignore non-protocol noise (e.g. a stray container log line)
        }
        if (msg.type === "tool" && typeof msg.id === "number" && msg.call) {
          const id = msg.id;
          // Invoke on the PARENT's grant-filtered host; relay the result or the gate's denial.
          ctx.tools.invoke(msg.call).then(
            (result) => proc.send(JSON.stringify({ id, result })),
            (err: unknown) => proc.send(JSON.stringify({ id, error: err instanceof Error ? err.message : String(err) })),
          );
        } else if (msg.type === "progress" && typeof msg.note === "string") {
          ctx.onProgress(msg.note);
        } else if (msg.type === "done" && msg.result) {
          finish(msg.result);
        } else if (msg.type === "error") {
          finish({ status: "failed", summary: "skill threw in sandbox", error: msg.message ?? "unknown" });
        }
      });
      proc.onError((err) => finish({ status: "failed", summary: "sandbox spawn error", error: err.message }));
      proc.onExit((code) => {
        if (code !== 0) finish({ status: "failed", summary: `sandbox exited (code ${code})`, error: "container_exit" });
      });
    });
  }
}

/** Real `docker run` with a confined container; killable by container name. */
function defaultDockerSpawn(opts: DockerSandboxOptions): (skillFile: string, name: string) => SandboxProcess {
  return (skillFile, name) => {
    const args = [
      "run", "--rm", "-i",
      "--name", name,
      "--network", opts.network ?? "none",
      "--read-only",
      "--cap-drop", "ALL",
      "--security-opt", "no-new-privileges",
      "--pids-limit", String(opts.pidsLimit ?? 64),
      "--memory", opts.memory ?? "256m",
      "--cpus", opts.cpus ?? "1",
      "--tmpfs", "/tmp:size=16m",
      "-v", `${skillFile}:/skill/s.mjs:ro`,
      opts.image, "/skill/s.mjs",
    ];
    const child = spawn("docker", args, { stdio: ["pipe", "pipe", "pipe"] });
    const rl = createInterface({ input: child.stdout });
    return {
      send: (line) => child.stdin.write(line + "\n"),
      onLine: (cb) => rl.on("line", cb),
      onError: (cb) => child.on("error", cb),
      onExit: (cb) => child.on("exit", cb),
      // SIGKILL the client and force-remove the container so a runaway can't outlive the run.
      kill: () => {
        try {
          child.kill("SIGKILL");
        } catch {
          /* already gone */
        }
        spawn("docker", ["rm", "-f", name], { stdio: "ignore" }).on("error", () => {});
      },
    };
  };
}
