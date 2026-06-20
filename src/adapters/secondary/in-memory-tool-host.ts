import type { ToolHost, ToolDescriptor, ToolCall, ToolResult } from "../../ports/tool-host.js";
import { NotPermittedError } from "../../ports/tool-host.js";
import type { Grant } from "../../domain/grant.js";
import { normalizeEffect, withinCeiling, type Effect } from "../../domain/effect.js";

/** A tool the registry can dispatch: its descriptor plus an executor. */
export interface RegisteredTool {
  readonly name: string;
  readonly description: string;
  /** Missing effect normalizes to "irreversible" (ADR-0004 §1, fail closed). */
  readonly effect?: Effect;
  readonly inputSchema?: Readonly<Record<string, unknown>>;
  execute(args: Readonly<Record<string, unknown>>): Promise<ToolResult>;
}

/** Global tool registry. `hostFor(grant)` yields a per-worker ToolHost filtered by the
 *  grant's allowlist and maxEffect ceiling (ADR-0004 §2/§3). */
export class ToolRegistry {
  private readonly tools = new Map<string, RegisteredTool>();

  register(tool: RegisteredTool): this {
    this.tools.set(tool.name, tool);
    return this;
  }

  private descriptorOf(t: RegisteredTool): ToolDescriptor {
    return {
      name: t.name,
      description: t.description,
      effect: normalizeEffect(t.effect),
      inputSchema: t.inputSchema ?? {},
    };
  }

  private permits(grant: Grant, t: RegisteredTool): boolean {
    const allowlisted = grant.tools === "*" || grant.tools.includes(t.name);
    return allowlisted && withinCeiling(normalizeEffect(t.effect), grant.maxEffect);
  }

  hostFor(grant: Grant): ToolHost {
    const registry = this;
    return {
      available(): readonly ToolDescriptor[] {
        return [...registry.tools.values()]
          .filter((t) => registry.permits(grant, t))
          .map((t) => registry.descriptorOf(t));
      },
      async invoke(call: ToolCall): Promise<ToolResult> {
        const tool = registry.tools.get(call.name);
        if (!tool || !registry.permits(grant, tool)) throw new NotPermittedError(call.name);
        return tool.execute(call.args);
      },
    };
  }
}
