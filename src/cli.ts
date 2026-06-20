#!/usr/bin/env node
/**
 * The `weave` CLI (ADR-0010). A primary adapter + composition entry: it parses argv and
 * wires concrete adapters into the use-cases. Runtime-agnostic ESM/TS — runs under
 * `node --import tsx src/cli.ts` today and compiles via `bun build --compile` to a binary.
 */
import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

import type { Substrate } from "./ports/substrate.js";
import type { SealedEvent } from "./domain/event.js";
import { systemClock } from "./domain/clock.js";
import { TaskKind, type DeclaredPayload } from "./domain/task.js";
import { currentHolder, isSettled } from "./domain/claim.js";
import { declareTask } from "./usecases/declare.js";
import { compactWeave } from "./usecases/compaction.js";
import { diffFinding, type ProbeFinding } from "./domain/interrogation.js";
import { createPeer } from "./composition-root.js";
import { ToolRegistry } from "./adapters/secondary/in-memory-tool-host.js";
import { registerHttpProbe } from "./adapters/secondary/http-probe-tool.js";
import { ProbeWorker } from "./adapters/secondary/probe-worker.js";
import type { Skill } from "./ports/skill.js";
import { SkillRouterWorker } from "./adapters/secondary/skill-router-worker.js";
import { probeSkill, summarySkill, echoSkill, claudeSkill, analyzeSkill } from "./adapters/secondary/builtin-skills.js";
import { loadSkills } from "./adapters/secondary/skill-loader.js";
import { networkStateTool } from "./adapters/secondary/network-state-tool.js";
import { spawnTaskTool } from "./adapters/secondary/spawn-task-tool.js";
import { arxivDiscoverSkill, arxivPaperSkill } from "./adapters/secondary/arxiv-skills.js";
import { reduceContext } from "./domain/context.js";
import { LoopRunner } from "./usecases/loop.js";
import { SystemTimer } from "./adapters/secondary/system-timer.js";

const DEFAULT_DB = ".weave/weave.db";

interface Args {
  readonly _: string[];
  readonly flags: Map<string, string | boolean>;
}

