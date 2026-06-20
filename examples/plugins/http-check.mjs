// Example CODE skill (deterministic, no LLM) — the counterpart to the declarative .md plugins.
// Drop into .weave/skills/. A code skill default-exports a Skill object:
//   { name, description, match, run, tools? }
// `run(task, ctx)` has full control: it uses granted tools (here the harness's `http_fetch`),
// applies its own logic, and returns a typed WorkerResult — completed | failed | aborted.
// Unlike a declarative agent skill, this needs no API key and is fully deterministic.

export default {
  name: "http-check",
  description: "Deterministically GET each URL in the goal and report UP/DOWN (no LLM).",
  match: (task) =>
    task.spec.goal.startsWith("http-check") || task.spec.goal.startsWith("check "),

  async run(task, ctx) {
    const urls = task.spec.goal
      .replace(/^(http-check|check)\s*/i, "")
      .split(/\s+/)
      .filter(Boolean);

    if (urls.length === 0) {
      return { status: "failed", summary: "no URLs given", error: "no_targets" };
    }

    const results = [];
    for (const url of urls) {
      const res = await ctx.tools.invoke({ name: "http_fetch", args: { target: url } });
      const status = Number((res.output && res.output.status) || 0);
      results.push({ url, status, ok: status >= 200 && status < 400 });
    }

    const down = results.filter((r) => !r.ok);
    const summary = results.map((r) => `${r.url} ${r.ok ? "UP" : "DOWN"}(${r.status})`).join(", ");

    if (down.length > 0) {
      return { status: "failed", summary, error: `${down.length} down` };
    }
    return {
      status: "completed",
      summary,
      artifacts: [{ kind: "http-check", ref: JSON.stringify(results) }],
    };
  },
};
