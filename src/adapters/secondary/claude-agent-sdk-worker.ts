import type { Worker, TaskAssignment, WorkerContext, WorkerResult } from "../../ports/worker.js";
import type { ToolHost } from "../../ports/tool-host.js";
import type { Effect } from "../../domain/effect.js";

/**
 * Minimal seam over `@anthropic-ai/claude-agent-sdk` — only what this worker uses, defined
 * locally so the worker (and its tests) compile/run without the SDK installed or an API
 * key. The real SDK is adapted to these shapes in `claude-sdk.ts`. Shapes match the SDK's
 * public API (query → async generator of messages; canUseTool gate; in-process MCP tools).
 */
export type PermissionResult =
  | { behavior: "allow"; updatedInput?: Record<string, unknown> }
  | { behavior: "deny"; message: string; interrupt?: boolean };

export type CanUseTool = (
  toolName: string,
  input: Record<string, unknown>,
  opts: { signal: AbortSignal; toolUseID: string },
) => Promise<PermissionResult>;

export interface SdkContentBlock {
  type: string;
  text?: string;
}
export interface SdkMessage {
  type: string;
  message?: { content?: SdkContentBlock[] };
  subtype?: string;
}
export interface ClaudeRunOptions {
  model?: string;
  systemPrompt?: string;
  maxTurns?: number;
  allowedTools?: string[];
  disallowedTools?: string[];
  mcpServers?: Record<string, unknown>;
  canUseTool?: CanUseTool;
  abortController?: AbortController;
  pathToClaudeCodeExecutable?: string; // override the CLI the SDK drives (set by the composition layer)
}

/** The SDK's built-in tools — disabled so the agent uses weave's gated MCP tools (e.g. the
 *  forward scripts run through weave's `bash`, not the SDK's unsandboxed built-in Bash). */
const SDK_BUILTIN_TOOLS = [
  "Bash", "BashOutput", "KillBash", "KillShell", "Read", "Write", "Edit", "MultiEdit",
  "NotebookEdit", "Glob", "Grep", "LS", "WebFetch", "WebSearch", "Task", "TodoWrite", "ExitPlanMode",
];
export type ClaudeQuery = (params: {
  prompt: string;
  options: ClaudeRunOptions;
}) => AsyncIterable<SdkMessage>;

/** Bridges a per-task ToolHost into the SDK's `mcpServers` config so the agent's tool
 *  calls execute through weave (ADR-0003 §6: weave owns execution, not the backend). */
export interface ToolBridge {
  build(tools: ToolHost): Record<string, unknown>;
}

export interface ClaudeWorkerConfig {
  readonly model?: string;
  readonly systemPrompt?: string;
  readonly maxTurns?: number;
}

export interface ClaudeWorkerDeps {
  readonly query: ClaudeQuery;
  readonly bridge: ToolBridge;
}

const DEFAULT_MODEL = "claude-sonnet-4-6";
const DEFAULT_SYSTEM_PROMPT =
  "You are a weave worker executing one assigned task. Use the provided tools to accomplish the goal, then stop. Be concise.";

/**
 * The canonical Worker backed by the Claude Agent SDK (ADR-0003). The ADR-0002 lease
 * constraint is enforced here, not in task code: `canUseTool` gates every `irreversible`
 * tool behind `lease.held()` (the peer loop heartbeats the lease in parallel). Backends
 * are interchangeable — this is one adapter behind the `Worker` port.
 */
export class ClaudeAgentSdkWorker implements Worker {
  constructor(
    private readonly deps: ClaudeWorkerDeps,
    private readonly cfg: ClaudeWorkerConfig = {},
  ) {}

