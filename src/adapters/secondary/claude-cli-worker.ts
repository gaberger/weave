import { spawn } from "node:child_process";

import type { Worker, TaskAssignment, WorkerContext, WorkerResult } from "../../ports/worker.js";

export interface ClaudeCliResult {
  code: number;
  stdout: string;
  stderr: string;
}

/** Injectable runner so the worker is testable without spawning `claude` (ADR-0003 §6). */
export type ClaudeCliRunner = (args: string[], signal: AbortSignal) => Promise<ClaudeCliResult>;

export const realClaudeCliRunner: ClaudeCliRunner = (args, signal) =>
  new Promise((resolve) => {
    const child = spawn("claude", args, { signal });
    let stdout = "";
    let stderr = "";
    child.stdout?.on("data", (d) => {
      stdout += String(d);
    });
    child.stderr?.on("data", (d) => {
      stderr += String(d);
    });
    child.on("close", (code) => resolve({ code: code ?? 0, stdout, stderr }));
    child.on("error", (e) => resolve({ code: 1, stdout, stderr: stderr + String(e) }));
  });

export interface ClaudeCliConfig {
  readonly model?: string;
  readonly systemPrompt?: string;
  /** Claude Code tools to auto-approve in print mode. The CLI uses Claude Code's OWN tools, not
   *  weave's ToolHost, so these bypass the effect-gate (ADR-0003 §6) — the caller decides the set.
   *  The composition root (cli.ts) grants write tools by default and revokes them under --read-only. */
  readonly allowedTools?: readonly string[];
}

/**
 * A Worker backed by the `claude -p` CLI (Claude Code in print mode). It uses the local
 * Claude Code login — **no ANTHROPIC_API_KEY needed** — and Claude Code's own tools. It's a
 * second backend behind the Worker port (ADR-0003): the SDK worker for programmatic/API-key
 * use, this for subscription/no-key use. It cannot intercept tool calls, so its authority is
 * fixed up-front by `allowedTools` (no per-call gate) rather than enforced per effect.
 */
export class ClaudeCliWorker implements Worker {
  constructor(
    private readonly cfg: ClaudeCliConfig = {},
    private readonly runner: ClaudeCliRunner = realClaudeCliRunner,
  ) {}

  async run(assignment: TaskAssignment, ctx: WorkerContext): Promise<WorkerResult> {
    if (ctx.signal.aborted) return { status: "aborted", summary: "cancelled", reason: "cancelled" };

    const args = ["-p", assignment.spec.goal];
    // Per-task model wins over the worker's startup default (ADR-0022 tiering); fall back to cfg.
    const model = assignment.spec.model ?? this.cfg.model;
    if (model) args.push("--model", model);
    if (this.cfg.systemPrompt) args.push("--append-system-prompt", this.cfg.systemPrompt);
    if (this.cfg.allowedTools && this.cfg.allowedTools.length > 0) {
      args.push("--allowedTools", ...this.cfg.allowedTools); // variadic; keep last
    }

    const res = await this.runner(args, ctx.signal);
    if (ctx.signal.aborted) return { status: "aborted", summary: "cancelled", reason: "cancelled" };
    if (res.code !== 0) {
      return { status: "failed", summary: res.stdout.trim() || "claude cli failed", error: res.stderr.trim() || `exit ${res.code}` };
    }
    return { status: "completed", summary: res.stdout.trim() };
  }
}
