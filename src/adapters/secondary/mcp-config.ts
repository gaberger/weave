import { readFileSync } from "node:fs";

/**
 * The server names declared in an MCP config file (the standard `.mcp.json` shape:
 * `{ "mcpServers": { "<name>": { … } } }`). Throws a clear, actionable error if the file is missing
 * or malformed so a typo'd `--mcp-config` fails fast at peer startup rather than silently granting no
 * integrations (the worst failure mode: an "autonomous" agent that quietly can't reach anything).
 */
export function readMcpServers(path: string): string[] {
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch {
    throw new Error(`--mcp-config: cannot read ${path}`);
  }
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch {
    throw new Error(`--mcp-config: ${path} is not valid JSON`);
  }
  const servers = (json as { mcpServers?: unknown }).mcpServers;
  if (!servers || typeof servers !== "object") {
    throw new Error(`--mcp-config: ${path} has no "mcpServers" object`);
  }
  return Object.keys(servers as Record<string, unknown>);
}

/**
 * The `claude --allowedTools` grants for a set of MCP servers. Default is a whole-server grant
 * (`mcp__<server>` — every tool the server exposes) so a non-interactive peer never blocks on a
 * permission prompt while staying bounded to the servers you declared. An explicit allow list
 * (e.g. `mcp__github__create_issue`) narrows authority to specific tools instead.
 */
export function mcpToolGrants(servers: readonly string[], explicitAllow?: readonly string[]): string[] {
  if (explicitAllow && explicitAllow.length > 0) return [...explicitAllow];
  return servers.map((s) => `mcp__${s}`);
}
