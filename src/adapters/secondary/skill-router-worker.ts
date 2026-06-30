import type { Worker, TaskAssignment, WorkerContext, WorkerResult } from "../../ports/worker.js";
import type { Skill, SkillSet } from "../../ports/skill.js";

/**
 * A Worker that dispatches each task to a matching Skill (ADR-0012 §2). Selection:
 * explicit `spec.skill` by name → first skill whose `match()` is true → none (failed).
 * Skills are tried in order, so specific skills should precede catch-all fallbacks.
 *
 * Takes a `SkillSet` (ADR-0017) — read live on every dispatch — so a reload that adds a
 * self-authored skill is picked up without rebuilding the worker. A bare array is also
 * accepted (wrapped as a fixed set) for the common static case.
 */
export class SkillRouterWorker implements Worker {
  private readonly skillsOf: () => readonly Skill[];

  constructor(skills: readonly Skill[] | SkillSet) {
    this.skillsOf = Array.isArray(skills) ? () => skills : () => (skills as SkillSet).all();
  }

  select(task: TaskAssignment): Skill | undefined {
    const skills = this.skillsOf();
    const explicit = task.spec.skill;
    if (explicit !== undefined) {
      const named = skills.find((s) => s.name === explicit);
      if (named !== undefined) return named;
      // A SOFT pin (a conversational default, not a user's explicit `--skill`) tolerates a missing
      // skill: a thin chat client pins its own catch-all name (e.g. "claude"), but the answering
      // daemon may run a different persona whose catch-all is named differently (e.g. "netops").
      // Rather than hard-fail, fall back to predicate routing so the peer still answers. An explicit
      // pin (softSkill unset) keeps the hard "no such skill" error so typos surface.
      if (task.spec.softSkill === true) return skills.find((s) => s.match(task));
      return undefined;
    }
    return skills.find((s) => s.match(task));
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
