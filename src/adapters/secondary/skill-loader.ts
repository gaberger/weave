import { readdirSync, statSync } from "node:fs";
import { extname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

import type { Skill } from "../../ports/skill.js";

const EXTS = new Set([".js", ".mjs", ".ts", ".mts"]);

/**
 * A cheap content-signature of a skills dir: each skill file with its mtime + size, sorted and
 * joined. Two scans with the same signature have the same skills on disk — so a reloader can skip
 * re-importing unless this changes (ADR-0017 hot-reload). A missing dir signs as "" (empty).
 * Captures adds, edits (mtime/size move), and removes; far cheaper than re-importing to compare.
 */
export function skillsDirSignature(dir: string): string {
  let files: string[];
  try {
    files = readdirSync(dir);
  } catch {
    return "";
  }
  return files
    .filter((f) => EXTS.has(extname(f)))
    .map((f) => {
      try {
        const st = statSync(join(dir, f));
        return `${f}:${st.mtimeMs}:${st.size}`;
      } catch {
        return `${f}:?`; // vanished between readdir and stat — still a change vs. a present file
      }
    })
    .sort()
    .join("|");
}

function isSkill(x: unknown): x is Skill {
  return (
    typeof x === "object" &&
    x !== null &&
    typeof (x as Skill).name === "string" &&
    typeof (x as Skill).run === "function" &&
    typeof (x as Skill).match === "function"
  );
}

/**
 * Load external skill plugins from a directory (ADR-0012 §3). Each module default-exports a
 * Skill or Skill[] (or exports `skill`/`skills`). Missing dir → no skills (not an error).
 * Returns the loaded skills plus any per-file load errors for reporting.
 *
 * Pass a distinct `version` to bust the ESM module cache when *re-scanning* after a skill was
 * rewritten in place (ADR-0017 hot-reload): `import()` caches by resolved URL, so a changed
 * file would otherwise return its stale module. A new filename reloads regardless.
 */
export async function loadSkills(
  dir: string,
  opts: { version?: number } = {},
): Promise<{ skills: Skill[]; errors: Array<{ file: string; error: string }> }> {
  let files: string[];
  try {
    files = readdirSync(dir);
  } catch {
    return { skills: [], errors: [] };
  }

  const skills: Skill[] = [];
  const errors: Array<{ file: string; error: string }> = [];

  for (const file of files) {
    if (!EXTS.has(extname(file))) continue;
    try {
      const url = pathToFileURL(resolve(dir, file));
      if (opts.version !== undefined) url.search = `v=${opts.version}`;
      const mod = (await import(url.href)) as Record<string, unknown>;
      const exported = mod["default"] ?? mod["skill"] ?? mod["skills"];
      const candidates = Array.isArray(exported) ? exported : exported !== undefined ? [exported] : [];
      const valid = candidates.filter(isSkill);
      if (valid.length === 0) errors.push({ file, error: "no Skill export found" });
      skills.push(...valid);
    } catch (e) {
      errors.push({ file, error: e instanceof Error ? e.message : String(e) });
    }
  }
  return { skills, errors };
}
