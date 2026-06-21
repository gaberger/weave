import { test } from "node:test";
import assert from "node:assert/strict";
import type { Substrate } from "../../ports/substrate.js";
import type { DraftEvent } from "../../domain/event.js";
import { spawnTaskTool } from "./spawn-task-tool.js";

/** Minimal Substrate stub that just records appended drafts. */
function recordingSubstrate(): { weave: Substrate; events: DraftEvent[] } {
  const events: DraftEvent[] = [];
  const weave = {
    append: async (e: DraftEvent) => {
      events.push(e);
      return { ...e, seq: events.length, ts: 0 };
    },
  } as unknown as Substrate;
  return { weave, events };
}

let n = 0;
const ids = () => `id-${++n}`;

test("spawn_task records parent + causedBy from the calling task context", async () => {
  const { weave, events } = recordingSubstrate();
  const tool = spawnTaskTool(weave, ids);
  await tool.execute({ subject: "child-1", goal: "do a thing", skill: "researcher" }, { taskId: "parent-7" });
  const declared = events.at(-1)!;
  assert.equal(declared.subject, "child-1");
  assert.equal(declared.causedBy, "parent-7");
  assert.equal((declared.payload as { parent?: string }).parent, "parent-7");
});

test("spawn_task omits lineage when invoked without a task context", async () => {
  const { weave, events } = recordingSubstrate();
  const tool = spawnTaskTool(weave, ids);
  await tool.execute({ subject: "child-2", goal: "orphan task" });
  const declared = events.at(-1)!;
  assert.equal(declared.causedBy, undefined);
  assert.equal((declared.payload as { parent?: string }).parent, undefined);
});
