#!/usr/bin/env node
/**
 * The `weave` CLI — a generic agent harness. It wires concrete adapters into the use-cases
 * and is deliberately DOMAIN-AGNOSTIC: it ships coordination + generic tools + a skill system.
 * Domain use-cases (a researcher, a monitor) are skills/plugins, not harness code (ADR-0016).
 * Runs under `node --import tsx src/cli.ts` and compiles via `bun build --compile`.
 */
import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { spawnSync } from "node:child_process";

import type { Substrate } from "./ports/substrate.js";
import type { Worker } from "./ports/worker.js";
import type { SealedEvent } from "./domain/event.js";
import { systemClock } from "./domain/clock.js";
import { TaskKind, type DeclaredPayload } from "./domain/task.js";
import { currentHolder, isSettled } from "./domain/claim.js";
import { declareTask } from "./usecases/declare.js";
import { compactWeave } from "./usecases/compaction.js";
import { LoopRunner } from "./usecases/loop.js";
import { checkArchitecture } from "./domain/architecture.js";
import { createPeer } from "./composition-root.js";
import type { Skill } from "./ports/skill.js";
import { ToolRegistry } from "./adapters/secondary/in-memory-tool-host.js";
import { SkillRouterWorker } from "./adapters/secondary/skill-router-worker.js";
import { SystemTimer } from "./adapters/secondary/system-timer.js";
import { scanSourceFiles } from "./adapters/secondary/source-scan.js";
import { loadSkills } from "./adapters/secondary/skill-loader.js";
import { httpFetchTool } from "./adapters/secondary/http-fetch-tool.js";
import { spawnTaskTool } from "./adapters/secondary/spawn-task-tool.js";
import { channelsFrom, notifyAll, type ChannelConfig } from "./adapters/secondary/channels.js";
import { ClaudeCliWorker } from "./adapters/secondary/claude-cli-worker.js";
import { echoSkill, claudeSkill } from "./composition/builtin-skills.js";
import { loadAgentSkills } from "./composition/agent-skill.js";
import { notifyTool } from "./composition/notify-tool.js";

const DEFAULT_DB = ".weave/weave.db";

interface Args {
  readonly _: string[];
  readonly flags: Map<string, string | boolean>;
}

/** Flags that never take a value (so they don't greedily consume the next positional arg). */
const BOOLEAN_FLAGS = new Set(["fake", "once", "follow", "lenient", "notify", "help"]);

function parseArgs(argv: string[]): Args {
  const _: string[] = [];
  const flags = new Map<string, string | boolean>();
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a.startsWith("--")) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (!BOOLEAN_FLAGS.has(key) && next !== undefined && !next.startsWith("--")) {
        flags.set(key, next);
        i++;
      } else {
        flags.set(key, true);
      }
    } else {
      _.push(a);
    }
  }
  return { _, flags };
}

const str = (args: Args, key: string, dflt: string): string => {
  const v = args.flags.get(key);
  return typeof v === "string" ? v : dflt;
};
const num = (args: Args, key: string, dflt: number): number => {
  const v = args.flags.get(key);
  return typeof v === "string" ? Number(v) : dflt;
};
const has = (args: Args, key: string): boolean => args.flags.has(key);

/** Channel config from flags or env (ADR-0014). Only set keys that have a value. */
function channelConfig(args: Args): ChannelConfig {
  const cfg: ChannelConfig = {};
  const env = (k: string) => process.env[k] ?? "";
  const slack = str(args, "slack-webhook", env("SLACK_WEBHOOK_URL"));
  if (slack) cfg.slackWebhook = slack;
  const tgToken = str(args, "telegram-token", env("TELEGRAM_BOT_TOKEN"));
  const tgChat = str(args, "telegram-chat", env("TELEGRAM_CHAT_ID"));
  if (tgToken) cfg.telegramToken = tgToken;
  if (tgChat) cfg.telegramChat = tgChat;
  if (env("EMAIL_API_URL")) cfg.emailApiUrl = env("EMAIL_API_URL");
  if (env("EMAIL_API_KEY")) cfg.emailApiKey = env("EMAIL_API_KEY");
  if (env("EMAIL_FROM")) cfg.emailFrom = env("EMAIL_FROM");
  const emailTo = str(args, "email-to", env("EMAIL_TO"));
  if (emailTo) cfg.emailTo = emailTo;
  return cfg;
}

