import type { Skill } from "../ports/skill.js";

/** Offline catch-all: completes immediately, echoing the goal. Lets a peer run with no API
 *  key and no plugins. Generic — no domain logic. */
export const echoSkill: Skill = {
  name: "echo",
  description: "Complete immediately, echoing the goal (offline fallback).",
  match: () => true,
  run: async (t) => ({ status: "completed", summary: `echo: ${t.spec.goal}` }),
};

/** General agent backed by Claude (loads the SDK lazily). Catch-all fallback when a key is
 *  set — handles any task by reasoning over whatever tools are granted. Generic. */
export async function claudeSkill(model?: string): Promise<Skill> {
  const { createClaudeWorkerFactory } = await import("./claude-sdk.js");
  const worker = createClaudeWorkerFactory(model !== undefined ? { model } : {})();
  return {
    name: "claude",
    description: "Handle a general task with a Claude agent over the granted tools.",
    match: () => true,
    run: (t, ctx) => worker.run(t, ctx),
  };
}
