import { readdirSync, readFileSync } from "node:fs";
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

/** Load declarative agent skills (*.md / *.json) from a dir, each wired to a Claude worker
 *  whose system prompt is the def's prompt. Missing dir → none. Needs an API key at run. */
export async function loadAgentSkills(dir: string, model?: string): Promise<Skill[]> {
  let files: string[];
  try {
    files = readdirSync(dir);
  } catch {
    return [];
  }
  const { createClaudeWorkerFactory } = await import("./claude-sdk.js");
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
    const worker = createClaudeWorkerFactory({ ...(model ? { model } : {}), systemPrompt: def.prompt })();
    out.push(makeAgentSkill(def, worker));
  }
  return out;
}