  async run(assignment: TaskAssignment, ctx: WorkerContext): Promise<WorkerResult> {
    const effectByName = new Map<string, Effect>();
    for (const t of ctx.tools.available()) effectByName.set(t.name, t.effect);

    let leaseLost = false;

    // The lease gate (ADR-0003 §2). Unknown tools default to irreversible (fail closed).
    const canUseTool: CanUseTool = async (toolName, input?: unknown) => {
      if (process.env["WEAVE_TOOL_DEBUG"]) process.stderr.write(`[canUseTool] ${toolName} input=${JSON.stringify(input)}\n`);
      // The SDK names in-process MCP tools `mcp__<server>__<tool>`; our effect map is keyed by the
      // bare tool name, so strip the prefix or the lookup misses and EVERY tool (incl. read-only
      // ones like the forward scripts' bash) fails closed to irreversible and gets lease-gated.
      const base = toolName.startsWith("mcp__") ? (toolName.split("__").pop() ?? toolName) : toolName;
      const effect: Effect = effectByName.get(base) ?? effectByName.get(toolName) ?? "irreversible";
      if (process.env["WEAVE_TOOL_DEBUG"]) process.stderr.write(`[canUseTool] ${toolName} base=${base} effect=${effect}\n`);
      // Only irreversible effects need a held lease. Fail CLOSED: if the lease can't be confirmed,
      // deny (read-only tools are exempt via the corrected effect lookup above, so this no longer
      // blocks them — it only gates genuinely irreversible effects).
      if (effect === "irreversible") {
        let held = false;
        try { held = await ctx.lease.held(); } catch (e) { held = false; if (process.env["WEAVE_TOOL_DEBUG"]) process.stderr.write(`[canUseTool] lease.held threw: ${e instanceof Error ? e.message : String(e)}\n`); }
        if (process.env["WEAVE_TOOL_DEBUG"]) process.stderr.write(`[canUseTool] ${toolName} held=${held}\n`);
        if (!held) {
          leaseLost = true;
          return { behavior: "deny", message: "weave: lease lost; aborting before irreversible effect", interrupt: true };
        }
      }
      // MUST echo the input back via updatedInput — a bare {behavior:"allow"} drops the tool's
      // arguments, so the handler runs with no input (or not at all).
      return { behavior: "allow", updatedInput: (input ?? {}) as Record<string, unknown> };
    };

    // Link weave's cooperative cancellation to the SDK's AbortController.
    const controller = new AbortController();
    if (ctx.signal.aborted) controller.abort();
    else ctx.signal.addEventListener("abort", () => controller.abort(), { once: true });

    const options: ClaudeRunOptions = {
      model: assignment.spec.model ?? this.cfg.model ?? DEFAULT_MODEL, // per-task tiering (ADR-0022)
      systemPrompt: this.cfg.systemPrompt ?? DEFAULT_SYSTEM_PROMPT,
      allowedTools: [], // force canUseTool to gate every tool
      disallowedTools: SDK_BUILTIN_TOOLS, // only weave's MCP tools — never the SDK's built-in Bash etc.
      mcpServers: this.deps.bridge.build(ctx.tools),
      canUseTool,
      abortController: controller,
    };
    if (this.cfg.maxTurns !== undefined) options.maxTurns = this.cfg.maxTurns;

    const prompt = this.buildPrompt(assignment);
    const textParts: string[] = [];
    let resultSubtype: string | undefined;

    try {
      for await (const msg of this.deps.query({ prompt, options })) {
        if (msg.type === "assistant") {
          for (const block of msg.message?.content ?? []) {
            if (block.type === "text" && block.text) {
              textParts.push(block.text);
              ctx.onProgress(block.text);
            }
          }
        } else if (msg.type === "result") {
          resultSubtype = msg.subtype;
        }
        if (ctx.signal.aborted) break;
      }
    } catch (err) {
      return this.terminal(leaseLost, ctx, textParts, undefined, err);
    }

    return this.terminal(leaseLost, ctx, textParts, resultSubtype, undefined);
  }

  private terminal(
    leaseLost: boolean,
    ctx: WorkerContext,
    textParts: string[],
    resultSubtype: string | undefined,
    err: unknown,
  ): WorkerResult {
    if (leaseLost) return { status: "aborted", summary: "lease lost mid-task", reason: "lease-lost" };
    if (ctx.signal.aborted) return { status: "aborted", summary: "cancelled", reason: "cancelled" };
    const summary = textParts.join("\n").trim();
    if (err !== undefined) {
      return {
        status: "failed",
        summary: summary || "claude worker errored",
        error: err instanceof Error ? err.message : String(err),
      };
    }
    if (resultSubtype === "success") {
      return { status: "completed", summary: summary || "completed" };
    }
    if (resultSubtype && resultSubtype.startsWith("error")) {
      return { status: "failed", summary: summary || resultSubtype, error: resultSubtype };
    }
    return { status: "failed", summary: summary || "no result from claude", error: "no_result" };
  }

  private buildPrompt(a: TaskAssignment): string {
    const inputs = a.spec.inputs ? `\n\nInputs:\n${JSON.stringify(a.spec.inputs, null, 2)}` : "";
    return `Task ${a.taskId}: ${a.spec.goal}${inputs}`;
  }
}
