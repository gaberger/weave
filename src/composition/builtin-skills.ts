import type { Skill } from "../ports/skill.js";
import type { Worker } from "../ports/worker.js";

/** Offline catch-all: completes immediately, echoing the goal. Lets a peer run with no LLM
 *  backend and no plugins. Generic — no domain logic. */
export const echoSkill: Skill = {
  name: "echo",
  description: "Complete immediately, echoing the goal (offline fallback).",
  match: () => true,
  run: async (t) => ({ status: "completed", summary: `echo: ${t.spec.goal}` }),
};

/** General agent fallback — handles any task by reasoning over the granted tools. Backed by
 *  whatever LLM Worker the composition provides (Claude SDK with a key, or `claude -p` CLI). */
export function claudeSkill(make: (systemPrompt?: string) => Worker): Skill {
  const worker = make();
  return {
    name: "claude",
    description: "Handle a general task with a Claude agent over the granted tools.",
    match: () => true,
    run: (t, ctx) => worker.run(t, ctx),
  };
}
