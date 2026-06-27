/**
 * Learning analytics usecase (src/usecases/learning.ts) — emits learning.question.asked /
 * learning.question.resolved onto the weave for pattern mining. Previously untested. These pin the
 * event kind, subject, and payload shape so downstream analytics can rely on them.
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import { FakeClock } from "../domain/clock.js";
import type { SealedEvent } from "../domain/event.js";
import { TaskKind } from "../domain/task.js";
import { InProcessSubstrate } from "../adapters/secondary/in-process-substrate.js";
import { declareQuestion, resolveQuestion } from "./learning.js";

const collect = async (weave: InProcessSubstrate): Promise<SealedEvent[]> => {
  const out: SealedEvent[] = [];
  for await (const e of weave.read(0)) out.push(e);
  return out;
};

test("declareQuestion emits learning.question.asked with the full analytics payload", async () => {
  const weave = new InProcessSubstrate(new FakeClock(0));
  let n = 0;
  await declareQuestion(weave, () => `id-${++n}`, "voice", "q-1", "are the spines reachable", "reachability", "net-A", "netops");

  const [e] = await collect(weave);
  assert.equal(e?.kind, TaskKind.QuestionAsked);
  assert.equal(e?.subject, "q-1");
  assert.equal(e?.actor, "voice");
  assert.deepEqual(e?.payload, {
    utterance: "are the spines reachable",
    intent: "reachability",
    networkId: "net-A",
    persona: "netops",
  });
});

test("resolveQuestion emits learning.question.resolved with outcome metrics", async () => {
  const weave = new InProcessSubstrate(new FakeClock(0));
  let n = 0;
  await resolveQuestion(weave, () => `id-${++n}`, "voice", "q-1", 1234, 2, true, "reachability-skill");

  const [e] = await collect(weave);
  assert.equal(e?.kind, TaskKind.QuestionResolved);
  assert.equal(e?.subject, "q-1");
  assert.deepEqual(e?.payload, {
    questionId: "q-1",
    durationMs: 1234,
    followUps: 2,
    resolved: true,
    skill: "reachability-skill",
  });
});

test("a question's lifecycle is two correlated events keyed by the same subject", async () => {
  const weave = new InProcessSubstrate(new FakeClock(0));
  let n = 0;
  const newId = () => `id-${++n}`;
  await declareQuestion(weave, newId, "voice", "q-7", "show bgp peers", "bgp", "net-A", "netops");
  await resolveQuestion(weave, newId, "voice", "q-7", 50, 0, false, "bgp-skill");

  const events = await collect(weave);
  assert.equal(events.length, 2);
  assert.deepEqual(events.map((e) => e.kind), [TaskKind.QuestionAsked, TaskKind.QuestionResolved]);
  assert.ok(events.every((e) => e.subject === "q-7"), "both events share the question id as subject");
});