function parseArgs(argv: string[]): Args {
  const _: string[] = [];
  const flags = new Map<string, string | boolean>();
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a.startsWith("--")) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (next !== undefined && !next.startsWith("--")) {
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

/** Pick the substrate by runtime so the Bun binary stays native-addon-free (ADR-0010 §4):
 *  Bun → bun:sqlite, Node → better-sqlite3. Dynamic import keeps the unused one out of the
 *  active runtime (and `--external better-sqlite3` keeps it out of the Bun bundle). */
async function openSubstrate(args: Args): Promise<ClosableSubstrate> {
  const file = str(args, "db", DEFAULT_DB);
  mkdirSync(dirname(file), { recursive: true });
  const opts = { filename: file, clock: systemClock };
  if (typeof Bun !== "undefined") {
    const { BunSqliteSubstrate } = await import("./adapters/secondary/bun-sqlite-substrate.js");
    return new BunSqliteSubstrate(opts);
  }
  // Non-literal specifier so Bun's bundler does NOT pull the native better-sqlite3 path into
  // the compiled binary (this branch only runs under Node). Types come from the type-only import.
  const seg = "sqlite-substrate";
  const mod = (await import(`./adapters/secondary/${seg}.js`)) as typeof import("./adapters/secondary/sqlite-substrate.js");
  return new mod.SqliteSubstrate(opts);
}

/** Assemble the skill set (ADR-0012): probe → external plugins → fallback (claude if a key
 *  is present and not --fake, else echo), plus a ToolRegistry holding every skill's tools. */
async function assembleSkills(
  args: Args,
  opts: { fake: boolean; model: string; weave?: Substrate; newId?: () => string },
): Promise<{ skills: Skill[]; registry: ToolRegistry; errors: Array<{ file: string; error: string }> }> {
  const dir = str(args, "skills-dir", ".weave/skills");
  const { skills: loaded, errors } = await loadSkills(dir);
  const useClaude = !opts.fake && Boolean(process.env["ANTHROPIC_API_KEY"]);
  const fallback = useClaude ? await claudeSkill(opts.model) : echoSkill;
  const llmSkills: Skill[] = useClaude ? [await analyzeSkill(opts.model)] : [];
  const skills: Skill[] = [
    probeSkill,
    summarySkill,
    arxivDiscoverSkill,
    arxivPaperSkill,
    ...llmSkills,
    ...loaded,
    fallback,
  ];

  const registry = new ToolRegistry();
  const seen = new Set<string>();
  for (const s of skills) {
    for (const t of s.tools ?? []) {
      if (!seen.has(t.name)) {
        seen.add(t.name);
        registry.register(t);
      }
    }
  }
  // Substrate-bound tools (registered at composition; skills can't hold the substrate).
  if (opts.weave) registry.register(networkStateTool(opts.weave)); // ADR-0013
  if (opts.weave && opts.newId) registry.register(spawnTaskTool(opts.weave, opts.newId)); // ADR-0008
  return { skills, registry, errors };
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
  const fake = has(args, "fake");

  // weave "knows what to do" via skills (ADR-0012): a router dispatches each task to the
  // matching skill (built-in + plugins from .weave/skills/).
  const { skills, registry, errors } = await assembleSkills(args, {
    fake,
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

  console.log(`weave: peer "${agentId}" up on ${str(args, "db", DEFAULT_DB)} — skills: ${skills.map((s) => s.name).join(", ")}`);
  weave.subscribe(0, (e) => console.log(fmt(e)));

  const ac = new AbortController();
  // Hold the event loop open: the peer's poll/heartbeat timers are unref'd (so they never
  // keep a test process alive), and start()'s promise alone doesn't keep Node running. This
  // ref'd timer makes `up` a real daemon until SIGINT.
  const keepAlive = setInterval(() => {}, 1 << 30);

  // Optional auto-compaction so a long-running peer self-bounds (ADR-0013 §4). Safe: only
  // settled subjects are folded/pruned; in-flight ones are retained.
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
    console.error('weave task: provide a goal, e.g. weave task "summarize the README"');
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

async function cmdWatch(args: Args): Promise<void> {
  const targets = args._;
  if (targets.length === 0) {
    console.error("weave watch: provide target(s), e.g. weave watch https://example.com/health --interval 30s --expect 200");
    process.exitCode = 1;
    return;
  }
  const weave = await openSubstrate(args);
  const agentId = str(args, "agent", `watcher-${randomUUID().slice(0, 8)}`);
  const interval = str(args, "interval", "30s");
  const intervalMs = parseDuration(interval);
  const expect = has(args, "expect") ? num(args, "expect", 200) : undefined;
  const once = has(args, "once");

  const registry = registerHttpProbe(new ToolRegistry());
  const peer = createPeer({
    weave,
    cfg: {
      agentId,
      grant: { tools: ["http_probe"], maxEffect: "read" }, // read-only interrogation
      leaseMs: num(args, "lease-ms", 30_000),
      maxConcurrent: num(args, "concurrency", 4),
      tickMs: num(args, "tick-ms", 2_000),
    },
    newWorker: () => new ProbeWorker(),
    registry,
    clock: systemClock,
    newId: () => randomUUID(),
  });

  const fmtFinding = (e: SealedEvent): string => {
    const p = e.payload as { summary?: string; error?: string };
    const mark = e.kind === TaskKind.Failed ? "ERR " : "    ";
    return `${mark}${e.actor.padEnd(14)} ${p.summary ?? p.error ?? e.subject}`;
  };

  const sweep = async (): Promise<void> => {
    for (const t of targets) {
      const inputs: Record<string, unknown> = { target: t };
      if (expect !== undefined) inputs.expectStatus = expect;
      await declareTask(weave, () => randomUUID(), agentId, `probe-${randomUUID().slice(0, 8)}`, {
        goal: `probe ${t}`,
        inputs,
      });
    }
  };

  console.log(
    `weave: watching ${targets.length} target(s) every ${interval}${expect !== undefined ? ` expecting ${expect}` : ""}${once ? " (once)" : ""} as "${agentId}"`,
  );

  const ac = new AbortController();
  const keepAlive = setInterval(() => {}, 1 << 30);
  let ticker: ReturnType<typeof setInterval> | undefined;
  const shutdown = () => {
    clearInterval(keepAlive);
    if (ticker) clearInterval(ticker);
    ac.abort();
    void peer.stop().then(() => {
      weave.close();
      process.exit(0);
    });
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);

  const lastByTarget = new Map<string, ProbeFinding>();
  let remaining = once ? targets.length : Number.POSITIVE_INFINITY;
  weave.subscribe((await weave.head()) + 1, (e) => {
    if (e.kind !== TaskKind.Completed && e.kind !== TaskKind.Failed) return;
    console.log(fmtFinding(e));
    if (e.kind === TaskKind.Completed) {
      const arts = (e.payload as { artifacts?: Array<{ kind: string; ref: string }> }).artifacts ?? [];
      for (const a of arts) {
        if (a.kind !== "probe") continue;
        try {
          const f = JSON.parse(a.ref) as ProbeFinding;
          const d = diffFinding(lastByTarget.get(f.target), f);
          lastByTarget.set(f.target, f);
          if (d.changed && d.from !== undefined) console.log(`    ⚠ DRIFT ${d.target}: ${d.note}`);
        } catch {
          /* ignore malformed artifact */
        }
      }
    }
    if (--remaining <= 0) shutdown();
  });

  let sweeps = 0;
  const compactEvery = has(args, "compact-every") ? Math.max(1, num(args, "compact-every", 10)) : 0;
  const doSweep = async (): Promise<void> => {
    await sweep();
    sweeps += 1;
    if (compactEvery > 0 && sweeps % compactEvery === 0) {
      const r = await compactWeave(weave, () => randomUUID(), agentId);
      console.log(`    · compacted: folded ${r.settled}, pruned ${r.pruned} events`);
    }
  };

  if (!once) ticker = setInterval(() => void doSweep(), intervalMs);
  await (once ? sweep() : doSweep());
  await peer.start(ac.signal);
}

async function cmdLoop(args: Args): Promise<void> {
  const skill = str(args, "skill", "");
  if (!skill) {
    console.error('weave loop: --skill <name> required, e.g. weave loop --skill arxiv --interval 6h "large language models"');
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

  const inputs: Record<string, unknown> = {};
  if (has(args, "feed")) inputs["feedUrl"] = str(args, "feed", "");
  if (has(args, "max")) inputs["max"] = num(args, "max", 10);
  inputs["query"] = str(args, "query", goal);

  const tick = async (): Promise<void> => {
    const spec: { goal: string; skill: string; inputs?: Record<string, unknown> } = { goal, skill };
    if (Object.keys(inputs).length > 0) spec.inputs = inputs;
    await declareTask(weave, newId, agentId, `${skill}-${randomUUID().slice(0, 8)}`, spec);
  };

  console.log(`weave: loop "${skill}" every ${interval}${once ? " (once)" : ""} — ${goal}`);
  weave.subscribe((await weave.head()) + 1, (e) => {
    if (e.kind !== TaskKind.Completed && e.kind !== TaskKind.Failed) return;
    const p = e.payload as { summary?: string; error?: string };
    console.log(`    ${e.actor.padEnd(14)} ${p.summary ?? p.error ?? e.subject}`);
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
  const { skills, errors } = await assembleSkills(args, {
    fake: has(args, "fake"),
    model: str(args, "model", "claude-sonnet-4-6"),
  });
  for (const e of errors) console.error(`  ! ${e.file}: ${e.error}`);
  console.log(`weave skills (${skills.length}) — from .weave/skills/ + built-in:`);
  for (const s of skills) {
    const tools = (s.tools ?? []).map((t) => t.name).join(", ");
    console.log(`  ${s.name.padEnd(12)} ${s.description}${tools ? `  [tools: ${tools}]` : ""}`);
  }
}

async function cmdCompact(args: Args): Promise<void> {
  const weave = await openSubstrate(args);
  let before = 0;
  for await (const _ of weave.read(0)) before += 1;
  const r = await compactWeave(weave, () => randomUUID(), "compactor");
  let after = 0;
  for await (const _ of weave.read(0)) after += 1;
  console.log(
    `weave: compacted — folded ${r.settled} settled subject(s), retained ${r.targets} target finding(s); log ${before} → ${after} events (pruned ${r.pruned}).`,
  );
  weave.close();
}

async function cmdSummary(args: Args): Promise<void> {
  const weave = await openSubstrate(args);
  const events: SealedEvent[] = [];
  for await (const e of weave.read(0)) events.push(e);
  const r = reduceContext(events);
  console.log(
    `network: ${r.totals.healthy}/${r.totals.targets} healthy, ${r.totals.unhealthy} unhealthy, ${r.totals.unreachable} unreachable, ${r.totals.violations} violations`,
  );
  for (const t of r.targets) console.log(`  ${t.tag.padEnd(16)} ${String(t.status).padStart(3)}  ${t.target}`);
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
    await new Promise(() => {}); // run until SIGINT
  } else {
    weave.close();
  }
}

function usage(): void {
  console.log(`weave — cooperative-network agent CLI

usage:
  weave up        [--db <path>] [--agent <id>] [--model <m>] [--fake]
                  [--concurrency N] [--lease-ms N] [--tick-ms N] [--compact-secs N]
  weave watch <target...> [--interval 30s] [--expect 200] [--once]
                  [--compact-every N] [--db <path>] [--agent <id>] [--concurrency N]
                  loop: interrogate targets repeatedly (read-only http_probe); flags drift
  weave loop --skill <name> [--interval 6h] [--once] [--feed URL] [--max N] [goal...]
                  first-class loop: re-declare a task routed to <skill> each tick
                  (e.g. weave loop --skill arxiv --interval 6h "large language models")
  weave compact   [--db <path>]   fold settled tasks into a snapshot + prune the log
  weave summary   [--db <path>]   reduced network state: one line per target + rollup
  weave skills    [--skills-dir <dir>] [--fake]
                  list loaded skills (built-in + plugins from .weave/skills/)
  weave task <goal...>   [--db <path>] [--id <taskId>] [--skill <name>]
  weave status    [--db <path>]
  weave log       [--db <path>] [--follow]
  weave help

default db: ${DEFAULT_DB}   (Claude worker needs ANTHROPIC_API_KEY; use --fake to demo offline)`);
}

async function main(): Promise<void> {
  const [cmd, ...rest] = process.argv.slice(2);
  const args = parseArgs(rest);
  switch (cmd) {
    case "up":
      return cmdUp(args);
    case "watch":
      return cmdWatch(args);
    case "loop":
      return cmdLoop(args);
    case "skills":
      return cmdSkills(args);
    case "compact":
      return cmdCompact(args);
    case "summary":
      return cmdSummary(args);
    case "task":
      return cmdTask(args);
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
