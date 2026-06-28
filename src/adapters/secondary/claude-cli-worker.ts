import { spawn } from "node:child_process";

import type { Worker, TaskAssignment, WorkerContext, WorkerResult } from "../../ports/worker.js";

export interface ClaudeCliResult {
  code: number;
  stdout: string;
  stderr: string;
}

/** Injectable runner so the worker is testable without spawning `claude` (ADR-0003 §6). `onData` is
 *  invoked with each stdout chunk as it arrives so the worker can stream progress; the resolved
 *  `stdout` still holds the full output for the buffered (non-streaming) fallback. */
export type ClaudeCliRunner = (
  args: string[],
  signal: AbortSignal,
  onData?: (chunk: string) => void,
) => Promise<ClaudeCliResult>;

export const realClaudeCliRunner: ClaudeCliRunner = (args, signal, onData) =>
  new Promise((resolve) => {
    // stdin: "ignore" (= /dev/null). The prompt is passed as an argv arg, so `claude -p` needs no
    // stdin — but if it inherits an open-but-silent stdin pipe (as it does under a daemonized peer),
    // it can BLOCK waiting for input and hang the whole turn. Detaching stdin is the fix; the stall
    // watchdog (ADR-0005 §4) is the safety net. stdout/stderr stay piped so we can stream them.
    const child = spawn("claude", args, { signal, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout?.on("data", (d) => {
      const s = String(d);
      stdout += s;
      onData?.(s);
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
   *  The composition root (cli.ts) grants write tools by default and revokes them under --read-only.
   *  MCP integration tools (`mcp__<server>__<tool>`) are granted here too — composition derives the
   *  grants from the declared servers, so an autonomous (non-interactive) peer never blocks on a
   *  permission prompt yet its authority stays bounded to the servers you wired. */
  readonly allowedTools?: readonly string[];
  /** Path(s) to MCP server config JSON (the `.mcp.json` shape: `{ "mcpServers": { … } }`). Passed to
   *  `claude -p --mcp-config`, with `--strict-mcp-config` so ONLY these servers load — reproducible,
   *  independent of the user's global Claude Code MCP config (ADR-0003 §6). This is how an agent skill
   *  reaches outbound integrations (GitHub, Slack, …) without a per-service weave tool adapter. */
  readonly mcpConfig?: string;
}

const trunc = (s: string, n: number): string => {
  const flat = s.replace(/\s+/g, " ").trim();
  return flat.length > n ? flat.slice(0, n - 1) + "…" : flat;
};

/** Pick the most informative argument of a tool call for a one-line progress note. */
function toolArg(input: unknown): string {
  if (!input || typeof input !== "object") return "";
  const o = input as Record<string, unknown>;
  for (const k of ["file_path", "path", "command", "query", "url", "pattern", "prompt", "description"]) {
    if (typeof o[k] === "string") return trunc(o[k] as string, 72);
  }
  const firstStr = Object.values(o).find((v) => typeof v === "string") as string | undefined;
  return firstStr ? trunc(firstStr, 72) : "";
}

/** Map one parsed `stream-json` event to a progress note (or null to ignore) and accumulate the
 *  final result text. Exposed for testing. Surfaces the agent's narration and each tool call —
 *  the payload a long turn otherwise hides behind a wall of lease renewals (ADR-0003 §6). */
export function progressFromEvent(e: Record<string, unknown>): { note?: string; result?: string; isError?: boolean } {
  const type = e["type"];
  if (type === "system" && e["subtype"] === "init") {
    const model = typeof e["model"] === "string" ? e["model"] : "";
    return { note: model ? `· session started (${model})` : "· session started" };
  }
  if (type === "assistant") {
    const msg = (e["message"] as Record<string, unknown>) ?? {};
    const blocks = Array.isArray(msg["content"]) ? (msg["content"] as Array<Record<string, unknown>>) : [];
    for (const b of blocks) {
      if (b["type"] === "tool_use" && typeof b["name"] === "string") {
        const arg = toolArg(b["input"]);
        return { note: `→ ${b["name"]}${arg ? ` ${arg}` : ""}` };
      }
      if (b["type"] === "text" && typeof b["text"] === "string" && b["text"].trim()) {
        return { note: `› ${trunc(b["text"] as string, 140)}` };
      }
    }
    return {};
  }
  if (type === "result") {
    const r = e["result"];
    const isError = e["is_error"] === true;
    // Omit `result` rather than set it to undefined (exactOptionalPropertyTypes).
    return typeof r === "string" ? { result: r, isError } : { isError };
  }
  return {};
}

/**
 * A Worker backed by the `claude -p` CLI (Claude Code in print mode). It uses the local
 * Claude Code login — **no ANTHROPIC_API_KEY needed** — and Claude Code's own tools. It's a
 * second backend behind the Worker port (ADR-0003): the SDK worker for programmatic/API-key
 * use, this for subscription/no-key use. It cannot intercept tool calls, so its authority is
 * fixed up-front by `allowedTools` (no per-call gate) rather than enforced per effect.
 *
 * Runs in streaming mode (`--output-format stream-json`) so the agent's narration and each tool
 * call are surfaced as `task.progress` events while the turn is in flight — otherwise a multi-minute
 * task shows nothing but lease renewals. The final answer is taken from the stream's `result` event,
 * falling back to raw stdout when the output isn't stream-json (keeps the buffered runner usable).
 */
export class ClaudeCliWorker implements Worker {
  constructor(
    private readonly cfg: ClaudeCliConfig = {},
    private readonly runner: ClaudeCliRunner = realClaudeCliRunner,
  ) {}

  async run(assignment: TaskAssignment, ctx: WorkerContext): Promise<WorkerResult> {
    if (ctx.signal.aborted) return { status: "aborted", summary: "cancelled", reason: "cancelled" };

    const args = ["-p", assignment.spec.goal, "--output-format", "stream-json", "--verbose"];
    // Per-task model wins over the worker's startup default (ADR-0022 tiering); fall back to cfg.
    const model = assignment.spec.model ?? this.cfg.model;
    if (model) args.push("--model", model);
    if (this.cfg.systemPrompt) args.push("--append-system-prompt", this.cfg.systemPrompt);
    // MCP servers BEFORE allowedTools: --strict-mcp-config loads only our declared servers (ignoring
    // the user's global config) so runs are reproducible; the grants for these servers' tools were
    // folded into allowedTools by composition. Kept ahead of the variadic --allowedTools below.
    if (this.cfg.mcpConfig) args.push("--mcp-config", this.cfg.mcpConfig, "--strict-mcp-config");
    if (this.cfg.allowedTools && this.cfg.allowedTools.length > 0) {
      args.push("--allowedTools", ...this.cfg.allowedTools); // variadic; keep last
    }

    // Parse the newline-delimited JSON stream incrementally, emitting a progress note per event.
    let buf = "";
    let result: string | undefined;
    let isError = false;
    let lastNote = "";
    const handleLine = (line: string) => {
      const s = line.trim();
      if (!s) return;
      let e: Record<string, unknown>;
      try {
        e = JSON.parse(s) as Record<string, unknown>;
      } catch {
        return; // tolerate any non-JSON line (e.g. a buffered-fallback plain string)
      }
      const out = progressFromEvent(e);
      if (out.result !== undefined) result = out.result;
      if (out.isError) isError = true;
      if (out.note && out.note !== lastNote) {
        lastNote = out.note;
        ctx.onProgress(out.note);
      }
    };
    const onData = (chunk: string) => {
      buf += chunk;
      let nl: number;
      while ((nl = buf.indexOf("\n")) >= 0) {
        handleLine(buf.slice(0, nl));
        buf = buf.slice(nl + 1);
      }
    };

    const res = await this.runner(args, ctx.signal, onData);
    if (buf) handleLine(buf); // flush a final line without a trailing newline

    if (ctx.signal.aborted) return { status: "aborted", summary: "cancelled", reason: "cancelled" };
    if (res.code !== 0) {
      const summary = (result ?? res.stdout).trim() || "claude cli failed";
      return { status: "failed", summary, error: res.stderr.trim() || `exit ${res.code}` };
    }
    // `result` from the stream is the clean final answer; raw stdout is the fallback for a
    // non-streaming runner (the unit tests, or `--output-format text`).
    const summary = (result ?? res.stdout).trim();
    if (isError) return { status: "failed", summary, error: summary || "claude reported an error" };
    return { status: "completed", summary };
  }
}
