import type { Skill } from "../ports/skill.js";
import type { Worker } from "../ports/worker.js";
import type { ReducedContext } from "../domain/context.js";
import { httpProbeTool } from "../adapters/secondary/http-probe-tool.js";
import { ProbeWorker } from "../adapters/secondary/probe-worker.js";

/** Interrogation skill (ADR-0011): matches tasks with a `target` input, an explicit
 *  `probe` skill, or a goal starting with "probe ". Brings the http_probe tool. */
export const probeSkill: Skill = {
  name: "probe",
  description: "HTTP-probe a target and record reachability/latency.",
  tools: [httpProbeTool],
  match: (t) =>
    typeof (t.spec.inputs as { target?: unknown } | undefined)?.target === "string" ||
    t.spec.goal.startsWith("probe "),
  run: (t, ctx) => new ProbeWorker().run(t, ctx),
};

/** Summarize the network from the REDUCED context (ADR-0013 §3): calls the substrate-bound
 *  `network_state` tool (registered at composition) and formats a health summary. Deterministic
 *  — demonstrates a skill consuming a reduced view, no LLM. */
export const summarySkill: Skill = {
  name: "summary",
  description: "Summarize current network health from the reduced state.",
  match: (t) => t.spec.goal.startsWith("summary") || t.spec.goal.startsWith("network status"),
  run: async (t, ctx) => {
    const res = await ctx.tools.invoke({ name: "network_state", args: {} });
    const r = res.output as ReducedContext;
    const lines = r.targets.map((x) => `  ${x.target} ${x.tag} (${x.status})`).join("\n");
    const summary =
      `network: ${r.totals.healthy}/${r.totals.targets} healthy` +
      `, ${r.totals.unhealthy} unhealthy, ${r.totals.unreachable} unreachable, ${r.totals.violations} violations` +
      (lines ? `\n${lines}` : "");
    return { status: "completed", summary };
  },
};

/** Offline catch-all: completes immediately, echoing the goal. Lets a peer demo skills with
 *  no API key. Use as the fallback when the Claude skill isn't available. */
export const echoSkill: Skill = {
  name: "echo",
  description: "Complete immediately, echoing the goal (offline fallback).",
  match: () => true,
  run: async (t) => ({ status: "completed", summary: `echo: ${t.spec.goal}` }),
};

/** Narrate network health from the REDUCED context via an LLM (ADR-0013 follow-up): pulls
 *  `network_state` and asks the worker to write a report — the model sees the compact snapshot,
 *  never raw events. `makeAnalyzeSkill` takes any Worker (testable); `analyzeSkill` wires Claude. */
export function makeAnalyzeSkill(worker: Worker): Skill {
  return {
    name: "analyze",
    description: "Narrate network health from the reduced state via an LLM.",
    match: (t) => t.spec.goal.startsWith("analyze") || t.spec.goal.startsWith("report"),
    run: async (t, ctx) => {
      const res = await ctx.tools.invoke({ name: "network_state", args: {} });
      const reduced = res.output as ReducedContext;
      const prompt =
        "You are a network operations assistant. Given the current reduced network state " +
        "(one entry per target), write a SHORT health report: overall status first, then call out " +
        "any unreachable/unhealthy/violation targets by name. Do not invent data.\n\nState:\n" +
        JSON.stringify(reduced, null, 2);
      return worker.run({ taskId: t.taskId, spec: { goal: prompt } }, ctx);
    },
  };
}

export async function analyzeSkill(model?: string): Promise<Skill> {
  const { createClaudeWorkerFactory } = await import("./claude-sdk.js");
  return makeAnalyzeSkill(createClaudeWorkerFactory(model !== undefined ? { model } : {})());
}

/** General skill backed by a Claude agent (loads the SDK lazily). Catch-all fallback when
 *  ANTHROPIC_API_KEY is set. */
export async function claudeSkill(model?: string): Promise<Skill> {
  const { createClaudeWorkerFactory } = await import("./claude-sdk.js");
  const worker = createClaudeWorkerFactory(model !== undefined ? { model } : {})();
  return {
    name: "claude",
    description: "Handle a general task with a Claude agent.",
    match: () => true,
    run: (t, ctx) => worker.run(t, ctx),
  };
}
