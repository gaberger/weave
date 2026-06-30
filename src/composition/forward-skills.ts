import type { Skill } from "../ports/skill.js";
import type { Worker } from "../ports/worker.js";
import { makeAgentSkill } from "./agent-skill.js";

/**
 * Forward NetOps pack skills (ADR-0012, ADR-0016 Ring 2): the LLM-as-ORCHESTRATOR layer over the
 * typed `forward_*` tools. Each skill declares the tools it may use and a tight prompt; the LLM
 * picks a tool, passes structured args, and narrates the JSON result. The Forward/NQE/datastore
 * knowledge lives entirely in the tools' python — the agent never writes NQE, runs Bash, touches
 * credentials, or guesses a network id (the failure mode that motivated this).
 */

/** Goal keywords that route a turn to the vulnerability skill. Exported so the chat front door can
 *  recognize a vuln/CVE-shaped turn the same way it does research (shared list = no drift). */
export const VULN_MATCH = [
  "cve", "vulnerab", "filtered out", "not impacted", "not-impacted",
  "impacted cve", "coverage axiom", "remediation",
] as const;

const VULN_PROMPT =
  "You answer Forward Networks vulnerability / CVE questions by ORCHESTRATING the forward_* tools. " +
  "You NEVER write NQE, run shell commands, touch credentials, or guess a network id — the tools own all of that.\n" +
  "- Resolve the network FIRST: if the user names a network (not a numeric id), call `forward_networks` and match it. NEVER assume an id (there is no default network).\n" +
  "- 'What are we exposed to / impacted by' → `forward_cve_audit` with disposition=impacted.\n" +
  "- 'Show the CVEs we filtered out and why' / 'verify we reviewed each CVE' / coverage / audit artifact → `forward_cve_audit` (disposition=not-impacted for just the filtered set, or all for the full partition). Narrow large pulls with severity and limit.\n" +
  "- Lead with the partition (evaluated · impacted · potentially-impacted · not-impacted · not-evaluated), then the evidence. Each filtered-out CVE carries a reason and per-OS proof (version, config-dependence, device counts) — surface it.\n" +
  "- Treat NOT_EVALUATED honestly as 'Forward has no detection implemented' — NOT as 'not vulnerable'.\n" +
  "- ABSOLUTE: never invent, synthesize, estimate, or use example/placeholder/synthetic data, and never build a 'framework' in place of real results. If a tool returns an error, report the error verbatim and STOP. Every number must come from a tool's output.";

/** The vulnerability / CVE-audit skill (Slice 1 of the forward-* conversion). Granted only the
 *  forward_* read tools it needs (restrictTools, ADR-0016 §3). */
export function forwardVulnerabilitySkill(make: (systemPrompt?: string) => Worker): Skill {
  return makeAgentSkill(
    {
      name: "forward-vulnerability",
      description:
        "Forward CVE/vulnerability audit: which CVEs impact the network, which were filtered out and " +
        "WHY, and coverage — via the forward_cve_audit tool. Use for \"what CVEs are we exposed to\", " +
        "\"show the CVEs we filtered out and the reason\", \"vulnerability coverage\", \"CVE audit\".",
      prompt: VULN_PROMPT,
      tools: ["forward_networks", "forward_snapshots", "forward_cve_audit"],
      match: [...VULN_MATCH],
    },
    make(VULN_PROMPT),
  );
}
