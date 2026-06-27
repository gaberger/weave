import type { Skill, SkillSet } from "../../ports/skill.js";

/** The disk-scanning seam, injected so this adapter imports only ports (no adapter→adapter edge).
 *  Composition wires it to `skillsDirSignature` + `loadSkills` (ADR-0015 hex boundary). */
export interface SkillDirScanner {
  /** A cheap signature that changes iff the skills dir's files change (add/edit/remove). */
  signature(): string;
  /** Re-import the dir's code skills, busting the ESM cache with a fresh `version` each call. */
  load(version: number): Promise<{ skills: Skill[]; errors: Array<{ file: string; error: string }> }>;
}

/** Outcome of a {@link ReloadableSkillSet.refresh} pass. */
export interface ReloadResult {
  /** True iff the skills dir changed on disk since the last scan (so `all()` now differs). */
  readonly changed: boolean;
  /** Names of all code skills after the reload (in dir order). */
  readonly names: readonly string[];
  /** Code skills newly present since the last scan (by name) — their tools may need registering. */
  readonly added: readonly Skill[];
  /** Per-file load errors from the rescan (e.g. a malformed plugin). */
  readonly errors: ReadonlyArray<{ file: string; error: string }>;
}

/**
 * A live {@link SkillSet} (ADR-0017 §4) whose **code-skill** slice is re-scanned from `dir` on
 * demand, so a peer picks up a freshly-dropped or rewritten `.weave/skills/*.mjs` — or one authored
 * at runtime by the `write_skill` tool — without a restart. The non-reloadable `tail` (agent/claude
 * skills, the catch-all fallback) is fixed at construction: those bind an LLM worker at assembly time
 * and are out of scope for hot-reload.
 *
 * `all()` returns the cached `[...code, ...tail]` synchronously (the router reads it on every
 * dispatch). `refresh()` does the async re-import — call it on a timer. Reloads only re-import when
 * the dir's {@link skillsDirSignature} moves, and bump a cache-busting `version` so a rewritten file
 * (same URL) isn't served stale from the ESM module cache. `onChange` lets composition register any
 * tools a newly-added skill contributes (the ToolRegistry reads tools live, so that suffices).
 */
export class ReloadableSkillSet implements SkillSet {
  private code: readonly Skill[];
  private signature: string;
  private version = 0;

  constructor(
    initialCode: readonly Skill[],
    private readonly tail: readonly Skill[],
    private readonly scanner: SkillDirScanner,
    private readonly onChange?: (added: readonly Skill[]) => void,
  ) {
    this.code = initialCode;
    // Seed from the dir's CURRENT signature so the first refresh only re-imports if it truly moved
    // after construction (assembleSkills already did the initial load that produced `initialCode`).
    this.signature = scanner.signature();
  }

  all(): readonly Skill[] {
    return [...this.code, ...this.tail];
  }

  /** Re-scan the skills dir; swap the code-skill slice iff it changed on disk. Idempotent & cheap
   *  when nothing changed (a signature compare, no imports). Safe to call on a short interval. */
  async refresh(): Promise<ReloadResult> {
    const sig = this.scanner.signature();
    if (sig === this.signature) return { changed: false, names: this.code.map((s) => s.name), added: [], errors: [] };
    this.signature = sig;
    const { skills, errors } = await this.scanner.load(++this.version);
    const before = new Set(this.code.map((s) => s.name));
    this.code = skills;
    const added = skills.filter((s) => !before.has(s.name));
    if (added.length) this.onChange?.(added);
    return { changed: true, names: skills.map((s) => s.name), added, errors };
  }
}
