import type { Skill } from "../ports/skill.js";
import type { Worker } from "../ports/worker.js";
import { makeAgentSkill } from "./agent-skill.js";

/**
 * Forward NetOps pack skills (ADR-0012, ADR-0016 Ring 2): the LLM-as-ORCHESTRATOR layer over the
 * typed `forward_*` tools. Each skill declares the tools it may use and a tight prompt; the LLM
 * picks a tool, passes structured args, and narrates the JSON result. The Forward/NQE/datastore
 * knowledge lives in the tools' python — the agent never writes NQE, runs Bash, touches credentials,
 * or guesses a network id. Each code skill OVERRIDES the same-named prose SKILL.md (cli.ts seeds the
 * name into `seen` so the declarative version is skipped).
 */

// Shared preamble — the two failure modes this whole conversion exists to kill.
const GROUND =
  "You are a Forward Networks operator. You ANSWER by calling the forward_* tools — you never write " +
  "NQE, run shell commands, touch credentials, or guess a network id.\n" +
  "- Resolve the network FIRST: if the user names a network (not a numeric id), call `forward_networks` " +
  "and match it. There is NO default network.\n" +
  "- ABSOLUTE: never invent, synthesize, estimate, or use example/placeholder/synthetic data, and never " +
  "build a 'framework' in place of real results. If a tool errors, report the error verbatim and STOP. " +
  "Every fact must come from a tool's output.\n";

/** Keyword lists are exported for tests (and to document each skill's routing surface). Keep them
 *  specific — predicate routing means an over-broad keyword steals general conversational turns. */
export const VULN_MATCH = [
  "cve", "vulnerab", "filtered out", "not impacted", "not-impacted", "impacted cve", "coverage axiom", "remediation",
] as const;
export const NQE_MATCH = [
  "nqe", "run a query", "run query", "query the network", "how many devices", "how many interfaces",
  "which devices", "catalog query", "stig",
] as const;
export const PATH_MATCH = [
  "path from", "trace the path", "can it reach", "reachability", "why is traffic", "is traffic dropping",
  "blackhole", "can a reach b",
] as const;
export const CONFIG_MATCH = [
  "config for", "running config", "show me the config", "which devices have", "grep the config", "config on",
] as const;
export const INVENTORY_MATCH = [
  "list networks", "what networks", "list devices", "how many devices", "list snapshots", "inventory", "what devices",
] as const;

function skill(
  make: (sp?: string) => Worker,
  name: string,
  description: string,
  tools: string[],
  match: readonly string[],
  body: string,
): Skill {
  const prompt = GROUND + body;
  return makeAgentSkill({ name, description, prompt, tools, match: [...match] }, make(prompt));
}

/** The vulnerability / CVE-audit skill (Slice 1). */
export function forwardVulnerabilitySkill(make: (sp?: string) => Worker): Skill {
  return skill(
    make,
    "forward-vulnerability",
    "Forward CVE/vulnerability audit: which CVEs impact the network, which were filtered out and WHY, " +
      "and coverage. Use for \"what CVEs are we exposed to\", \"show the CVEs we filtered out and the reason\", " +
      "\"vulnerability coverage\", \"CVE audit\".",
    ["forward_networks", "forward_snapshots", "forward_cve_audit"],
    VULN_MATCH,
    "- 'What are we exposed to' → `forward_cve_audit` disposition=impacted. 'Show the CVEs we filtered out " +
      "and why' / coverage / audit → `forward_cve_audit` (disposition=not-impacted, or all for the full " +
      "partition); narrow with severity/limit.\n" +
      "- Lead with the partition (evaluated · impacted · potentially-impacted · not-impacted · not-evaluated), " +
      "then the evidence (each filtered-out CVE carries a reason + per-OS proof). Treat NOT_EVALUATED honestly " +
      "as 'no detection implemented', NOT 'safe'.",
  );
}

/** NQE catalog search + run. */
export function forwardNqeSkill(make: (sp?: string) => Worker): Skill {
  return skill(
    make,
    "forward-nqe-query",
    "Run network queries over the parsed model (NQE = SQL over the snapshot): interface/route/ACL/VLAN/BGP " +
      "facts, STIG checks, \"how many X\", \"which devices have Y\". Searches the prebuilt query catalog first.",
    ["forward_networks", "forward_snapshots", "nqe_search", "nqe_get_source", "nqe_run"],
    NQE_MATCH,
    "- PREFER a catalog query: `nqe_search` (by topic) → `nqe_get_source` (confirm its columns) → `nqe_run` " +
      "by queryId. Only pass a raw NQE string to `nqe_run` when no catalog query fits, and keep it simple — " +
      "do NOT guess NQE syntax.\n" +
      "- Always pass a limit unless the user asked for everything. Lead with the verdict, then a compact table.",
  );
}

/** Path / reachability analysis. */
export function forwardPathSkill(make: (sp?: string) => Worker): Skill {
  return skill(
    make,
    "forward-path-analysis",
    "Trace whether/how traffic flows A→B across the modeled network and WHY it drops. Use for \"can A reach " +
      "B\", \"why is traffic to X dropping\", \"what path does this take\".",
    ["forward_networks", "path_search"],
    PATH_MATCH,
    "- Call `path_search` with the src/dst and (if given) protocol/port. Lead with the verdict (reachable / " +
      "dropped and where), then the hop-by-hop path and the drop reason.",
  );
}

/** Device configuration retrieval + search. */
export function forwardDeviceConfigSkill(make: (sp?: string) => Worker): Skill {
  return skill(
    make,
    "forward-device-config",
    "Read a device's running config (or search configs network-wide). Use for \"show me the config for X\", " +
      "\"what's the BGP config on Y\", \"which devices have telnet/ACL Z configured\".",
    ["forward_networks", "forward_snapshots", "config_get", "config_grep"],
    CONFIG_MATCH,
    "- One device → `config_get` (optionally a category/stanza). Network-wide search → `config_grep` with the " +
      "pattern. Lead with the answer; quote the relevant config lines as evidence.",
  );
}

/** Coarse inventory: networks, snapshots, devices. */
export function forwardInventorySkill(make: (sp?: string) => Worker): Skill {
  return skill(
    make,
    "forward-inventory",
    "List Forward resources: networks, snapshots, devices (counts, vendors). Use for \"what networks do we " +
      "have\", \"list devices in X\", \"how many devices\", \"latest snapshot for Y\".",
    ["forward_networks", "forward_snapshots", "forward_devices"],
    INVENTORY_MATCH,
    "- Networks → `forward_networks`. Snapshots → `forward_snapshots`. Devices → `forward_devices` (optional " +
      "vendor filter). Lead with the count/headline, then a compact table; never dump > ~20 rows unprompted.",
  );
}

/** All forward code skills, in routing order (specialized; the persona catch-all backstops). */
export function forwardSkills(make: (sp?: string) => Worker): Skill[] {
  return [
    forwardVulnerabilitySkill(make),
    forwardNqeSkill(make),
    forwardPathSkill(make),
    forwardDeviceConfigSkill(make),
    forwardInventorySkill(make),
  ];
}
