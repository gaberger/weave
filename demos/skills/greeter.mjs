// Demo CODE skill — deterministic, no LLM. Matches greetings and replies by name.
export default {
  name: "greeter",
  description: "Greet someone by name (deterministic, no LLM).",
  match: (task) => /\b(hello|hi|hey|greet|welcome)\b/i.test(task.spec.goal),
  async run(task) {
    const m = task.spec.goal.match(/(?:hello|hi|hey|greet|welcome)\s+(\w+)/i);
    return { status: "completed", summary: `Hello, ${m ? m[1] : "world"}! 👋  (handled by skill: greeter)` };
  },
};
