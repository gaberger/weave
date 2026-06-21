import type { Skill, SkillSet } from "../../ports/skill.js";

/**
 * A reloadable `SkillSet` (ADR-0017). `replace` swaps in a freshly-scanned set after
 * `write_skill` authors a new plugin, so a running peer picks up self-authored skills without
 * a restart. The router holds the SkillSet (not the array) and reads `all()` per dispatch, so
 * the swap is atomic from its point of view.
 */
export class MutableSkillSet implements SkillSet {
  private skills: readonly Skill[];

  constructor(initial: readonly Skill[] = []) {
    this.skills = initial;
  }

  all(): readonly Skill[] {
    return this.skills;
  }

  replace(skills: readonly Skill[]): void {
    this.skills = skills;
  }
}
