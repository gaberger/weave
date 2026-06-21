import { test } from "node:test";
import assert from "node:assert/strict";

import type { ToolHost } from "../ports/tool-host.js";
import type { Worker, TaskAssignment, WorkerContext } from "../ports/worker.js";
import { makeAgentSkill, parseSkillDef, restrictTools, deriveMatchKeywords, parseClaudeSkill } from "./agent-skill.js";

const host = (names: string[]): ToolHost => ({
  available: () => names.map((name) => ({ name, description: name, effect: "read", inputSchema: {} })),
  invoke: async (call) => ({ ok: true, output: call.name }),
});

const ctx = (tools: ToolHost): WorkerContext => ({
  tools,
  lease: { held: async () => true, assertHeld: async () => {}, renew: async () => {} },
  onProgress: () => {},
  signal: new AbortController().signal,
});

test("parseSkillDef parses frontmatter + prompt body", () => {
  const def = parseSkillDef(
    `---\nname: researcher\ndescription: Research papers\nmatch: research, arxiv\ntools: http_fetch, notify\n---\nYou are a research agent. Do the thing.`,
  );
  assert.equal(def?.name, "researcher");
  assert.deepEqual(def?.tools, ["http_fetch", "notify"]);
  assert.deepEqual(def?.match, ["research", "arxiv"]);
  assert.match(def?.prompt ?? "", /research agent/);
});

test("parseSkillDef returns null without name or prompt", () => {
  assert.equal(parseSkillDef("no frontmatter here"), null);
  assert.equal(parseSkillDef(`---\ndescription: x\n---\nbody`), null); // no name
});

test("restrictTools exposes only the allowlist; denies the rest", async () => {
  const r = restrictTools(host(["http_fetch", "notify", "spawn_task"]), ["http_fetch"]);
  assert.deepEqual(r.available().map((d) => d.name), ["http_fetch"]);
  assert.equal((await r.invoke({ name: "http_fetch", args: {} })).ok, true);
  await assert.rejects(() => r.invoke({ name: "notify", args: {} }));
});

test("deriveMatchKeywords harvests quoted trigger phrases (straight + curly quotes)", () => {
  const desc = `Manage change-sets. Use when the user asks "create a change-set", "commit the draft" or “show history”. Not for path tracing.`;
  assert.deepEqual(deriveMatchKeywords(desc), ["create a change-set", "commit the draft", "show history"]);
  assert.deepEqual(deriveMatchKeywords("no quotes at all"), []); // graceful: explicit-only
});

test("parseClaudeSkill maps SKILL.md → AgentSkillDef with derived match, no allowlist", () => {
  const def = parseClaudeSkill(
    `---\nname: forward-changeset\ndescription: Manage change-sets. Use when the user asks "create a change-set".\nallowed-tools: Bash(python3 *), Read\n---\n# Forward Change-Set\nDo the change-set work.`,
  );
  assert.equal(def?.name, "forward-changeset");
  assert.deepEqual(def?.match, ["create a change-set"]);
  assert.equal(def?.tools, undefined, "Claude allowed-tools is NOT applied as a weave allowlist");
  assert.match(def?.prompt ?? "", /Change-Set/);
});

test("parseClaudeSkill returns null without name or body", () => {
  assert.equal(parseClaudeSkill(`---\ndescription: x\n---\nbody`), null); // no name
  assert.equal(parseClaudeSkill(`---\nname: x\n---\n`), null); // empty body
});

test("makeAgentSkill routes by keyword and runs the worker with restricted tools", async () => {
  let sawTools: string[] = [];
  const worker: Worker = {
    async run(_a, c) {
      sawTools = c.tools.available().map((d) => d.name);
      return { status: "completed", summary: "ok" };
    },
  };
  const skill = makeAgentSkill(
    { name: "researcher", description: "x", prompt: "p", tools: ["http_fetch"], match: ["research"] },
    worker,
  );
  assert.equal(skill.match({ taskId: "t", spec: { goal: "research LLMs" } }), true);
  assert.equal(skill.match({ taskId: "t", spec: { goal: "unrelated" } }), false);

  const task: TaskAssignment = { taskId: "t", spec: { goal: "research LLMs" } };
  const res = await skill.run(task, ctx(host(["http_fetch", "notify"])));
  assert.equal(res.status, "completed");
  assert.deepEqual(sawTools, ["http_fetch"], "agent saw only its granted tools");
});
