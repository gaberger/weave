import type { ToolHost, ToolDescriptor, ToolCall, ToolResult, ToolDefinition } from "../../ports/tool-host.js";
import { NotPermittedError } from "../../ports/tool-host.js";
import type { Grant } from "../../domain/grant.js";
import { normalizeEffect, withinCeiling } from "../../domain/effect.js";

/** @deprecated use ToolDefinition from ports/tool-host.js (kept as an alias). */
export type RegisteredTool = ToolDefinition;

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
