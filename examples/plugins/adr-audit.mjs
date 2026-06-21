// Example CODE skill (deterministic, no LLM) — the keyless counterpart to adr-auditor.md.
// It reconciles each ADR file's `- **Status:**` line with its row in INDEX.md, and can advance
// a Proposed ADR to Accepted when evidence files it depends on all exist. Pure and idempotent:
// a run with nothing to fix is a successful no-op. Uses the harness's read_file / edit_file.
//
// It also flags "citation danglers": code that cites an ADR-NNNN with no row in INDEX (skipping
// test fixtures and lines marked reserved/planned/future/TODO). Needs the `grep` tool; without it
// that pass self-skips. Report-only — writing a missing ADR isn't something it can do deterministically.
//
// inputs (task.spec.inputs, all optional):
//   indexPath: path to the ADR index            (default "docs/adrs/INDEX.md")
//   evidence:  { "<id>": ["path", ...], ... }    advance id Proposed→Accepted iff all paths exist
//   scanPath:  dir to scan for citations         (default "src")

const STATUS_RE = /-\s*\*\*Status:\*\*\s*(.+)/;
const ROW_RE = /^\|\s*\[(\d{4})\]\(([^)]+)\)\s*\|[^|]*\|\s*([^|]+?)\s*\|/;

// Proposed is the only "unsettled" status; Accepted/Superseded/Deprecated outrank it.
const isProposed = (s) => /^Proposed\b/i.test(s.trim());

async function readFile(ctx, path) {
  const res = await ctx.tools.invoke({ name: "read_file", args: { path } });
  return res.ok ? String(res.output.content) : null;
}
async function replaceIn(ctx, path, oldText, newText) {
  const res = await ctx.tools.invoke({ name: "edit_file", args: { path, oldText, newText } });
  return res.ok === true;
}
// Best-effort grep; returns [] (so the dangler pass self-skips) if the tool isn't granted/present.
async function grep(ctx, pattern, path, glob) {
  try {
    const res = await ctx.tools.invoke({ name: "grep", args: { pattern, path, glob } });
    return res.ok ? res.output.matches : [];
  } catch {
    return [];
  }
}

export default {
  name: "adr-audit",
  description: "Deterministically reconcile ADR statuses (file ⟷ INDEX), advance finished ones, and flag code citing ADR numbers that don't exist (no LLM).",
  match: (task) => /\badr\b/i.test(task.spec.goal) && /\b(audit|reconcile|status)\b/i.test(task.spec.goal),

  async run(task, ctx) {
    const inputs = task.spec.inputs ?? {};
    const indexPath = inputs.indexPath ?? "docs/adrs/INDEX.md";
    const evidence = inputs.evidence ?? {};
    const adrDir = indexPath.replace(/\/[^/]*$/, ""); // sibling dir of INDEX

    const indexText = await readFile(ctx, indexPath);
    if (indexText === null) return { status: "failed", summary: `cannot read ${indexPath}`, error: "no_index" };

    const advanced = [];
    const reconciled = [];
    const conflicts = [];
    const indexed = new Set(); // every ADR id present in INDEX — the source of truth for "exists"

    for (const line of indexText.split("\n")) {
      const m = ROW_RE.exec(line);
      if (!m) continue;
      const [, id, file, indexStatusRaw] = m;
      indexed.add(id);
      const indexStatus = indexStatusRaw.trim();
      const adrPath = `${adrDir}/${file}`;

      const adrText = await readFile(ctx, adrPath);
      if (adrText === null) continue;
      const sm = STATUS_RE.exec(adrText);
      if (!sm) continue;
      let fileStatus = sm[1].trim();

      // 1) Reconcile a file ⟷ INDEX mismatch by promoting the laggard to the settled value.
      if (fileStatus !== indexStatus) {
        if (isProposed(fileStatus) && !isProposed(indexStatus)) {
          if (await replaceIn(ctx, adrPath, `**Status:** ${fileStatus}`, `**Status:** ${indexStatus}`)) {
            reconciled.push(`${id}: file ${fileStatus}→${indexStatus}`);
            fileStatus = indexStatus;
          }
        } else if (!isProposed(fileStatus) && isProposed(indexStatus)) {
          if (await replaceIn(ctx, indexPath, `| ${indexStatus} |`, `| ${fileStatus} |`)) {
            reconciled.push(`${id}: INDEX ${indexStatus}→${fileStatus}`);
          }
        } else {
          conflicts.push(`${id}: file="${fileStatus}" vs INDEX="${indexStatus}"`);
        }
        continue;
      }

      // 2) Advance a still-Proposed ADR to Accepted iff all its evidence files exist.
      if (isProposed(fileStatus) && Array.isArray(evidence[id]) && evidence[id].length > 0) {
        const checks = await Promise.all(evidence[id].map((p) => readFile(ctx, p)));
        if (checks.every((c) => c !== null)) {
          const okFile = await replaceIn(ctx, adrPath, `**Status:** ${fileStatus}`, `**Status:** Accepted`);
          const okIdx = await replaceIn(ctx, indexPath, `| ${indexStatus} |`, `| Accepted |`);
          if (okFile && okIdx) advanced.push(`${id}: Proposed→Accepted (${evidence[id].length} evidence files present)`);
        }
      }
    }

    // 3) Citation danglers: code that references an ADR number with no row in INDEX. A real
    //    citation only — skip test fixtures (*.test.*) and lines flagged reserved/planned/future/
    //    TODO (a deliberate forward-reference to an unwritten ADR, not a broken link).
    const scanRoot = inputs.scanPath ?? "src";
    const danglerSet = new Map(); // id → first "file:line" where it dangles
    for (const mt of await grep(ctx, "ADR-[0-9]{4}", scanRoot)) {
      if (/\.test\./.test(mt.file) || /\b(reserved|planned|future|todo)\b/i.test(mt.text)) continue;
      for (const ref of mt.text.match(/ADR-([0-9]{4})/g) ?? []) {
        const id = ref.slice(4);
        if (!indexed.has(id) && !danglerSet.has(id)) danglerSet.set(id, `${mt.file}:${mt.line}`);
      }
    }
    const danglers = [...danglerSet].map(([id, at]) => `ADR-${id} (${at})`);

    const parts = [];
    if (advanced.length) parts.push(`advanced ${advanced.length}: ${advanced.join("; ")}`);
    if (reconciled.length) parts.push(`reconciled ${reconciled.length}: ${reconciled.join("; ")}`);
    if (conflicts.length) parts.push(`conflicts ${conflicts.length}: ${conflicts.join("; ")}`);
    if (danglers.length) parts.push(`⚠ ${danglers.length} dangling citation(s): ${danglers.join("; ")}`);
    const summary = parts.length ? parts.join(" | ") : "all ADRs already reconciled, no dangling citations (no-op)";

    return {
      status: "completed",
      summary,
      artifacts: [{ kind: "adr-audit", ref: JSON.stringify({ advanced, reconciled, conflicts, danglers }) }],
    };
  },
};
