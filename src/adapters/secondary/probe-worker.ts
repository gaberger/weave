import type { Worker, TaskAssignment, WorkerContext, WorkerResult } from "../../ports/worker.js";
import { evaluateProbe, findingTag, type ProbeResult, type ProbeTarget } from "../../domain/interrogation.js";

/**
 * Deterministic interrogation worker (ADR-0011 §2). Reads the target + expectation from the
 * task spec, calls the `http_probe` tool, and records a finding. The task COMPLETES whenever
 * the interrogation ran (the finding may still be negative — unreachable / assertion
 * violated); `failed` is reserved for the interrogation itself erroring. No LLM in the loop.
 */
export class ProbeWorker implements Worker {
  async run(assignment: TaskAssignment, ctx: WorkerContext): Promise<WorkerResult> {
    if (ctx.signal.aborted) return { status: "aborted", summary: "cancelled", reason: "cancelled" };

    const inputs = (assignment.spec.inputs ?? {}) as Partial<ProbeTarget>;
    const target = inputs.target ?? assignment.spec.goal;

    let result: ProbeResult;
    try {
      const res = await ctx.tools.invoke({ name: "http_probe", args: { target, method: inputs.method ?? "GET" } });
      result = res.output as ProbeResult;
    } catch (e) {
      return {
        status: "failed",
        summary: `interrogation could not run for ${target}`,
        error: e instanceof Error ? e.message : String(e),
      };
    }

    const finding = evaluateProbe(result, inputs.expectStatus);
    const tag = findingTag(finding);
    ctx.onProgress(`${target} ${tag} ${finding.status} ${finding.ms}ms`);

    return {
      status: "completed",
      summary: `${target} ${tag} ${finding.status} ${finding.ms}ms`,
      artifacts: [{ kind: "probe", ref: JSON.stringify(finding) }],
    };
  }
}
