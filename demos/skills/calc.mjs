// Demo CODE skill — deterministic, no LLM. Matches arithmetic asks and sums the numbers.
export default {
  name: "calc",
  description: "Sum the numbers found in the goal (deterministic, no LLM).",
  match: (task) => /\b(add|sum|plus|total|calc)\b/i.test(task.spec.goal),
  async run(task) {
    const nums = (task.spec.goal.match(/-?\d+(?:\.\d+)?/g) || []).map(Number);
    if (nums.length === 0) return { status: "failed", summary: "no numbers to add", error: "no_numbers" };
    const total = nums.reduce((a, b) => a + b, 0);
    return { status: "completed", summary: `${nums.join(" + ")} = ${total}  (handled by skill: calc)` };
  },
};
