import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import type { LeaseGuard } from "../ports/lease.js";
import type { WorkerContext } from "../ports/worker.js";
import { FakeClock } from "../domain/clock.js";
import { InProcessSubstrate } from "../adapters/secondary/in-process-substrate.js";
import { ToolRegistry } from "../adapters/secondary/in-memory-tool-host.js";
import { httpFetchTool } from "../adapters/secondary/http-fetch-tool.js";
import { spawnTaskTool } from "../adapters/secondary/spawn-task-tool.js";
import { notifyTool } from "./notify-tool.js";
import { parseSkillDef, loadAgentSkills } from "./agent-skill.js";

const PLUGINS = "examples/plugins";

test("every example .md plugin parses into a valid agent-skill def", () => {
  const mdFiles = readdirSync(PLUGINS).filter((f) => f.endsWith(".md"));
  assert.ok(mdFiles.length >= 2, "expected example declarative plugins");
  for (const f of mdFiles) {
    const def = parseSkillDef(readFileSync(join(PLUGINS, f), "utf8"));
    assert.ok(def, `${f} should parse`);
    assert.ok(def.name && def.prompt, `${f} needs name + prompt`);
    assert.ok((def.tools?.length ?? 0) > 0, `${f} should declare tools`);
  }
});

test("loadAgentSkills wires the example plugins (researcher + monitor)", async () => {
  const skills = await loadAgentSkills(PLUGINS);
  const names = skills.map((s) => s.name).sort();
  assert.deepEqual(names, ["monitor", "researcher"]);
  const researcher = skills.find((s) => s.name === "researcher");
  assert.equal(researcher?.match({ taskId: "t", spec: { goal: "research LLMs" } }), true);
  assert.equal(researcher?.match({ taskId: "t", spec: { goal: "unrelated" } }), false);
});

// Real end-to-end: the declarative researcher actually researching via Claude + arXiv.
// Skipped unless ANTHROPIC_API_KEY is set.
const heldLease: LeaseGuard = { held: async () => true, assertHeld: async () => {}, renew: async () => {} };

test(
  "LIVE: the researcher plugin researches arXiv via Claude",
  { skip: process.env["ANTHROPIC_API_KEY"] ? false : "set ANTHROPIC_API_KEY to run", timeout: 120_000 },
  async () => {
    const weave = new InProcessSubstrate(new FakeClock(0));
    const registry = new ToolRegistry()
      .register(httpFetchTool)
      .register(spawnTaskTool(weave, () => `id-${Math.random()}`))
      .register(notifyTool([]));
    const researcher = (await loadAgentSkills(PLUGINS)).find((s) => s.name === "researcher");
    assert.ok(researcher);

    const ctx: WorkerContext = {
      tools: registry.hostFor({ tools: "*", maxEffect: "irreversible" }),
      lease: heldLease,
      onProgress: () => {},
      signal: new AbortController().signal,
    };
    const res = await researcher.run(
      { taskId: "live", spec: { goal: "research recent large language model papers" } },
      ctx,
    );
    assert.equal(res.status, "completed");
  },
);
