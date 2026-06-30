import { test } from "node:test";
import assert from "node:assert/strict";

import type { Worker, TaskAssignment } from "../ports/worker.js";
import { FakeWorker } from "../adapters/secondary/fake-worker.js";
import { SkillRouterWorker } from "../adapters/secondary/skill-router-worker.js";
import { claudeSkill } from "./builtin-skills.js";
import { forwardSkills, forwardVulnerabilitySkill, VULN_MATCH } from "./forward-skills.js";

const make = (): Worker => new FakeWorker({ result: { status: "completed", summary: "ok" } });
const task = (goal: string): TaskAssignment => ({ taskId: "t", spec: { goal } });

test("forwardSkills returns the expected code skills, each granted only forward_* tools", () => {
  const skills = forwardSkills(make);
  assert.deepEqual(
    skills.map((s) => s.name),
    ["forward-vulnerability", "forward-nqe-query", "forward-path-analysis", "forward-device-config", "forward-inventory"],
  );
  for (const s of skills) assert.equal(typeof s.run, "function");
});

test("forward-vulnerability routes on CVE/vuln goals incl. the 'filtered out' audit ask", () => {
  const s = forwardVulnerabilitySkill(make);
  assert.ok(s.match(task("which CVEs are we exposed to")));
  assert.ok(s.match(task("show the CVEs we filtered out and why")));
  assert.ok(!s.match(task("trace the path from A to B")));
});

test("VULN_MATCH is the shared keyword list the skill matches on (no drift)", () => {
  const s = forwardVulnerabilitySkill(make);
  for (const k of VULN_MATCH) assert.ok(s.match(task(`please ${k} this`)), `should match "${k}"`);
});

test("routing: each domain goal selects its specialized skill before the catch-all", () => {
  // Order mirrors cli assembly: forward skills precede the persona/claude catch-all fallback.
  const router = new SkillRouterWorker([...forwardSkills(make), claudeSkill(make)]);
  const sel = (g: string) => router.select(task(g))?.name;
  assert.equal(sel("show the CVEs we filtered out and why"), "forward-vulnerability");
  assert.equal(sel("how many interfaces are down"), "forward-nqe-query");
  assert.equal(sel("why is traffic to 10.0.0.1 dropping"), "forward-path-analysis");
  assert.equal(sel("show me the config for core-rtr-1"), "forward-device-config");
  assert.equal(sel("list devices in DemoFoundry"), "forward-inventory");
  // General conversational turns match no specialized skill → the catch-all backstops them.
  assert.equal(sel("thanks, that's helpful"), "claude");
  assert.equal(sel("what do you think we should do next"), "claude");
});
