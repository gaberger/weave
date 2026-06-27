/**
 * Intent classifier (src/domain/intent.ts) — categorizes user utterances for learning analytics and
 * routing. Pure and previously untested. Pins representative matches per category, the "general"
 * fallback, and the first-match-wins ordering for utterances that could touch two categories.
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import { classifyIntent, getIntentPatterns, type Intent } from "./intent.js";

const cases: Array<[string, Intent]> = [
  ["list all devices", "inventory"],
  ["show me the topology map", "inventory"],
  ["is host A reachable from host B", "reachability"],
  ["trace the path to 10.0.0.1", "reachability"],
  // NB: avoid "as-path" (trips reachability's `path`) and "check" (trips compliance's `check`) — the
  // classifier is first-match-wins, exercised explicitly below. Use words unique to each category.
  ["show bgp peers", "bgp"],
  ["run a stig compliance audit", "compliance"],
  ["any CVE vulnerabilities?", "compliance"],
  ["show running config for interface eth0", "config"],
  ["the firewall acl rules", "security"],
  ["how is the weather today", "general"],
  ["", "general"],
];

for (const [utterance, expected] of cases) {
  test(`classifyIntent: "${utterance}" → ${expected}`, () => {
    assert.equal(classifyIntent(utterance), expected);
  });
}

test("first-match-wins: a reachability+bgp word ('neighbor') resolves by pattern order", () => {
  // "neighbor" appears in both reachability and bgp patterns; reachability is checked first.
  assert.equal(classifyIntent("who is the neighbor of this device"), "reachability");
});

test("getIntentPatterns returns the regexes for a category, and [] for the patternless fallback", () => {
  assert.ok(getIntentPatterns("bgp").length > 0, "bgp has patterns");
  assert.deepEqual(getIntentPatterns("general"), [], "general is the no-pattern fallback");
});
