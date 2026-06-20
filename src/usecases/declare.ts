import type { Substrate } from "../ports/substrate.js";
import type { AgentId, TaskId } from "../domain/ids.js";
import type { TaskSpec } from "../domain/task.js";
import { TaskKind } from "../domain/task.js";

/** Declare a unit of work on the weave (emits `task.declared`). Any peer may declare. */
export async function declareTask(
  weave: Substrate,
  newId: () => string,
  actor: AgentId,
  taskId: TaskId,
  spec: TaskSpec,
): Promise<void> {
  await weave.append({
    id: newId(),
    kind: TaskKind.Declared,
    actor,
    subject: taskId,
    payload: { spec },
  });
}
