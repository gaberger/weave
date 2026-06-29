import type { ToolDefinition, ToolResult } from "../../ports/tool-host.js";
import type { Substrate } from "../../ports/substrate.js";
import type { Timer } from "../../ports/timer.js";
import type { SealedEvent } from "../../domain/event.js";
import { TaskKind } from "../../domain/task.js";

const DEFAULT_FANOUT_TIMEOUT_MS = 420_000; // 7 min — child web-research tasks run many fetches each

/** weave's MCP bridge types every tool field as `z.unknown()` (claude-sdk.ts), so smaller models
 *  routinely send arrays/objects/numbers as JSON STRINGS (e.g. goals: "[\"a\",\"b\"]"). Coerce at
 *  the tool boundary instead of rejecting — the alternative is a "non-empty goals" error and a
 *  silent fallback to inline work (observed with the Haiku tier). */
function asGoals(raw: unknown): string[] {
  const clean = (xs: unknown[]) => xs.map(String).map((s) => s.trim()).filter(Boolean);
  if (Array.isArray(raw)) return clean(raw);
  if (typeof raw === "string") {
    const s = raw.trim();
    if (s.startsWith("[")) {
      try {
        const a = JSON.parse(s);
        if (Array.isArray(a)) return clean(a);
      } catch { /* not JSON — fall through to line/single handling */ }
    }
    if (s.includes("\n")) return s.split("\n").map((x) => x.trim()).filter(Boolean);
    return s ? [s] : [];
  }
  return [];
}

function asPositiveNumber(raw: unknown, dflt: number): number {
  if (typeof raw === "number" && raw > 0) return raw;
  if (typeof raw === "string") {
    const n = Number(raw.trim());
    if (Number.isFinite(n) && n > 0) return n;
  }
  return dflt;
}

function asObject(raw: unknown): Record<string, unknown> | undefined {
  if (raw && typeof raw === "object" && !Array.isArray(raw)) return raw as Record<string, unknown>;
  if (typeof raw === "string" && raw.trim().startsWith("{")) {
    try {
      const o = JSON.parse(raw);
      if (o && typeof o === "object" && !Array.isArray(o)) return o as Record<string, unknown>;
    } catch { /* not JSON */ }
  }
  return undefined;
}

interface ChildResult {
  readonly subject: string;
  readonly goal: string;
  readonly status: "completed" | "failed" | "pending";
  readonly summary: string;
}

/**
 * `fanout` (ADR-0024 §2): the fan-out + **join** counterpart to `spawn_task`'s fire-and-forget
 * handoff (ADR-0008 §3). Declares one child task per goal on the weave, then **blocks until every
 * child settles** (or the deadline elapses), returning each child's result so the *caller* can
 * synthesize. This is weave's substrate-native answer to a Claude Code background `Workflow`
 * (ADR-0024 Context): children are first-class weave tasks — claimable by any peer, observable in
 * `weave status`, lineage-tracked (`parent`/`causedBy`), and watchdog-fed — none of which a
 * detached backend workflow is.
 *
 * Effect `reversible`: it only declares work (no external effect), exactly like `spawn_task`.
 *
 * Liveness:
 *  - The calling worker holds an outstanding `fanout` tool_use for the whole wait, so the worker's
 *    in-flight keepalive (ADR-0005 / commit `fix(worker): in-flight keepalive`) keeps the stall
 *    watchdog satisfied — the parent never looks hung while children run.
 *  - Children run on *other* concurrency slots, so a useful fan-out needs the peer (or pool) to
 *    have capacity beyond the blocked parent: `weave up --concurrency >= 2`, or `weave pool`. With
 *    a single slot the children can't be claimed while the parent waits; the call then returns the
 *    unfinished subjects under `pending` at the deadline rather than hanging forever.
 */
