import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { Skill } from "../../ports/skill.js";
import type { ToolHost } from "../../ports/tool-host.js";
import type { WorkerContext, TaskAssignment } from "../../ports/worker.js";
import { SkillRouterWorker } from "./skill-router-worker.js";
import { loadSkills } from "./skill-loader.js";

const noTools: ToolHost = { available: () => [], invoke: async () => ({ ok: true, output: null }) };
const ctx = (): WorkerContext => ({
  tools: noTools,
  lease: { held: async () => true, assertHeld: async () => {}, renew: async () => {} },
  onProgress: () => {},
  signal: new AbortController().signal,
});
const task = (goal: string, skill?: string): TaskAssignment => ({
  taskId: "t",
  spec: skill !== undefined ? { goal, skill } : { goal },
});
const mkSkill = (name: string, matches: boolean): Skill => ({
  name,
  description: name,
  match: () => matches,
  run: async () => ({ status: "completed", summary: name }),
});

test("router: explicit --skill wins over predicates", async () => {
  const r = new SkillRouterWorker([mkSkill("a", true), mkSkill("b", true)]);
  assert.equal((await r.run(task("x", "b"), ctx())).summary, "b");
});

test("router: predicate match, first in order", async () => {
  const r = new SkillRouterWorker([mkSkill("no", false), mkSkill("yes", true)]);
  assert.equal((await r.run(task("x"), ctx())).summary, "yes");
});

test("router: no match -> failed no_skill", async () => {
  const res = await new SkillRouterWorker([mkSkill("no", false)]).run(task("x"), ctx());
  assert.equal(res.status, "failed");
  assert.equal(res.status === "failed" ? res.error : null, "no_skill");
});

test("router: unknown explicit skill -> failed", async () => {
  const res = await new SkillRouterWorker([mkSkill("a", true)]).run(task("x", "zzz"), ctx());
  assert.equal(res.status, "failed");
});

test("router: soft pin falls back to predicate routing when the name is absent", async () => {
  // A thin chat client pins its own catch-all name ("claude"); the daemon runs a different persona
  // whose catch-all is "netops". Soft pin => route by predicate to "netops" instead of failing.
  const r = new SkillRouterWorker([mkSkill("netops", true)]);
  const t: TaskAssignment = { taskId: "t", spec: { goal: "x", skill: "claude", softSkill: true } };
  assert.equal((await r.run(t, ctx())).summary, "netops");
});

test("router: soft pin still prefers an exact name match when present", async () => {
  const r = new SkillRouterWorker([mkSkill("claude", true), mkSkill("netops", true)]);
  const t: TaskAssignment = { taskId: "t", spec: { goal: "x", skill: "claude", softSkill: true } };
  assert.equal((await r.run(t, ctx())).summary, "claude");
});

test("router: soft pin with no matching skill -> failed no_skill", async () => {
  const r = new SkillRouterWorker([mkSkill("netops", false)]);
  const t: TaskAssignment = { taskId: "t", spec: { goal: "x", skill: "claude", softSkill: true } };
  const res = await r.run(t, ctx());
  assert.equal(res.status, "failed");
  assert.equal(res.status === "failed" ? res.error : null, "no_skill");
});

test("loadSkills: loads a plugin module from a directory", async () => {
  const dir = mkdtempSync(join(tmpdir(), "weave-skills-"));
  writeFileSync(
    join(dir, "hello.mjs"),
    `export default { name: "hello", description: "hi",
       match: (t) => t.spec.goal.startsWith("hello"),
       async run(t) { return { status: "completed", summary: "hello:" + t.spec.goal }; } };`,
  );
  const { skills, errors } = await loadSkills(dir);
  assert.equal(errors.length, 0);
  assert.equal(skills.length, 1);
  assert.equal(skills[0]?.name, "hello");
  assert.equal((await skills[0]!.run(task("hello world"), ctx())).summary, "hello:hello world");
});

test("loadSkills: missing directory -> empty (not an error)", async () => {
  const { skills, errors } = await loadSkills("/nonexistent/weave/skills");
  assert.equal(skills.length, 0);
  assert.equal(errors.length, 0);
});
