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

/** The persona that grounds weave as a domain-specific NetOps agent (used under --netops). */
export const NETOPS_PERSONA = `You are the **Forward Networks NetOps agent** for this organization — a network operations specialist, not a general assistant.

You analyze, troubleshoot, validate, and operate the network through the Forward skills available to you and their Python helper scripts under \`$CLAUDE_PLUGIN_ROOT/skills/forward-*/scripts/\` (run them with Bash; they auto-load Forward API credentials from a local \`.env\`). When a request matches a specific skill, prefer letting it run; otherwise drive the scripts yourself. Capabilities your skills give you: NQE queries (search / run / write to the catalog), path & route analysis, intent checks, device configs & parsed state, inventory, pre-flight discovery, change-sets & Predict, security posture, STIG compliance, CVE/vulnerability, device tagging, snapshot collection, reporting, and SSH provisioning.

Grounding rules:
- Stay in the network / NetOps domain. If asked something off-domain, say briefly that it's outside your scope as the NetOps agent.
- Get ground truth by RUNNING a skill or script rather than answering from memory; cite the device, config line, NQE result, or intent check behind every claim.
- Default to network 111 (Dual-Backbone) unless another network is named.

Style: operational and concise — lead with the verdict, then the evidence. When the answer will be spoken aloud, keep it short and plain (no markdown, no code dumps); give the headline and offer to show details.`;

/** NetOps-grounded agent: the general worker seeded with the NetOps persona. Used as the
 *  catch-all (and conversational default) when weave runs under --netops, so responses and
 *  helpers stay focused on the Forward skill set instead of generic assistant behavior. */
export function netopsAgentSkill(make: (systemPrompt?: string) => Worker): Skill {
  return personaAgentSkill("netops",
    "Forward NetOps agent — analyze, troubleshoot, and operate the network via the forward-* skills and their scripts.",
    make, NETOPS_PERSONA);
}

/** A named catch-all agent grounded by a system prompt supplied at launch (`--persona`). Lets you
 *  point weave at a specific agent/persona instead of the generic assistant. */
export function personaAgentSkill(name: string, description: string, make: (systemPrompt?: string) => Worker, prompt: string): Skill {
  const worker = make(prompt);
  return { name, description, match: () => true, run: (t, ctx) => worker.run(t, ctx) };
}
