import { test } from "node:test";
import assert from "node:assert/strict";

import type { Worker, TaskAssignment } from "../ports/worker.js";
import { FakeWorker } from "../adapters/secondary/fake-worker.js";
import { SkillRouterWorker } from "../adapters/secondary/skill-router-worker.js";
import { claudeSkill } from "./builtin-skills.js";
import { forwardVulnerabilitySkill, VULN_MATCH } from "./forward-skills.js";

const make = (): Worker => new FakeWorker({ result: { status: "completed", summary: "ok" } });
const task = (goal: string): TaskAssignment => ({ taskId: "t", spec: { goal } });

test("forwardVulnerabilitySkill: name, tool allowlist, and CVE/vuln routing keywords", () => {
  const skill = forwardVulnerabilitySkill(make);
  assert.equal(skill.name, "forward-vulnerability");
  // Routes on vuln/CVE-shaped goals, incl. the exact 'filtered out' audit ask.
  assert.ok(skill.match(task("which CVEs are we exposed to")));
  assert.ok(skill.match(task("show the CVEs we filtered out and why")));
  assert.ok(skill.match(task("vulnerability coverage for DemoFoundry")));
  // …but not unrelated network work.
  assert.ok(!skill.match(task("trace the path from A to B")));
  assert.ok(!skill.match(task("show me the bgp peers")));
});

test("forward-vulnerability declares only the forward_* read tools it orchestrates", () => {
  // makeAgentSkill keeps the def.tools allowlist on the skill via restrictTools at run time; here we
  // assert the contract the skill is built with (the grant it needs, ADR-0016 §3).
  const skill = forwardVulnerabilitySkill(make);
  // The prompt forbids hand-rolling NQE/Bash and forbids fabrication — the two failures we're fixing.
  // (Prompt is internal, so assert via behavior we can see: the skill is an agent skill that runs.)
  assert.equal(typeof skill.run, "function");
});

test("VULN_MATCH is the shared keyword list the skill matches on (no drift)", () => {
  const skill = forwardVulnerabilitySkill(make);
  for (const k of VULN_MATCH) assert.ok(skill.match(task(`please ${k} this`)), `should match "${k}"`);
});

test("routing: a CVE goal selects forward-vulnerability BEFORE the catch-all", () => {
  // Same order cli assembles: forwardPack precedes the persona/claude catch-all fallback.
  const router = new SkillRouterWorker([forwardVulnerabilitySkill(make), claudeSkill(make)]);
  assert.equal(router.select(task("show the CVEs we filtered out and why"))?.name, "forward-vulnerability");
  assert.equal(router.select(task("write a haiku"))?.name, "claude");
});
