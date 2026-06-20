import type { Skill } from "../../ports/skill.js";
import type { ReducedContext } from "../../domain/context.js";
import { httpProbeTool } from "./http-probe-tool.js";
import { ProbeWorker } from "./probe-worker.js";

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
