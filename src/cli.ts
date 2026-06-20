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
import type { Worker } from "./ports/worker.js";
import type { SealedEvent } from "./domain/event.js";
import { systemClock } from "./domain/clock.js";
import { TaskKind, type DeclaredPayload } from "./domain/task.js";
import { currentHolder, isSettled } from "./domain/claim.js";
import { SqliteSubstrate } from "./adapters/secondary/sqlite-substrate.js";
import { createClaudeWorkerFactory } from "./adapters/secondary/claude-sdk.js";
import { declareTask } from "./usecases/declare.js";
import { createPeer } from "./composition-root.js";

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

function openSubstrate(args: Args): SqliteSubstrate {
  const file = str(args, "db", DEFAULT_DB);
  mkdirSync(dirname(file), { recursive: true });
  return new SqliteSubstrate({ filename: file, clock: systemClock });
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
  const weave = openSubstrate(args);
  const agentId = str(args, "agent", `peer-${randomUUID().slice(0, 8)}`);
  const fake = has(args, "fake");

  const fakeWorker = (): Worker => ({
    async run(a) {
      return { status: "completed", summary: `(fake) handled: ${a.spec.goal}` };
    },
  });
  const newWorker = fake ? fakeWorker : createClaudeWorkerFactory({ model: str(args, "model", "claude-sonnet-4-6") });

  const peer = createPeer({
    weave,
    cfg: {
      agentId,
      grant: { tools: "*", maxEffect: "irreversible" },
      leaseMs: num(args, "lease-ms", 30_000),
      maxConcurrent: num(args, "concurrency", 2),
      tickMs: num(args, "tick-ms", 3_000),
    },
    newWorker,
    clock: systemClock,
    newId: () => randomUUID(),
  });

  console.log(`weave: peer "${agentId}" up on ${str(args, "db", DEFAULT_DB)}${fake ? " (fake worker)" : ""}`);
  weave.subscribe(0, (e) => console.log(fmt(e)));

  const ac = new AbortController();
  const shutdown = () => {
    console.log("\nweave: shutting down…");
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
  const weave = openSubstrate(args);
  const taskId = str(args, "id", `task-${randomUUID().slice(0, 8)}`);
  await declareTask(weave, () => randomUUID(), "cli", taskId, { goal });
  console.log(`weave: declared ${taskId} — ${goal}`);
  weave.close();
}

async function cmdStatus(args: Args): Promise<void> {
  const weave = openSubstrate(args);
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
  const weave = openSubstrate(args);
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
                  [--concurrency N] [--lease-ms N] [--tick-ms N]
  weave task <goal...>   [--db <path>] [--id <taskId>]
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