function parseDuration(s: string): number {
  const m = /^(\d+)(ms|s|m|h)?$/.exec(s.trim());
  if (!m) return 30_000;
  const n = Number(m[1]);
  switch (m[2] ?? "s") {
    case "ms":
      return n;
    case "m":
      return n * 60_000;
    case "h":
      return n * 3_600_000;
    default:
      return n * 1_000;
  }
}

type ClosableSubstrate = Substrate & { close(): void };

/** Pick the substrate by runtime so the Bun binary stays native-addon-free (ADR-0010 §4). */
async function openSubstrate(args: Args): Promise<ClosableSubstrate> {
  const file = str(args, "db", DEFAULT_DB);
  mkdirSync(dirname(file), { recursive: true });
  const opts = { filename: file, clock: systemClock };
  if (typeof Bun !== "undefined") {
    const { BunSqliteSubstrate } = await import("./adapters/secondary/bun-sqlite-substrate.js");
    return new BunSqliteSubstrate(opts);
  }
  const seg = "sqlite-substrate"; // non-literal so Bun's bundler skips the native path
  const mod = (await import(`./adapters/secondary/${seg}.js`)) as typeof import("./adapters/secondary/sqlite-substrate.js");
  return new mod.SqliteSubstrate(opts);
}

function claudeCliAvailable(): boolean {
  try {
    return spawnSync("claude", ["--version"], { timeout: 5000, stdio: "ignore" }).status === 0;
  } catch {
    return false;
  }
}

/** Choose the LLM Worker backend (ADR-0003): Claude SDK if ANTHROPIC_API_KEY is set, else the
 *  `claude -p` CLI (Claude Code login, no key), else none. `--fake` forces none. */
async function pickLlm(args: Args): Promise<{ kind: string; make: (sp?: string) => Worker } | null> {
  if (has(args, "fake")) return null;
  const model = str(args, "model", "claude-sonnet-4-6");
  if (process.env["ANTHROPIC_API_KEY"]) {
    const { createClaudeWorkerFactory } = await import("./composition/claude-sdk.js");
    return { kind: "claude-sdk", make: (sp) => createClaudeWorkerFactory({ model, ...(sp ? { systemPrompt: sp } : {}) })() };
  }
  if (claudeCliAvailable()) {
    return {
      kind: "claude-cli",
      make: (sp) => new ClaudeCliWorker({ model, ...(sp ? { systemPrompt: sp } : {}), allowedTools: ["WebFetch", "WebSearch", "Read"] }),
    };
  }
  return null;
}

/**
 * Assemble the skill set + tool registry (ADR-0012/0016) — all generic:
 *  - code-skill plugins (.js/.ts) + declarative agent-skill plugins (.md/.json) from the dir
 *  - fallback: claude (general agent, via SDK or `claude -p` CLI) else echo (offline)
 *  - generic tools: http_fetch, spawn_task, notify. No domain logic in the harness.
 */
async function assembleSkills(
  args: Args,
  opts: { fake: boolean; model: string; weave?: Substrate; newId?: () => string },
): Promise<{ skills: Skill[]; registry: ToolRegistry; backend: string; errors: Array<{ file: string; error: string }> }> {
  const dir = str(args, "skills-dir", ".weave/skills");
  const { skills: codeSkills, errors } = await loadSkills(dir);
  const llm = await pickLlm(args);
  const agentSkills = llm ? loadAgentSkills(dir, llm.make) : [];
  const fallback = llm ? claudeSkill(llm.make) : echoSkill;
  const skills: Skill[] = [...codeSkills, ...agentSkills, fallback];

  const registry = new ToolRegistry();
  for (const s of skills) for (const t of s.tools ?? []) registry.register(t);
  registry.register(httpFetchTool); // generic HTTP capability
  if (opts.weave && opts.newId) registry.register(spawnTaskTool(opts.weave, opts.newId)); // fan-out
  registry.register(notifyTool(channelsFrom(channelConfig(args)))); // notifications
  return { skills, registry, backend: llm?.kind ?? "none", errors };
}

const fmt = (e: SealedEvent): string =>
  `#${String(e.seq).padStart(4)} ${e.kind.padEnd(15)} ${e.actor.padEnd(12)} ${e.subject}`;

