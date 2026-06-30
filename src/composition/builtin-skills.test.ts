import { test } from "node:test";
import assert from "node:assert/strict";

import type { Worker, TaskAssignment } from "../ports/worker.js";
import { FakeWorker } from "../adapters/secondary/fake-worker.js";
import { SkillRouterWorker } from "../adapters/secondary/skill-router-worker.js";
import { claudeSkill, researchSkill, RESEARCH_PROMPT, RESEARCH_MATCH } from "./builtin-skills.js";

const make = (): Worker => new FakeWorker({ result: { status: "completed", summary: "ok" } });
const task = (goal: string): TaskAssignment => ({ taskId: "t", spec: { goal } });

test("researchSkill builds with research routing keywords and the fanout tool allowlist", () => {
  const skill = researchSkill(make);
  assert.equal(skill.name, "research");
  // Routes on research-shaped goals…
  assert.ok(skill.match(task("research how ECMP works")));
  assert.ok(skill.match(task("please investigate BGP flowspec")));
  assert.ok(skill.match(task("do a deep dive on MPLS")));
  // …and on report/knowledge-recall phrasings, so a question about an existing report lands on the
  // agent that can find it in the index (the bug that motivated this: "how do I see the BMP report").
  assert.ok(skill.match(task("how do I see the BMP report")));
  assert.ok(skill.match(task("what reports do we have on MPLS")));
  assert.ok(skill.match(task("what do we know about add-path")));
  // …but not on unrelated work.
  assert.ok(!skill.match(task("deploy the app to staging")));
  assert.ok(!skill.match(task("summarize this file")));
});

test("RESEARCH_MATCH lists the keywords the chat front door uses to yield the conversational pin", () => {
  // The chat loop and the research skill MUST share one keyword list (no drift), so a turn the chat
  // routes to `research` is one the skill actually matches.
  const skill = researchSkill(make);
  for (const k of RESEARCH_MATCH) assert.ok(skill.match(task(`please ${k} this`)), `skill should match "${k}"`);
});

test("the research prompt recalls the index first, then fans out, and forbids the deferred-report promise", () => {
  // Recall-first: accumulated knowledge is consulted before any fresh research.
  assert.match(RESEARCH_PROMPT, /recall/i);
  assert.match(RESEARCH_PROMPT, /cite/i);
  assert.match(RESEARCH_PROMPT, /fanout/);
  assert.match(RESEARCH_PROMPT, /synthesize/i);
  // Guards the exact false-promise failure that motivated ADR-0024.
  assert.match(RESEARCH_PROMPT, /never say a report is 'running' or 'coming/);
});

test("routing: a research/report goal selects `research` BEFORE the claude catch-all", () => {
  // Same order the cli assembles them: specific skills precede the catch-all fallback.
  const router = new SkillRouterWorker([researchSkill(make), claudeSkill(make)]);
  assert.equal(router.select(task("research add-path vs route reflectors"))?.name, "research");
  assert.equal(router.select(task("how do I see the BMP report"))?.name, "research");
  // A non-research goal falls through to the catch-all.
  assert.equal(router.select(task("write a haiku about routers"))?.name, "claude");
});
