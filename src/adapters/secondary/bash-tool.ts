import { spawn } from "node:child_process";

import type { ToolDefinition, ToolResult } from "../../ports/tool-host.js";

/**
 * `bash` — run a shell command and return { code, stdout, stderr }. This is weave's most
 * dangerous capability, so it is `irreversible` (gated by the lease ceiling, ADR-0004) AND
 * never registered unless explicitly enabled (`--bash`). It ships three independent gates:
 *   1. a DENYLIST of catastrophic patterns refused before the shell runs (no rm -rf, no fork
 *      bombs, no dd-to-disk, no sudo, no curl|sh);
 *   2. an optional ALLOWLIST — when set, only commands whose leading program is listed run
 *      (this is how Claude's `allowed-tools: Bash(python3 *)` intent is honored);
 *   3. a TIMEOUT + OUTPUT CAP so a runaway command can't hang the peer or blow up context.
 *
 * IMPORTANT: the denylist is defense-in-depth, NOT a security boundary. A determined or
 * obfuscated command can evade pattern-matching (encodings, indirection, novel tools). For
 * untrusted command generation, run the peer in a container/VM — that is the real sandbox.
 */
export interface BashToolOptions {
  readonly timeoutMs?: number; // kill after this long (default 30s)
  readonly maxBytes?: number; // cap stdout+stderr each (default 256 KiB)
  readonly cwd?: string;
  /** If non-empty, only commands whose leading program is in this set may run. */
  readonly allow?: readonly string[];
  /** Extra denial patterns layered on top of {@link DEFAULT_DENY}. */
  readonly extraDeny?: readonly { rule: string; re: RegExp }[];
}

/** Catastrophic patterns refused before bash is ever spawned. Named so the rejection says why. */
export const DEFAULT_DENY: ReadonlyArray<{ rule: string; re: RegExp }> = [
  // rm with recursive + force, in any flag order / spelling.
  { rule: "recursive-force-rm", re: /\brm\b[^\n]*(-[A-Za-z]*r[A-Za-z]*f|-[A-Za-z]*f[A-Za-z]*r|-r\b[^\n]*-f|-f\b[^\n]*-r|--recursive[^\n]*--force|--force[^\n]*--recursive|--no-preserve-root)/i },
  // classic fork bomb :(){ :|:& };:
  { rule: "fork-bomb", re: /\(\s*\)\s*\{[^}]*\|[^}]*&[^}]*\}\s*;?\s*:/ },
  // writing a filesystem or raw bytes onto a block device.
  { rule: "disk-write", re: /\bmkfs(\.\w+)?\b|\bdd\b[^\n]*\bof=\/dev\/|>\s*\/dev\/(sd|nvme|hd|disk|mmcblk|vd)/i },
  // privilege escalation.
  { rule: "privilege-escalation", re: /\b(sudo|doas)\b/i },
  // halting the machine.
  { rule: "power-state", re: /\b(shutdown|reboot|halt|poweroff)\b|\binit\s+[06]\b/i },
  // pipe a remote download straight into a shell (curl|sh / wget|bash).
  { rule: "pipe-to-shell", re: /\b(curl|wget)\b[^|\n]*\|\s*(sudo\s+)?(ba|z|d|fi)?sh\b/i },
  // recursive chmod/chown rooted at / (mass permission destruction).
  { rule: "recursive-chmod-root", re: /\bch(mod|own)\b[^\n]*-[A-Za-z]*R[^\n]*\s\/(\s|$)/i },
];

/** The leading program of a command, skipping `VAR=val` env assignments. "" if none found. */
export function leadingProgram(command: string): string {
  for (const tok of command.trim().split(/\s+/)) {
    if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(tok)) continue; // env assignment, skip
    return tok.replace(/^['"]|['"]$/g, "");
  }
  return "";
}

/** Decide whether `command` may run. Returns null if allowed, else the reason it was blocked. */
export function screenCommand(command: string, opts: BashToolOptions = {}): string | null {
  const cmd = command.trim();
  if (!cmd) return "empty command";
  for (const { rule, re } of [...DEFAULT_DENY, ...(opts.extraDeny ?? [])]) {
    if (re.test(cmd)) return `blocked by denylist rule "${rule}"`;
  }
  if (opts.allow && opts.allow.length > 0) {
    const prog = leadingProgram(cmd);
    if (!opts.allow.includes(prog)) {
      return `program "${prog}" is not in the --bash-allow allowlist [${opts.allow.join(", ")}]`;
    }
  }
  return null;
}

export function bashTool(opts: BashToolOptions = {}): ToolDefinition {
  const timeoutMs = opts.timeoutMs ?? 30_000;
  const maxBytes = opts.maxBytes ?? 256 * 1024;
  const allowNote = opts.allow?.length ? ` Only these programs may run: ${opts.allow.join(", ")}.` : "";
  return {
    name: "bash",
    description:
      `Run a shell command via \`bash -c\` and return { code, stdout, stderr }. Destructive ` +
      `commands (rm -rf, dd-to-disk, sudo, fork bombs, …) are refused. Output is capped and ` +
      `the command is killed after ${Math.round(timeoutMs / 1000)}s.${allowNote}`,
    effect: "irreversible",
    inputSchema: { command: "string (a shell command)" },
    execute: (args) =>
      new Promise<ToolResult>((resolve) => {
        const command = String(args["command"] ?? "");
        const blocked = screenCommand(command, opts);
        if (blocked) {
          resolve({ ok: false, output: { command, blocked: true, error: blocked } });
          return;
        }
        const child = spawn("bash", ["-c", command], {
          ...(opts.cwd ? { cwd: opts.cwd } : {}),
          env: process.env,
        });
        let stdout = "";
        let stderr = "";
        let truncated = false;
        let timedOut = false;
        const cap = (buf: string, chunk: Buffer): string => {
          if (buf.length >= maxBytes) {
            truncated = true;
            return buf;
          }
          const next = buf + chunk.toString("utf8");
          if (next.length > maxBytes) {
            truncated = true;
            return next.slice(0, maxBytes);
          }
          return next;
        };
        const timer = setTimeout(() => {
          timedOut = true;
          child.kill("SIGKILL");
        }, timeoutMs);
        child.stdout.on("data", (c: Buffer) => (stdout = cap(stdout, c)));
        child.stderr.on("data", (c: Buffer) => (stderr = cap(stderr, c)));
        child.on("error", (e) => {
          clearTimeout(timer);
          resolve({ ok: false, output: { command, error: e.message } });
        });
        child.on("close", (code) => {
          clearTimeout(timer);
          resolve({
            ok: !timedOut && code === 0,
            output: { command, code, timedOut, truncated, stdout, stderr },
          });
        });
      }),
  };
}