async function readAll(weave: Substrate): Promise<SealedEvent[]> {
  const out: SealedEvent[] = [];
  for await (const e of weave.read(0)) out.push(e);
  return out;
}

// --- commands --------------------------------------------------------------

async function cmdUp(args: Args): Promise<void> {
  const weave = await openSubstrate(args);
  const agentId = str(args, "agent", `peer-${randomUUID().slice(0, 8)}`);
  const { skills, registry, backend, errors } = await assembleSkills(args, {
    fake: has(args, "fake"),
    model: str(args, "model", "claude-sonnet-4-6"),
    weave,
    newId: () => randomUUID(),
  });
  for (const e of errors) console.error(`weave: skill load error in ${e.file}: ${e.error}`);
  const router = new SkillRouterWorker(skills);

  const peer = createPeer({
    weave,
    cfg: {
      agentId,
      grant: { tools: "*", maxEffect: "irreversible" },
      leaseMs: num(args, "lease-ms", 30_000),
      maxConcurrent: num(args, "concurrency", 2),
      tickMs: num(args, "tick-ms", 3_000),
    },
    newWorker: () => router,
    registry,
    clock: systemClock,
    newId: () => randomUUID(),
  });

  console.log(`weave: peer "${agentId}" up on ${str(args, "db", DEFAULT_DB)} [llm: ${backend}] — skills: ${skills.map((s) => s.name).join(", ")}`);
  weave.subscribe(0, (e) => console.log(fmt(e)));

  const ac = new AbortController();
  const keepAlive = setInterval(() => {}, 1 << 30);
  const compactSecs = has(args, "compact-secs") ? Math.max(5, num(args, "compact-secs", 60)) : 0;
  let compactTimer: ReturnType<typeof setInterval> | undefined;
  if (compactSecs > 0) {
    compactTimer = setInterval(() => {
      void compactWeave(weave, () => randomUUID(), agentId).then((r) => {
        if (r.pruned > 0) console.log(`weave: auto-compacted (folded ${r.settled}, pruned ${r.pruned})`);
      });
    }, compactSecs * 1000);
    if (typeof compactTimer.unref === "function") compactTimer.unref();
  }

  const shutdown = () => {
    console.log("\nweave: shutting down…");
    clearInterval(keepAlive);
    if (compactTimer) clearInterval(compactTimer);
    ac.abort();
    void peer.stop().then(() => {
      weave.close();
      process.exit(0);
    });
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
  await peer.start(ac.signal);
}

async function cmdTask(args: Args): Promise<void> {
  const goal = args._.join(" ").trim();
  if (!goal) {
    console.error('weave task: provide a goal, e.g. weave task "research recent LLM papers"');
    process.exitCode = 1;
    return;
  }
  const weave = await openSubstrate(args);
  const taskId = str(args, "id", `task-${randomUUID().slice(0, 8)}`);
  const spec: { goal: string; skill?: string } = { goal };
  if (has(args, "skill")) spec.skill = str(args, "skill", "");
  await declareTask(weave, () => randomUUID(), "cli", taskId, spec);
  console.log(`weave: declared ${taskId}${spec.skill ? ` [skill:${spec.skill}]` : ""} — ${goal}`);
  weave.close();
}

async function cmdLoop(args: Args): Promise<void> {
  const skill = str(args, "skill", "");
  if (!skill) {
    console.error('weave loop: --skill <name> required, e.g. weave loop --skill researcher --interval 6h "LLMs"');
    process.exitCode = 1;
    return;
  }
  const weave = await openSubstrate(args);
  const newId = () => randomUUID();
  const agentId = str(args, "agent", `loop-${randomUUID().slice(0, 8)}`);
  const goal = args._.join(" ").trim() || skill;
  const interval = str(args, "interval", "30s");
  const once = has(args, "once");

  const { skills, registry, errors } = await assembleSkills(args, {
    fake: has(args, "fake"),
    model: str(args, "model", "claude-sonnet-4-6"),
    weave,
    newId,
  });
  for (const e of errors) console.error(`weave: skill load error in ${e.file}: ${e.error}`);

  const peer = createPeer({
    weave,
    cfg: {
      agentId,
      grant: { tools: "*", maxEffect: "irreversible" },
      leaseMs: num(args, "lease-ms", 60_000),
      maxConcurrent: num(args, "concurrency", 4),
      tickMs: num(args, "tick-ms", 2_000),
    },
    newWorker: () => new SkillRouterWorker(skills),
    registry,
    clock: systemClock,
    newId,
  });

  const tick = async (): Promise<void> => {
    await declareTask(weave, newId, agentId, `${skill}-${randomUUID().slice(0, 8)}`, { goal, skill });
  };

  console.log(`weave: loop "${skill}" every ${interval}${once ? " (once)" : ""} — ${goal}`);
  const notifyChannels = has(args, "notify") ? channelsFrom(channelConfig(args)) : [];
  weave.subscribe((await weave.head()) + 1, (e) => {
    if (e.kind !== TaskKind.Completed && e.kind !== TaskKind.Failed) return;
    const p = e.payload as { summary?: string; error?: string; artifacts?: unknown[] };
    console.log(`    ${e.actor.padEnd(14)} ${p.summary ?? p.error ?? e.subject}`);
    if (notifyChannels.length > 0 && e.kind === TaskKind.Completed && (p.artifacts?.length ?? 0) > 0) {
      void notifyAll(notifyChannels, { text: p.summary ?? e.subject });
    }
  });

  const ac = new AbortController();
  const keepAlive = setInterval(() => {}, 1 << 30);
  const loop = new LoopRunner(new SystemTimer(), tick, parseDuration(interval), once);
  const shutdown = () => {
    clearInterval(keepAlive);
    loop.stop();
    ac.abort();
    void peer.stop().then(() => {
      weave.close();
      process.exit(0);
    });
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
  await loop.start();
  await peer.start(ac.signal);
}

async function cmdSkills(args: Args): Promise<void> {
  const { skills, backend, errors } = await assembleSkills(args, {
    fake: has(args, "fake"),
    model: str(args, "model", "claude-sonnet-4-6"),
  });
  for (const e of errors) console.error(`  ! ${e.file}: ${e.error}`);
  console.log(`weave skills (${skills.length}) [llm: ${backend}] — from .weave/skills/ + built-in:`);
  for (const s of skills) {
    const tools = (s.tools ?? []).map((t) => t.name).join(", ");
    console.log(`  ${s.name.padEnd(14)} ${s.description}${tools ? `  [tools: ${tools}]` : ""}`);
  }
}

async function cmdCompact(args: Args): Promise<void> {
  const weave = await openSubstrate(args);
  let before = 0;
  for await (const _ of weave.read(0)) before += 1;
  const r = await compactWeave(weave, () => randomUUID(), "compactor");
  let after = 0;
  for await (const _ of weave.read(0)) after += 1;
  console.log(`weave: compacted — folded ${r.settled} settled subject(s); log ${before} → ${after} events (pruned ${r.pruned}).`);
  weave.close();
}

function cmdDoctor(args: Args): void {
  const dir = str(args, "src", "src");
  const strict = !has(args, "lenient");
  const files = scanSourceFiles(dir);
  const violations = checkArchitecture(files, { strict });
  const mode = strict ? "strict" : "lenient";
  if (violations.length === 0) {
    console.log(`weave doctor: hex architecture OK — ${files.length} files (${mode})`);
    return;
  }
  console.error(`weave doctor: ${violations.length} violation(s) (${mode}):`);
  for (const v of violations) console.error(`  ${v.file} -> ${v.importPath}: ${v.reason}`);
  process.exitCode = 1;
}

async function cmdNotify(args: Args): Promise<void> {
  const text = args._.join(" ").trim();
  if (!text) {
    console.error('weave notify: provide a message, e.g. weave notify "deploy done" --to slack');
    process.exitCode = 1;
    return;
  }
  let channels = channelsFrom(channelConfig(args));
  if (has(args, "to")) {
    const want = new Set(str(args, "to", "").split(",").map((s) => s.trim()));
    channels = channels.filter((c) => want.has(c.name));
  }
  if (channels.length === 0) {
    console.error("weave notify: no channels configured (--slack-webhook / --telegram-token+--telegram-chat / EMAIL_* env)");
    process.exitCode = 1;
    return;
  }
  const n = { text, ...(has(args, "title") ? { title: str(args, "title", "") } : {}) };
  const sent = await notifyAll(channels, n);
  console.log(`weave: notified ${sent}/${channels.length} channel(s): ${channels.map((c) => c.name).join(", ")}`);
}

async function cmdReport(args: Args): Promise<void> {
  const weave = await openSubstrate(args);
  const events = await readAll(weave);
  const full = has(args, "full");
  let shown = 0;
  for (const e of events) {
    if (e.kind !== TaskKind.Completed && e.kind !== TaskKind.Failed) continue;
    const p = e.payload as { summary?: string; error?: string };
    const text = (p.summary ?? p.error ?? "").trim();
    if (!text) continue;
    shown += 1;
    const mark = e.kind === TaskKind.Failed ? "✗" : "✓";
    console.log(`\n${mark} ${e.subject} (${e.actor})`);
    console.log(full || text.length <= 800 ? text : `${text.slice(0, 800)}\n  …(${text.length} chars; --full for all)`);
  }
  if (shown === 0) console.log("weave: no results yet");
  weave.close();
}

async function cmdStatus(args: Args): Promise<void> {
  const weave = await openSubstrate(args);
  const events = await readAll(weave);
  const now = systemClock.now();
  const subjects = new Map<string, string>();
  for (const e of events) {
    if (e.kind === TaskKind.Declared) subjects.set(e.subject, (e.payload as DeclaredPayload).spec.goal);
  }
  if (subjects.size === 0) console.log("weave: no tasks");
  for (const [subject, goal] of subjects) {
    const holder = currentHolder(events, subject, now);
    const state = isSettled(events, subject) ? "done" : holder ? `held by ${holder.agentId}` : "free";
    console.log(`${subject.padEnd(16)} [${state}] ${goal}`);
  }
  weave.close();
}

async function cmdLog(args: Args): Promise<void> {
  const weave = await openSubstrate(args);
  for (const e of await readAll(weave)) console.log(fmt(e));
  if (has(args, "follow")) {
    const head = await weave.head();
    weave.subscribe(head + 1, (e) => console.log(fmt(e)));
    process.on("SIGINT", () => {
      weave.close();
      process.exit(0);
    });
    await new Promise(() => {});
  } else {
    weave.close();
  }
}

function usage(): void {
  console.log(`weave — a domain-agnostic cooperative agent harness

usage:
  weave up        [--db <path>] [--agent <id>] [--model <m>] [--fake]
                  [--concurrency N] [--lease-ms N] [--tick-ms N] [--compact-secs N]
                  start a peer: claim tasks + route them to skills
  weave task <goal...>   [--skill <name>] [--db <path>] [--id <taskId>]
  weave loop --skill <name> [--interval 6h] [--once] [--notify ch] [goal...]
                  re-declare a task routed to <skill> each tick (a skill = a use-case)
  weave skills    [--skills-dir <dir>] [--fake]   list code + declarative skills
  weave notify <text...> [--to slack,telegram,email] [--title T]
  weave compact   [--db <path>]   fold settled tasks into a snapshot + prune the log
  weave report    [--db <path>] [--full]   print completed task results (the actual output)
  weave status    [--db <path>]
  weave log       [--db <path>] [--follow]
  weave doctor    [--lenient] [--src <dir>]   check hex architecture (strict by default)
  weave help

Domain use-cases are SKILLS, not harness code: drop a .ts (code skill) or .md (declarative
agent skill: prompt + tools) into .weave/skills/. default db: ${DEFAULT_DB}`);
}

async function main(): Promise<void> {
  const [cmd, ...rest] = process.argv.slice(2);
  const args = parseArgs(rest);
  switch (cmd) {
    case "up":
      return cmdUp(args);
    case "loop":
      return cmdLoop(args);
    case "skills":
      return cmdSkills(args);
    case "compact":
      return cmdCompact(args);
    case "notify":
      return cmdNotify(args);
    case "doctor":
      return cmdDoctor(args);
    case "task":
      return cmdTask(args);
    case "report":
      return cmdReport(args);
    case "status":
      return cmdStatus(args);
    case "log":
      return cmdLog(args);
    case undefined:
    case "help":
    case "--help":
    case "-h":
      return usage();
    default:
      console.error(`weave: unknown command "${cmd}"`);
      usage();
      process.exitCode = 1;
  }
}

main().catch((err) => {
  console.error("weave: fatal —", err instanceof Error ? err.message : err);
  process.exitCode = 1;
});
