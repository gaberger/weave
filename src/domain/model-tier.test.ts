import { test } from "node:test";
import assert from "node:assert/strict";
import { classifyTier } from "./model-tier.js";

test("frontier keywords route to tier 3", () => {
  assert.equal(classifyTier("design the HA backbone architecture"), 3);
  assert.equal(classifyTier("audit our firewalls for CVE exposure"), 3);
  assert.equal(classifyTier("prove BGP loop freedom across the fabric"), 3);
  assert.equal(classifyTier("migrate the substrate to the networked backend"), 3);
});

test("short / conversational goals route to tier 1", () => {
  assert.equal(classifyTier("hi"), 1);
  assert.equal(classifyTier("thanks!"), 1);
  assert.equal(classifyTier("which devices are down"), 1);
});

test("ordinary multi-word goals route to the safe default tier 2", () => {
  assert.equal(classifyTier("list every interface on the edge routers and its description"), 2);
  assert.equal(classifyTier("summarize the last collection run for the team standup"), 2);
});

test("frontier keywords beat the short-goal shortcut", () => {
  // 3 words, but "security" forces tier 3 over the <=8-word tier-1 rule.
  assert.equal(classifyTier("review security posture"), 3);
});

test("empty goal is the safe default", () => {
  assert.equal(classifyTier("   "), 2);
});
