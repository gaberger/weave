import type { Worker, TaskAssignment, WorkerContext, WorkerResult } from "../../ports/worker.js";
import type { Skill } from "../../ports/skill.js";

/**
 * A Worker that dispatches each task to a matching Skill (ADR-0012 §2). Selection:
 * explicit `spec.skill` by name → first skill whose `match()` is true → none (failed).
 * Skills are tried in order, so specific skills should precede catch-all fallbacks.
 */
export class SkillRouterWorker implements Worker {
  constructor(private readonly skills: readonly Skill[]) {}

  select(task: TaskAssignment): Skill | undefined {
    const explicit = task.spec.skill;
    if (explicit !== undefined) return this.skills.find((s) => s.name === explicit);
    return this.skills.find((s) => s.match(task));
  }

  async run(task: TaskAssignment, ctx: WorkerContext): Promise<WorkerResult> {
    const skill = this.select(task);
    if (skill === undefined) {
      const why = task.spec.skill !== undefined ? `no skill named "${task.spec.skill}"` : "no skill matched";
      return { status: "failed", summary: `${why} for "${task.spec.goal}"`, error: "no_skill" };
    }
    ctx.onProgress(`skill: ${skill.name}`);
    return skill.run(task, ctx);
  }
}