export function fanoutTool(weave: Substrate, newId: () => string, timer: Timer): ToolDefinition {
  return {
    name: "fanout",
    description:
      "Fan out N subtasks on the weave and WAIT for all to settle, returning each result so you can synthesize a final answer. " +
      "Args: { goals: string[] (one subtask per goal), skill?: string, inputs?: object, subjectPrefix?: string, timeoutMs?: number }. " +
      "Returns { complete: boolean, results: [{ subject, goal, status, summary }], pending?: string[] }. " +
      "Use for parallel research/gather, then synthesize the results yourself. Needs peer concurrency >= 2 (or `weave pool`) so children can run while you wait.",
    effect: "reversible",
    inputSchema: {
      goals: "string[]",
      skill: "string?",
      inputs: "object?",
      subjectPrefix: "string?",
      timeoutMs: "number?",
    },
    execute: async (args, ctx): Promise<ToolResult> => {
      const goals = asGoals(args["goals"]);
      if (goals.length === 0) return { ok: false, output: { error: "fanout: `goals` must be a non-empty string[] (also accepts a JSON-array string or newline-separated string)" } };

      const parent = ctx?.taskId;
      const prefix = String(args["subjectPrefix"] ?? parent ?? newId());
      const timeoutMs = asPositiveNumber(args["timeoutMs"], DEFAULT_FANOUT_TIMEOUT_MS);
      const skill = typeof args["skill"] === "string" && args["skill"].trim() ? (args["skill"] as string) : undefined;
      const inputs = asObject(args["inputs"]);

      // Stable subjects so weave's isSettled dedup processes each child once (ADR-0008 §3).
      const children = goals.map((goal, i) => ({ subject: `${prefix}:${i}`, goal }));
      const pending = new Set(children.map((c) => c.subject));
      const results = new Map<string, { status: "completed" | "failed"; summary: string }>();

      // Subscribe BEFORE declaring so a fast child can't settle in the gap. `head()+1` is past every
      // existing event, and subscribe() replays-then-streams, so we observe exactly our children's
      // terminal events and nothing historical.
      const from = (await weave.head()) + 1;

      let cancelTimer: (() => void) | undefined;
      let sub: { unsubscribe(): void } | undefined;
      await new Promise<void>((resolve) => {
        let settled = false;
        const finish = () => {
          if (settled) return;
          settled = true;
          sub?.unsubscribe();
          cancelTimer?.();
          resolve();
        };
        sub = weave.subscribe(from, (e: SealedEvent) => {
          if (!pending.has(e.subject)) return;
          if (e.kind === TaskKind.Completed || e.kind === TaskKind.Failed) {
            const p = e.payload as { summary?: string; error?: string };
            results.set(e.subject, {
              status: e.kind === TaskKind.Completed ? "completed" : "failed",
              summary: (p.summary ?? p.error ?? "").trim(),
            });
            pending.delete(e.subject);
            if (pending.size === 0) finish();
          }
        });
        // One-shot deadline built from the `every` primitive (cancelled on first fire via finish()).
        cancelTimer = timer.every(timeoutMs, finish);

        // Declare children now that we're listening. Fire-and-forget the appends; their declared
        // events (and later terminal events) flow back through the subscription above.
        void (async () => {
          for (const c of children) {
            const spec: { goal: string; skill?: string; inputs?: Record<string, unknown> } = { goal: c.goal };
            if (skill) spec.skill = skill;
            if (inputs) spec.inputs = inputs;
            await weave.append({
              id: newId(),
              kind: TaskKind.Declared,
              actor: "fanout",
              subject: c.subject,
              payload: parent ? { spec, parent } : { spec },
              ...(parent ? { causedBy: parent } : {}),
            });
          }
        })();
      });

      const out: ChildResult[] = children.map((c) => {
        const r = results.get(c.subject);
        return { subject: c.subject, goal: c.goal, status: r?.status ?? "pending", summary: r?.summary ?? "" };
      });
      const complete = pending.size === 0;
      return { ok: true, output: complete ? { complete, results: out } : { complete, results: out, pending: [...pending] } };
    },
  };
}
