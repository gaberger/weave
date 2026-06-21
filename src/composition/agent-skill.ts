import { readdirSync, readFileSync, existsSync } from "node:fs";
import { extname, join } from "node:path";

import type { Skill } from "../ports/skill.js";
import type { Worker } from "../ports/worker.js";
import type { ToolHost } from "../ports/tool-host.js";
import { NotPermittedError } from "../ports/tool-host.js";

/**
 * A use-case defined LOOSELY (ADR-0016): a name + a prompt (the business logic) + a tool
 * allowlist. The LLM agent reasons over the granted tools — no hardcoded workflow. This is
 * how a domain use-case (a researcher, a monitor) is expressed *without* harness code.
 */
export interface AgentSkillDef {
  readonly name: string;
  readonly description: string;
  readonly prompt: string; // the loosely-defined use-case / biz logic
  readonly tools?: readonly string[]; // allowlist; omit or ["*"] = all granted tools
  readonly match?: readonly string[]; // goal keywords that route to this skill
}

/** Restrict a ToolHost to a tool allowlist (the per-skill grant). */
export function restrictTools(host: ToolHost, allow: readonly string[]): ToolHost {
  if (allow.includes("*")) return host;
  const set = new Set(allow);
  return {
    available: () => host.available().filter((d) => set.has(d.name)),
    invoke: (call) =>
      set.has(call.name) ? host.invoke(call) : Promise.reject(new NotPermittedError(call.name)),
  };
}

/** Turn a def + an LLM worker (configured with `def.prompt` as its system prompt) into a
 *  Skill. The worker's agentic tool-use loop IS the use-case logic. */
export function makeAgentSkill(def: AgentSkillDef, worker: Worker): Skill {
  const keys = def.match ?? [];
  return {
    name: def.name,
    description: def.description,
    match: (t) => keys.some((k) => t.spec.goal.toLowerCase().includes(k.toLowerCase())),
    run: (t, ctx) => {
      const tools = def.tools ? restrictTools(ctx.tools, def.tools) : ctx.tools;
      return worker.run({ taskId: t.taskId, spec: { goal: t.spec.goal } }, { ...ctx, tools });
    },
  };
}

/** Parse a declarative skill file: `--- frontmatter ---` then the prompt body. */
export function parseSkillDef(text: string): AgentSkillDef | null {
  const m = /^---\s*([\s\S]*?)\s*---\s*([\s\S]*)$/.exec(text.trim());
  if (!m) return null;
  const meta: Record<string, string> = {};
  for (const line of (m[1] ?? "").split("\n")) {
    const i = line.indexOf(":");
    if (i === -1) continue;
    meta[line.slice(0, i).trim()] = line.slice(i + 1).trim();
  }
  const list = (s?: string) =>
    s ? s.split(",").map((x) => x.trim()).filter(Boolean) : undefined;
  const prompt = (m[2] ?? "").trim();
  if (!meta["name"] || !prompt) return null;
  const tools = list(meta["tools"]);
  const match = list(meta["match"]);
  return {
    name: meta["name"],
    description: meta["description"] ?? meta["name"],
    prompt,
    ...(tools ? { tools } : {}),
    ...(match ? { match } : {}),
  };
}

/**
 * Recover routing keywords from a Claude skill's prose `description`. Well-written Claude
 * skills enumerate their trigger phrases in quotes ("create a change-set", "list my X") — the
 * author's own statement of when the skill applies. We harvest those as match keywords. No
 * quoted phrases → [] (the skill becomes explicit-only, reachable via `--skill`). Both straight
 * and curly double-quotes are recognized.
 */
export function deriveMatchKeywords(description: string): string[] {
  const out = new Set<string>();
  for (const m of description.matchAll(/["“]([^"”]{2,80})["”]/g)) {
    const phrase = (m[1] ?? "").trim();
    if (phrase) out.add(phrase);
  }
  return [...out];
}

/** Parse a Claude `SKILL.md`: YAML-ish frontmatter (`name`, `description`, `allowed-tools`)
 *  then a markdown body that becomes the system prompt. `match` is derived from the
 *  description (see {@link deriveMatchKeywords}). Claude's `allowed-tools` names a different
 *  tool universe than weave's host, so it is NOT applied as an allowlist — the skill receives
 *  weave's full granted tool set instead (omitting `tools`). Returns null on a malformed file. */
export function parseClaudeSkill(text: string): AgentSkillDef | null {
  const m = /^---\s*([\s\S]*?)\s*---\s*([\s\S]*)$/.exec(text.trim());
  if (!m) return null;
  const meta: Record<string, string> = {};
  for (const line of (m[1] ?? "").split("\n")) {
    const i = line.indexOf(":");
    if (i === -1) continue;
    meta[line.slice(0, i).trim()] = line.slice(i + 1).trim();
  }
  const prompt = (m[2] ?? "").trim();
  const name = meta["name"];
  if (!name || !prompt) return null;
  const description = meta["description"] ?? name;
  const match = deriveMatchKeywords(description);
  return { name, description, prompt, ...(match.length ? { match } : {}) };
}

/** Load Claude Code skills from a dir laid out as `<dir>/<name>/SKILL.md` (one subdir per
 *  skill). Each becomes an LLM agent skill whose prompt is the SKILL.md body. Missing dir →
 *  none. `make` builds the backing Worker (Claude SDK or `claude -p`) from the system prompt. */
export function loadClaudeSkills(dir: string, make: (systemPrompt: string) => Worker): Skill[] {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return [];
  }
  const out: Skill[] = [];
  for (const name of entries) {
    const file = join(dir, name, "SKILL.md");
    if (!existsSync(file)) continue;
    const def = parseClaudeSkill(readFileSync(file, "utf8"));
    if (!def) continue;
    out.push(makeAgentSkill(def, make(def.prompt)));
  }
  return out;
}

/** Load declarative agent skills (*.md / *.json) from a dir. Each def's prompt becomes the
 *  system prompt of an LLM Worker built by `make` — so the backend (Claude SDK or `claude -p`
 *  CLI) is the composition's choice, not baked in here. Missing dir → none. */
export function loadAgentSkills(dir: string, make: (systemPrompt: string) => Worker): Skill[] {
  let files: string[];
  try {
    files = readdirSync(dir);
  } catch {
    return [];
  }
  const out: Skill[] = [];
  for (const f of files) {
    const ext = extname(f);
    if (ext !== ".md" && ext !== ".json") continue;
    const text = readFileSync(join(dir, f), "utf8");
    let def: AgentSkillDef | null = null;
    if (ext === ".json") {
      try {
        def = JSON.parse(text) as AgentSkillDef;
      } catch {
        def = null;
      }
    } else {
      def = parseSkillDef(text);
    }
    if (!def || !def.name || !def.prompt) continue;
    out.push(makeAgentSkill(def, make(def.prompt)));
  }
  return out;
}
