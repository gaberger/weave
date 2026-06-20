import type { ToolDefinition } from "../../ports/tool-host.js";
import type { Substrate } from "../../ports/substrate.js";
import { TaskKind } from "../../domain/task.js";

/** `spawn_task` (ADR-0008 §3, handoff-as-tool-call): declare a follow-up task on the weave.
 *  Substrate-bound at composition. Effect `reversible` — it only enqueues work (no external
 *  effect), so it's gated like any tool but not lease-blocked. Using a stable `subject` lets
 *  weave's isSettled dedup process each item once. */
export function spawnTaskTool(weave: Substrate, newId: () => string): ToolDefinition {
  return {
    name: "spawn_task",
    description: "Declare a follow-up task on the weave: { subject, skill?, goal, inputs? }.",
    effect: "reversible",
    inputSchema: { subject: "string", skill: "string?", goal: "string", inputs: "object?" },
    execute: async (args) => {
      const subject = String(args["subject"] ?? newId());
      const goal = String(args["goal"] ?? "");
      const spec: { goal: string; skill?: string; inputs?: Record<string, unknown> } = { goal };
      if (typeof args["skill"] === "string") spec.skill = args["skill"];
      if (args["inputs"] && typeof args["inputs"] === "object") {
        spec.inputs = args["inputs"] as Record<string, unknown>;
      }
      await weave.append({ id: newId(), kind: TaskKind.Declared, actor: "spawn", subject, payload: { spec } });
      return { ok: true, output: { declared: subject } };
    },
  };
}
