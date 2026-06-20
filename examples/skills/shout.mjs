// Example weave skill plugin (ADR-0012). Drop a file like this in `.weave/skills/` and
// `weave up` / `weave skills` will load it — no core changes. A skill default-exports an
// object with { name, description, match, run } (and optional `tools`).
export default {
  name: "shout",
  description: "Echo the goal back in UPPERCASE (example plugin).",
  // Handle any task whose goal starts with "shout ", or explicit --skill shout.
  match: (task) => task.spec.goal.startsWith("shout "),
  async run(task) {
    const text = task.spec.goal.replace(/^shout\s+/, "");
    return { status: "completed", summary: text.toUpperCase() };
  },
};
