import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve, sep } from "node:path";

import type { ToolDefinition, ToolResult } from "../../ports/tool-host.js";

/**
 * `research_save` — file a completed research deliverable into its OWN project folder under the weave
 * home: `research/<topic>/report.md` plus `sources/<name>.md` per source. The research agent isn't
 * network-scoped (it's web research), so it gets a dedicated project directory rather than landing in
 * a network's reports bundle. `researchDirOf()` returns the absolute `<home>/research/` dir.
 *
 * Path-traversal-safe: the topic is slugified to a single safe segment and the final paths are
 * asserted to stay inside the research root.
 */
export function researchSaveTool(researchDirOf: () => string): ToolDefinition {
  return {
    name: "research_save",
    description:
      "Save a completed research deliverable to its OWN project folder under the weave home: " +
      "research/<topic>/report.md (+ sources/<name>.md per source). Call ONCE at the end with the " +
      "synthesized report and the key sources. Args: { topic (the question/title — becomes the folder " +
      "slug), report (the full markdown report), sources? (array of { name, content }) }. Returns savedTo.",
    effect: "reversible",
    inputSchema: {
      topic: "string — the research question/title (slugified to the folder name)",
      report: "string — the full markdown report",
      sources: "array of { name, content } (optional) — key sources to keep alongside the report",
    },
    execute: async (args): Promise<ToolResult> => {
      const topic = String(args["topic"] ?? "").trim();
      const report = String(args["report"] ?? "");
      if (!topic) return { ok: false, output: { error: "topic is required" } };
      if (!report) return { ok: false, output: { error: "report is required" } };
      const slug = slugify(topic);
      const root = resolve(researchDirOf());
      const dir = resolve(root, slug);
      if (dir !== join(root, slug) || !dir.startsWith(root + sep)) {
        return { ok: false, output: { error: `topic ${JSON.stringify(topic)} did not produce a safe folder name` } };
      }
      try {
        mkdirSync(dir, { recursive: true });
        const reportPath = join(dir, "report.md");
        writeFileSync(reportPath, report);
        const saved = [reportPath];
        const sources = coerceSources(args["sources"]);
        if (sources.length) {
          const sdir = join(dir, "sources");
          mkdirSync(sdir, { recursive: true });
          sources.forEach((s, i) => {
            const name = `${slugify(s.name) || `source-${i + 1}`}.md`;
            const p = join(sdir, name);
            if (p.startsWith(sdir + sep)) {
              writeFileSync(p, s.content);
              saved.push(p);
            }
          });
        }
        return { ok: true, output: { savedTo: reportPath, dir, files: saved } };
      } catch (e) {
        return { ok: false, output: { error: e instanceof Error ? e.message : String(e) } };
      }
    },
  };
}

/** A research topic → a safe, readable folder slug (lowercase, hyphenated, bounded). */
function slugify(s: string): string {
  return String(s)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
}

/** Coerce the `sources` arg (the MCP bridge may stringify it) into [{name, content}]. */
function coerceSources(v: unknown): Array<{ name: string; content: string }> {
  let arr: unknown = v;
  if (typeof v === "string") {
    const t = v.trim();
    if (!t.startsWith("[")) return [];
    try { arr = JSON.parse(t); } catch { return []; }
  }
  if (!Array.isArray(arr)) return [];
  return arr
    .filter((x): x is Record<string, unknown> => typeof x === "object" && x !== null)
    .map((x) => ({ name: String(x["name"] ?? ""), content: String(x["content"] ?? "") }))
    .filter((s) => s.content !== "");
}
