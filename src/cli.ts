#!/usr/bin/env node
/**
 * The `weave` CLI — a generic agent harness. It wires concrete adapters into the use-cases
 * and is deliberately DOMAIN-AGNOSTIC: it ships coordination + generic tools + a skill system.
 * Domain use-cases (a researcher, a monitor) are skills/plugins, not harness code (ADR-0016).
 * Runs under `node --import tsx src/cli.ts` and compiles via `bun build --compile`.
 */
import { randomUUID } from "node:crypto";
import { mkdirSync, openSync, writeFileSync, readFileSync, readdirSync, existsSync, rmSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { homedir, tmpdir } from "node:os";
import { spawnSync, spawn } from "node:child_process";
import { createInterface } from "node:readline";

// Terminal colors (ANSI escape codes)
const colors = {
  reset: "\x1b[0m",
  dim: "\x1b[2m",
  bold: "\x1b[1m",
  gray: "\x1b[90m",
  red: "\x1b[91m",
  green: "\x1b[92m",
  yellow: "\x1b[93m",
  blue: "\x1b[94m",
  magenta: "\x1b[95m",
  cyan: "\x1b[96m",
  white: "\x1b[97m",
};

// Color is gated on TTY + NO_COLOR (https://no-color.org) so ANSI escapes never leak into pipes,
// redirects, or daemon log files (the operator's main inspection surface). `--no-color` forces it
// off via setColorEnabled() in main(); a non-TTY stdout (piped/daemon) disables it automatically.
let colorEnabled = process.stdout.isTTY === true && !process.env["NO_COLOR"];
const setColorEnabled = (on: boolean): void => { colorEnabled = on; };
const paint = (code: string, s: string): string => (colorEnabled ? `${code}${s}${colors.reset}` : s);

// Color utility functions
const dim = (s: string): string => paint(colors.dim, s);
const bold = (s: string): string => paint(colors.bold, s);
const green = (s: string): string => paint(colors.green, s);
const red = (s: string): string => paint(colors.red, s);
const yellow = (s: string): string => paint(colors.yellow, s);
const blue = (s: string): string => paint(colors.blue, s);
const cyan = (s: string): string => paint(colors.cyan, s);
const gray = (s: string): string => paint(colors.gray, s);

import type { Substrate } from "./ports/substrate.js";
import type { Worker } from "./ports/worker.js";
import type { SealedEvent } from "./domain/event.js";
import { systemClock } from "./domain/clock.js";
import { TaskKind, type DeclaredPayload, type ProgressPayload } from "./domain/task.js";
import { classifyIntent, type Intent } from "./domain/intent.js";
import { classifyTier, type Tier } from "./domain/model-tier.js";
import { currentHolder, isSettled } from "./domain/claim.js";
import { declareTask } from "./usecases/declare.js";
import { declareQuestion, resolveQuestion } from "./usecases/learning.js";
import { compactWeave } from "./usecases/compaction.js";
import { getCachedAnswer, cacheAnswer } from "./usecases/cache.js";
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
import { bashTool } from "./adapters/secondary/bash-tool.js";
import { spawnTaskTool } from "./adapters/secondary/spawn-task-tool.js";
import { readFileTool, editFileTool, grepTool } from "./adapters/secondary/fs-tools.js";
import { writeSkillTool } from "./adapters/secondary/write-skill-tool.js";
import { channelsFrom, notifyAll, type ChannelConfig } from "./adapters/secondary/channels.js";
import { ClaudeCliWorker } from "./adapters/secondary/claude-cli-worker.js";
import { echoSkill, claudeSkill, netopsAgentSkill, personaAgentSkill, VOICE_SUMMARY_SYSTEM } from "./composition/builtin-skills.js";
import { loadAgentSkills, loadClaudeSkills, makeAgentSkill } from "./composition/agent-skill.js";
import { notifyTool } from "./composition/notify-tool.js";
import { buildGraph, neighbours, type GraphEdge, type KnowledgeGraph, type ReportInput } from "./domain/knowledge-graph.js";
import { buildBm25, bm25Search, hybridRank, cosine, type Scored } from "./domain/search.js";
import { httpEmbedderFromEnv } from "./adapters/secondary/http-embedder.js";
import { localEmbedder } from "./adapters/secondary/local-embedder.js";
import type { Embedder } from "./ports/embedder.js";
import type { ToolDefinition } from "./ports/tool-host.js";

const DEFAULT_DB = ".weave/weave.db";
const DEFAULT_NETWORK = "default";

/** True when `root` is the weave engine source tree (package.json name === "weave" + src/cli.ts).
 *  Weave operates *inside a project*; rooting a workspace at the engine repo would point the agent's
 *  file tools (read/grep/edit, cli.ts:531-533) and all runtime state (.weave/) at framework source —
 *  letting a worker rewrite the harness it runs on. This is the only directory that satisfies both. */
function isEngineRepo(root: string): boolean {
  try {
    const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as { name?: string };
    return pkg.name === "weave" && existsSync(join(root, "src", "cli.ts"));
  } catch {
    return false; // no/unreadable package.json — not the engine repo
  }
}

/** Resolve the workspace root — where weave reads/writes ALL project state (.weave/ db+reports+memory)
 *  and roots its file tools. Override cwd with `--workspace <dir>` or WEAVE_HOME. Refuses the engine
 *  repo (ADR-0016: the harness is domain-agnostic; a project must not live inside it). */
function resolveWorkspace(args: Args): string {
  const root = resolve(str(args, "workspace", process.env.WEAVE_HOME ?? process.cwd()));
  if (isEngineRepo(root)) {
    throw new Error(
      `refusing to use the weave engine repo as a workspace:\n  ${root}\n` +
        `weave runs inside a project, not its own source tree. ` +
        `cd into a project directory (e.g. ~/networks/<name>/) or pass --workspace <dir>.`,
    );
  }
  return root;
}

/** Network context: each network ID gets its own isolated db, reports, and .env.
 *  Returns the network ID from args or environment, defaulting to "default". */
function networkId(args: Args): string {
  return str(args, "network-id", process.env.WEAVE_NETWORK_ID ?? DEFAULT_NETWORK);
}

/** Resolve the .weave root for a network: .weave/networks/<id>/ or .weave/ for default. */
function networkRoot(network: string): string {
  return network === DEFAULT_NETWORK ? ".weave" : join(".weave", "networks", network);
}

/** Resolve the db path for a network: <network-root>/weave.db. */
function dbPathFor(network: string, explicit?: string): string {
  if (explicit) return explicit; // --db wins
  return join(networkRoot(network), "weave.db");
}

/** Resolve the pid file path for a network: <network-root>/weave.pid. */
function pidPathFor(network: string, explicit?: string): string {
  if (explicit) return explicit.replace(/\.db$/, "") + ".pid"; // --db: <name>.db → <name>.pid
  return join(networkRoot(network), "weave.pid");
}

/** Resolve the log file path for a network: <network-root>/weave.log. */
function logPathFor(network: string, explicit?: string): string {
  if (explicit) return explicit.replace(/\.db$/, "") + ".log"; // --db: <name>.db → <name>.log
  return join(networkRoot(network), "weave.log");
}

interface Args {
  readonly _: string[];
  readonly flags: Map<string, string | boolean>;
}

/** Flags that never take a value (so they don't greedily consume the next positional arg). */
const BOOLEAN_FLAGS = new Set(["fake", "once", "follow", "lenient", "notify", "help", "daemon", "claude-skills", "bash", "read-only", "no-embed", "no-context", "route", "no-tier", "no-color"]);

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
/** Like num(), but validates a positive-integer flag at the CLI boundary and fails fast. A bad
 *  numeric flag (NaN/zero/negative) otherwise flows silently into the peer loop — e.g.
 *  `--concurrency abc` → NaN → the `active.size >= maxConcurrent` guard never trips (every compare
 *  with NaN is false) → UNBOUNDED task fan-out. Validate the count-style flags (concurrency, workers,
 *  lease-ms, tick-ms, limit, compact-secs) so a typo can't quietly become a runaway. */
const numPos = (args: Args, key: string, dflt: number): number => {
  const v = args.flags.get(key);
  if (typeof v !== "string") return dflt;
  const n = Number(v);
  if (!Number.isInteger(n) || n < 1) {
    console.error(`weave: --${key} expects a positive integer, got "${v}"`);
    process.exit(1);
  }
  return n;
};
const has = (args: Args, key: string): boolean => args.flags.has(key);

// A long-running peer command (up/pool/loop/chat/voice) sets this so a transient per-task error —
// e.g. a substrate I/O hiccup surfacing as a detached promise rejection — is LOGGED and survived
// instead of silently killing the whole daemon (Node terminates on an unhandled rejection). One-shot
// commands leave it false, so they still fail fast and non-zero on an unexpected error.
let resilient = false;
const setResilient = (): void => { resilient = true; };

// --- model tiering (ADR-0022) ----------------------------------------------
// Default tier → model id ladder (Haiku/Sonnet/Opus). Overridable per tier via --tierN-model or
// WEAVE_TIERN_MODEL so the harness never hardcodes ids in the domain. tier 2 == weave's prior default.
const TIER_MODELS: Record<Tier, string> = {
  1: "claude-haiku-4-5",
  2: "claude-sonnet-4-6",
  3: "claude-opus-4-8",
};

function tierModel(args: Args, tier: Tier): string {
  return str(args, `tier${tier}-model`, process.env[`WEAVE_TIER${tier}_MODEL`] ?? TIER_MODELS[tier]);
}

/** Resolve the model for a goal at declare time: an explicit --model wins; else classify the goal
 *  into a tier and map it to a model id (ADR-0022). Returns undefined to leave the choice to the
 *  claiming peer's own default (used when tiering is off). */
function modelForGoal(args: Args, goal: string): string {
  if (has(args, "model")) return str(args, "model", TIER_MODELS[2]);
  return tierModel(args, classifyTier(goal));
}

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

/** Parse a duration like 30s / 6h / 500ms → milliseconds. Returns null on a malformed value (e.g.
 *  "6x", "4m5") so callers fail loudly instead of silently collapsing to a default. */
function parseDuration(s: string): number | null {
  const m = /^(\d+)(ms|s|m|h)?$/.exec(s.trim());
  if (!m) return null;
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

/** Read a duration flag, exiting with an actionable message if it is present but malformed. */
function durationFlag(args: Args, key: string, dflt: string): number {
  const raw = str(args, key, dflt);
  const ms = parseDuration(raw);
  if (ms === null) {
    console.error(`weave: --${key} expects a duration like 30s / 6h / 500ms, got "${raw}"`);
    process.exit(1);
  }
  return ms;
}

type ClosableSubstrate = Substrate & { close(): void };

/** Pick the substrate by runtime so the Bun binary stays native-addon-free (ADR-0010 §4). */
async function openSubstrate(args: Args): Promise<ClosableSubstrate> {
  const network = networkId(args);
  const explicitDb = args.flags.get("db") as string | undefined;
  const file = dbPathFor(network, explicitDb);
  try {
    mkdirSync(dirname(file), { recursive: true });
    // Fixed working-memory location for agent skills, guaranteed to exist (sibling of the db). Skills
    // write per-topic <topic-slug>.notes.md here — the harness owns the dir, not a prompt convention.
    mkdirSync(join(dirname(file), "memory"), { recursive: true });
    // Durable report store: completion summaries live in the event log, which compaction prunes
    // (ADR-0007). Peers mirror each settled result to <reports>/<taskId>.md so accumulated knowledge
    // survives compaction. See persistReports().
    mkdirSync(join(dirname(file), "reports"), { recursive: true });
    const opts = { filename: file, clock: systemClock };
    if (typeof Bun !== "undefined") {
      const { BunSqliteSubstrate } = await import("./adapters/secondary/bun-sqlite-substrate.js");
      return new BunSqliteSubstrate(opts);
    }
    const seg = "sqlite-substrate"; // non-literal so Bun's bundler skips the native path
    const mod = (await import(`./adapters/secondary/${seg}.js`)) as typeof import("./adapters/secondary/sqlite-substrate.js");
    return new mod.SqliteSubstrate(opts);
  } catch (e) {
    // Turn an opaque native/SQLite failure into an actionable next step. Without this the error is a
    // context-free `weave: fatal — <msg>` with no db path and no remedy.
    const msg = e instanceof Error ? e.message : String(e);
    console.error(`${red("✗")} weave: cannot open the event store at ${file}`);
    if (/EACCES|EROFS|permission denied|read-only/i.test(msg))
      console.error(`  → ${dirname(file)} is not writable — run from a writable project dir, or pass --db <writable-path>`);
    else if (/NODE_MODULE_VERSION|compiled against|invalid ELF|dlopen|\.node|Could not locate the bindings/i.test(msg))
      console.error(`  → native module mismatch — run: npm rebuild better-sqlite3   (or use the Bun single binary)`);
    else if (/malformed|file is not a database|not a database|disk image is malformed/i.test(msg))
      console.error(`  → the database file looks corrupt — back up and delete ${file}, then retry`);
    else if (/disk I\/O|SQLITE_BUSY|locked|database is locked/i.test(msg))
      console.error(`  → db is locked or on a problematic filesystem (e.g. a network drive) — stop other peers, or pass --db <local-path>`);
    else console.error(`  → ${msg}`);
    process.exit(1);
  }
}

/** The durable report bundle root (sibling of the db), guaranteed to exist by openSubstrate.
 *  Laid out as an OKF v0.1 bundle: per-skill subdirs of concept files + index.md / log.md. */
function reportsDirFor(args: Args): string {
  const network = networkId(args);
  const explicitDb = args.flags.get("db") as string | undefined;
  const dbPath = dbPathFor(network, explicitDb);
  return join(dirname(dbPath), "reports");
}

/** Embedder for hybrid search: a configured provider (WEAVE_EMBED_KEY) if present, else the offline
 *  local hashing embedder, unless `--no-embed` forces BM25-only. */
function pickEmbedder(args: Args): Embedder | null {
  if (has(args, "no-embed")) return null;
  return httpEmbedderFromEnv() ?? localEmbedder();
}

const SLUG_STOP = new Set(
  "a an the of on in at to for and or i we you it is are be need want would full create gather get make build with from this that these those please do run write some".split(" "),
);

/** Topic slug from a goal: drop filler words, kebab-case the rest, cap length. Deterministic so the
 *  same task always maps to the same filename (writes stay idempotent across backfills). */
function slugify(text: string, max = 56): string {
  let slug = "";
  for (const t of text.toLowerCase().replace(/[^a-z0-9\s-]/g, " ").split(/[\s-]+/)) {
    if (!t || SLUG_STOP.has(t)) continue;
    if (slug.length + t.length + 1 > max) break;
    slug = slug ? `${slug}-${t}` : t;
  }
  return slug || "untitled";
}

/** A YAML scalar that can't break frontmatter: double-quoted, escaped, single-line. */
function yamlStr(s: string): string {
  return `"${s.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\s+/g, " ").trim()}"`;
}

interface ReportRecord {
  subject: string;
  skill: string;
  title: string; // the goal, one line
  description: string; // lead line of the body
  status: "completed" | "failed";
  timestamp: string; // ISO 8601
  relPath: string; // bundle-relative, e.g. researcher/sr-mpls--671f79ce.md
}

/** The first meaningful line of the body, stripped of markdown heading/quote markers, for `description`. */
function leadLine(body: string): string {
  for (const raw of body.split("\n")) {
    const line = raw.replace(/^[#>\s*-]+/, "").trim();
    if (line) return line.length > 200 ? `${line.slice(0, 197)}…` : line;
  }
  return "";
}

/** Short display label for index/log links: first sentence, capped — the full goal stays in the
 *  concept file's frontmatter `title`. Keeps the navigable indexes readable for long goals. */
function displayTitle(title: string, max = 80): string {
  const firstSentence = title.split(/(?<=[.?!])\s/)[0] ?? title;
  const t = (firstSentence.length <= max ? firstSentence : title).trim();
  return t.length <= max ? t : `${t.slice(0, max - 1)}…`;
}

/** Regenerate the OKF index.md (top + per-skill) and the top-level log.md from all known records. */
function writeBundleIndexes(reportsDir: string, records: Map<string, ReportRecord>): void {
  const all = [...records.values()];
  const bySkill = new Map<string, ReportRecord[]>();
  for (const r of all) (bySkill.get(r.skill) ?? bySkill.set(r.skill, []).get(r.skill)!).push(r);

  // Top-level index.md — progressive disclosure: link out to each per-skill sub-bundle (no frontmatter).
  const skills = [...bySkill.keys()].sort();
  const topIndex =
    `# Weave Knowledge Bundle\n\n` +
    `OKF v0.1 bundle of ${all.length} report(s) across ${skills.length} skill(s).\n\n` +
    skills.map((s) => `- [${s}](/${s}/index.md) — ${bySkill.get(s)!.length} report(s)`).join("\n") +
    "\n";
  writeFileSync(join(reportsDir, "index.md"), topIndex);

  // Per-skill index.md — list its concept files (relative links within the sub-bundle).
  for (const s of skills) {
    const items = bySkill
      .get(s)!
      .slice()
      .sort((a, b) => b.timestamp.localeCompare(a.timestamp))
      .map((r) => `- [${displayTitle(r.title)}](./${r.relPath.split("/").pop()}) — ${r.status}, ${r.timestamp.slice(0, 10)}`)
      .join("\n");
    writeFileSync(join(reportsDir, s, "index.md"), `# ${s}\n\n${items}\n`);
  }

  // log.md — chronological history, date-grouped (ISO YYYY-MM-DD), newest first.
  const byDate = new Map<string, ReportRecord[]>();
  for (const r of all) {
    const d = r.timestamp.slice(0, 10);
    (byDate.get(d) ?? byDate.set(d, []).get(d)!).push(r);
  }
  const log =
    `# Log\n\n` +
    [...byDate.keys()]
      .sort((a, b) => b.localeCompare(a))
      .map(
        (d) =>
          `## ${d}\n\n` +
          byDate
            .get(d)!
            .map((r) => `- ${r.status} \`${r.skill}\` — [${displayTitle(r.title)}](/${r.relPath})`)
            .join("\n"),
      )
      .join("\n\n") +
    "\n";
  writeFileSync(join(reportsDir, "log.md"), log);
}

/**
 * Mirror every settled task's result to an OKF v0.1 concept file so accumulated knowledge outlives
 * log compaction (the event log keeps the result, but compaction prunes it — ADR-0007). Layout:
 * `<reportsDir>/<skill>/<topic-slug>--<shortid>.md` with YAML frontmatter (type/title/description/
 * resource/tags/timestamp + task_id/skill/status/actor), plus regenerated index.md/log.md.
 * Subscribes from seq 0 so it backfills history on startup and captures live completions; every path
 * is derived purely from the event, so writes are idempotent and multiple peers on one db are safe.
 */
function persistReports(weave: Substrate, reportsDir: string, embedder: Embedder | null = null): void {
  const specs = new Map<string, { goal: string; skill?: string; parent?: string }>();
  const records = new Map<string, ReportRecord>();
  // Debounce the (whole-bundle) index rebuild so a backfill burst collapses into one pass.
  let indexTimer: ReturnType<typeof setTimeout> | undefined;
  const scheduleIndex = (): void => {
    if (indexTimer) clearTimeout(indexTimer);
    indexTimer = setTimeout(() => void indexBundle(reportsDir, embedder).catch((err) => console.error(`weave: index failed — ${(err as Error).message}`)), 500);
    indexTimer.unref?.();
  };
  weave.subscribe(0, (e) => {
    if (e.kind === TaskKind.Declared) {
      const d = e.payload as DeclaredPayload;
      specs.set(e.subject, { goal: d.spec.goal, ...(d.spec.skill ? { skill: d.spec.skill } : {}), ...(d.parent ? { parent: d.parent } : {}) });
      return;
    }
    if (e.kind !== TaskKind.Completed && e.kind !== TaskKind.Failed) return;
    const p = e.payload as { summary?: string; error?: string };
    const body = (p.summary ?? p.error ?? "").trim();
    if (!body) return; // nothing worth persisting
    const spec = specs.get(e.subject);
    // subject is "<skill>-<shortid>"; prefer the declared skill, fall back to the prefix.
    const lastDash = e.subject.lastIndexOf("-");
    const shortid = lastDash >= 0 ? e.subject.slice(lastDash + 1) : e.subject;
    const skill = spec?.skill ?? (lastDash >= 0 ? e.subject.slice(0, lastDash) : "misc");
    const goal = (spec?.goal ?? e.subject).replace(/\s+/g, " ").trim();
    const status = e.kind === TaskKind.Failed ? "failed" : "completed";
    const timestamp = new Date(e.ts).toISOString();
    const relPath = `${slugify(skill, 24)}/${slugify(goal)}--${shortid}.md`;
    const rec: ReportRecord = { subject: e.subject, skill, title: goal, description: leadLine(body), status, timestamp, relPath };

    const frontmatter =
      `---\n` +
      `type: Report\n` +
      `title: ${yamlStr(goal)}\n` +
      `description: ${yamlStr(rec.description || goal)}\n` +
      `resource: weave://task/${e.subject}\n` +
      `tags: [${skill}, ${status}]\n` +
      `timestamp: ${timestamp}\n` +
      `task_id: ${e.subject}\n` +
      `skill: ${skill}\n` +
      `status: ${status}\n` +
      `actor: ${e.actor}\n` +
      (spec?.parent ? `parent: ${spec.parent}\n` : "") +
      `---\n\n`;
    try {
      mkdirSync(join(reportsDir, dirname(relPath)), { recursive: true });
      writeFileSync(join(reportsDir, relPath), frontmatter + body + "\n");
      records.set(e.subject, rec);
      writeBundleIndexes(reportsDir, records);
      scheduleIndex(); // rebuild graph + search index (debounced)
    } catch (err) {
      console.error(`weave: could not persist report ${relPath}: ${(err as Error).message}`);
    }
  });
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
    try {
      const { createClaudeWorkerFactory } = await import("./composition/claude-sdk.js");
      return { kind: "claude-sdk", make: (sp) => createClaudeWorkerFactory({ model, ...(sp ? { systemPrompt: sp } : {}) })() };
    } catch (e) {
      // Key is set but the SDK package isn't installed (or failed to load). Don't hard-crash — warn
      // and fall through to the claude CLI / offline echo so the user still gets a working peer.
      console.error(`weave: ANTHROPIC_API_KEY is set but the Claude SDK failed to load — ${e instanceof Error ? e.message : String(e)}`);
      console.error(`  → run \`npm install\`, or use the claude CLI (unset the key) / --fake for offline echo`);
    }
  }
  if (claudeCliAvailable()) {
    // The CLI worker uses Claude Code's OWN tools (not weave's ToolHost), so these writes are NOT
    // routed through the effect-gate (ADR-0003 §6 capability ceiling). We grant write by default
    // anyway: a research/agent skill is near-useless without durable working-memory (a scratchpad it
    // can re-Read to rebuild context) and the ability to serialize its deliverable to disk. Glob lets
    // it discover existing files (e.g. nqe/*.nqe). `--read-only` opts back out for untrusted goals.
    const allowedTools = ["WebFetch", "WebSearch", "Read"];
    if (!has(args, "read-only")) allowedTools.push("Write", "Edit", "Glob");
    // NetOps preset needs Bash — every forward-* skill runs `python3 .../scripts/*.py`.
    if (has(args, "netops") || str(args, "persona", "") === "netops") allowedTools.push("Bash");
    return {
      kind: "claude-cli",
      make: (sp) => new ClaudeCliWorker({ model, ...(sp ? { systemPrompt: sp } : {}), allowedTools }),
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
// Package root = parent of the dir holding this module. Resolves to the repo root
// from both `src/cli.ts` (dev/tsx) and `dist/cli.js` (built) — both sit one level
// under the root. Used to locate the vendored NetOps skills shipped in `skills/`.
const PACKAGE_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));

async function assembleSkills(
  args: Args,
  opts: { fake: boolean; model: string; weave?: Substrate; newId?: () => string },
): Promise<{ skills: Skill[]; registry: ToolRegistry; backend: string; errors: Array<{ file: string; error: string }> }> {
  const dir = str(args, "skills-dir", ".weave/skills");
  const { skills: codeSkills, errors } = await loadSkills(dir);
  const llm = await pickLlm(args);
  const agentSkills = llm ? loadAgentSkills(dir, llm.make) : [];
  // NetOps preset (`--netops` / WEAVE_NETOPS=1): load ONLY the vendored forward-*
  // skills shipped in this repo (skills/<name>/SKILL.md) — reproducible, with no
  // dependency on the user's global ~/.claude/skills. CLAUDE_PLUGIN_ROOT points at the
  // package root so each skill's `${CLAUDE_PLUGIN_ROOT}/skills/<name>/scripts/...`
  // path resolves to the vendored copy (the bash tool inherits process.env).
  // A named agent (`--persona netops`) bundles its skills + grounding: selecting the netops
  // persona also loads the vendored forward-* skills, so `--persona netops` == `--netops`.
  const personaArg = str(args, "persona", "");
  const netops = has(args, "netops") || process.env.WEAVE_NETOPS === "1" || personaArg === "netops";
  if (netops) process.env.CLAUDE_PLUGIN_ROOT ??= PACKAGE_ROOT;
  // Claude Code skill dirs to scan: the vendored NetOps dir (when --netops), searched
  // FIRST so it wins name-dedup; PLUS the global dirs only when --claude-skills is set
  // (with --claude-skills-dir overriding which dir). Match keywords come from each
  // description; weave-native skill names already take precedence.
  const claudeDirs: string[] = [];
  if (netops) claudeDirs.push(join(PACKAGE_ROOT, "skills"));
  if (has(args, "claude-skills"))
    claudeDirs.push(...(has(args, "claude-skills-dir")
      ? [str(args, "claude-skills-dir", "")]
      : [join(process.cwd(), ".claude", "skills"), join(homedir(), ".claude", "skills")]));
  const seen = new Set([...codeSkills, ...agentSkills].map((s) => s.name));
  const claudeSkills: Skill[] = [];
  if (llm && claudeDirs.length) {
    for (const d of claudeDirs)
      for (const s of loadClaudeSkills(d, llm.make))
        if (!seen.has(s.name)) (seen.add(s.name), claudeSkills.push(s));
  }
  // Persona / grounding: point weave at a specific agent at launch. `--persona netops`
  // (the default under --netops) makes the catch-all + chat default the Forward NetOps agent
  // (grounded to the forward-* skills + scripts); any other non-empty --persona value is used
  // verbatim as that agent's system prompt; empty = the generic assistant.
  const persona = personaArg || (netops ? "netops" : "");
  const fallback: Skill = !llm
    ? echoSkill
    : persona === "netops"
      ? netopsAgentSkill(llm.make)
      : persona
        ? personaAgentSkill("agent", "Custom-persona agent (system prompt set at launch).", llm.make, persona)
        : claudeSkill(llm.make);
  // Pin-only, NO-TOOLS summarizer for the voice layer: it ingests untrusted result text, so it
  // must not be able to run tools (prevents prompt-injection → privilege escalation). tools: []
  // makes makeAgentSkill restrict its worker's tool host to nothing; match: [] = never auto-routes.
  const voiceSummary: Skill[] = llm
    ? [makeAgentSkill({ name: "voice-summary", description: "Verbalize a result for TTS (no tools).", prompt: VOICE_SUMMARY_SYSTEM, tools: [], match: [] }, llm.make(VOICE_SUMMARY_SYSTEM))]
    : [];
  const skills: Skill[] = [...codeSkills, ...agentSkills, ...claudeSkills, ...voiceSummary, fallback];

  const registry = new ToolRegistry();
  for (const s of skills) for (const t of s.tools ?? []) registry.register(t);
  registry.register(httpFetchTool); // generic HTTP capability
  if (opts.weave && opts.newId) registry.register(spawnTaskTool(opts.weave, opts.newId)); // fan-out
  registry.register(notifyTool(channelsFrom(channelConfig(args)))); // notifications
  // recall: search accumulated knowledge so skills/inference build on prior reports (ADR-0021 §4).
  registry.register(recallTool(reportsDirFor(args), pickEmbedder(args)));
  if (has(args, "bash") || netops) {
    // Shell access. Opt-in via --bash, and ALWAYS on under the NetOps preset: every forward-*
    // skill works by running `python3 .../scripts/*.py`, so without bash the agent can't make a
    // single Forward API call. Denylist always on; optional allowlist + timeout from flags.
    const allow = str(args, "bash-allow", "").split(",").map((s) => s.trim()).filter(Boolean);
    registry.register(
      bashTool({
        timeoutMs: num(args, "bash-timeout-ms", 30_000),
        ...(allow.length ? { allow } : {}),
      }),
    );
  }
  registry.register(readFileTool(process.cwd())); // read repo files (e.g. ADR auditor)
  registry.register(grepTool(process.cwd())); // scan/discover refs across the tree (read)
  registry.register(editFileTool(process.cwd())); // edit repo files — irreversible, grant-gated
  registry.register(writeSkillTool(dir)); // self-authoring (ADR-0017) — irreversible, grant-gated
  return { skills, registry, backend: llm?.kind ?? "none", errors };
}

/** Human-readable backend label. `backend === "none"` has two very different meanings — an
 *  intentional offline run (`--fake`) vs. no LLM found at all — and conflating them as "none"
 *  hides a costly first-run trap (the echo worker reports success for a no-op). Split them. */
const llmLabel = (backend: string, fake: boolean): string =>
  backend !== "none"
    ? backend
    : fake
      ? "echo (offline — --fake, no LLM)"
      : "echo (offline — NO BACKEND found; set ANTHROPIC_API_KEY or install the claude CLI)";

const fmt = (e: SealedEvent): string => {
  const base = `#${String(e.seq).padStart(4)} ${e.kind.padEnd(15)} ${e.actor.padEnd(12)} ${e.subject}`;
  // Surface progress notes in the live feed (up/log) — otherwise the feed shows *that* a worker made
  // progress but never *what* it did, dropping the most useful payload in a long-running turn.
  const note = (e.payload as Partial<ProgressPayload> | undefined)?.note;
  return e.kind === TaskKind.Progress && note ? `${base} — ${note}` : base;
};

async function readAll(weave: Substrate): Promise<SealedEvent[]> {
  const out: SealedEvent[] = [];
  for await (const e of weave.read(0)) out.push(e);
  return out;
}

// --- daemonize -------------------------------------------------------------

/** True when we are the already-detached child (set by the parent before re-spawn). */
const IS_DAEMON_CHILD = process.env.WEAVE_DAEMONIZED === "1";

/** Default pid/log paths sit next to the db: `.weave/weave.db` → `.weave/weave.{pid,log}`. */
function pidFileFor(args: Args): string {
  const explicitPid = args.flags.get("pid-file") as string | undefined;
  if (explicitPid) return explicitPid;
  const network = networkId(args);
  const explicitDb = args.flags.get("db") as string | undefined;
  return pidPathFor(network, explicitDb);
}
function logFileFor(args: Args): string {
  const explicitLog = args.flags.get("log-file") as string | undefined;
  if (explicitLog) return explicitLog;
  const network = networkId(args);
  const explicitDb = args.flags.get("db") as string | undefined;
  return logPathFor(network, explicitDb);
}

/**
 * Liveness of a pid via signal 0 (a probe that delivers nothing). "alive" = running and ours;
 * "stale" = no such process (ESRCH), so a leftover pidfile is safe to reclaim; "foreign" = exists
 * but owned by another user (EPERM), i.e. the pid was recycled and is NOT our peer.
 */
function pidLiveness(pid: number): "alive" | "stale" | "foreign" {
  try {
    process.kill(pid, 0);
    return "alive";
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "ESRCH" ? "stale" : "foreign";
  }
}

/**
 * Decide what to do when a peer may already be running under `pidFile`.
 * Returns `true` to proceed with daemonizing, `false` to abort (caller exits).
 */
function shouldDaemonize(pidFile: string): boolean {
  if (!existsSync(pidFile)) return true;
  const raw = readFileSync(pidFile, "utf8").trim();
  const pid = Number(raw);
  if (!Number.isInteger(pid) || pid <= 0) return true; // garbage pidfile → reclaim
  return pidLiveness(pid) === "stale"; // stale → reclaim; alive/foreign → refuse
}

/**
 * Re-spawn this process detached, redirecting output to `logFile`, and write `pidFile`.
 * The parent prints a summary and exits; the child re-enters `cmdUp` with the daemon
 * marker set, so it runs the normal foreground loop (now orphaned from the terminal).
 */
function daemonize(args: Args): void {
  const pidFile = pidFileFor(args);
  const logFile = logFileFor(args);
  if (!shouldDaemonize(pidFile)) {
    console.error(`weave: a peer already appears to be running (see ${pidFile}); aborting`);
    process.exit(1);
  }
  mkdirSync(dirname(pidFile), { recursive: true });
  mkdirSync(dirname(logFile), { recursive: true });
  const out = openSync(logFile, "a");
  // Reconstruct the relaunch argv. The two runtimes lay out argv differently:
  //  • node --import tsx: argv = [node, /path/cli.ts, <cmd...>]; execArgv carries `--import tsx`.
  //    The child needs execArgv + the real script path + the user args.
  //  • bun --compile:     argv = [bin, /$bunfs/root/<entry>, <cmd...>]; the binary re-injects
  //    its own entrypoint on launch, so we forward ONLY the user args (argv >= 2). Forwarding
  //    the bunfs path would make the child parse it as the command ("unknown command").
  const entry = process.argv[1] ?? "";
  const compiled = entry.includes("/$bunfs/") || entry.includes("~BUN");
  const userArgs = process.argv.slice(2);
  const childArgs = compiled ? userArgs : [...process.execArgv, entry, ...userArgs];
  const child = spawn(process.execPath, childArgs, {
    detached: true,
    stdio: ["ignore", out, out],
    // Tell the child where its pidfile is so it can clean up on graceful shutdown.
    env: { ...process.env, WEAVE_DAEMONIZED: "1", WEAVE_PID_FILE: pidFile },
  });
  writeFileSync(pidFile, String(child.pid));
  child.unref();
  const net = networkId(args) !== DEFAULT_NETWORK ? ` ${cyan(`[network: ${networkId(args)}]`)}` : "";
  console.log(`${green("✓")} peer running${net}\n`);
  console.log(`  ${gray("pid:")}   ${child.pid}`);
  console.log(`  ${gray("logs:")}  ${logFile}`);
  console.log(`  ${gray("stop:")}  weave down${networkId(args) !== DEFAULT_NETWORK ? ` --network-id ${networkId(args)}` : ""}\n`);
  process.exit(0);
}

// --- commands --------------------------------------------------------------

async function cmdUp(args: Args): Promise<void> {
  if (has(args, "daemon") && !IS_DAEMON_CHILD) return daemonize(args);
  setResilient(); // a transient per-task error must not kill the long-lived peer
  const weave = await openSubstrate(args);
  persistReports(weave, reportsDirFor(args), pickEmbedder(args)); // durable mirror + auto-index
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
      leaseMs: numPos(args, "lease-ms", 30_000),
      maxConcurrent: numPos(args, "concurrency", 2),
      tickMs: numPos(args, "tick-ms", 3_000),
    },
    newWorker: () => router,
    registry,
    clock: systemClock,
    newId: () => randomUUID(),
  });

  const net = networkId(args);
  const netBadge = net !== DEFAULT_NETWORK ? ` ${cyan(`[${net}]`)}` : "";
  console.log(`${green("✓")} peer "${agentId}" running${netBadge}`);
  console.log(`  ${gray("db:")}    ${dbPathFor(net, args.flags.get("db") as string | undefined)}`);
  console.log(`  ${gray("llm:")}   ${llmLabel(backend, has(args, "fake"))}`);
  console.log(`  ${gray("skills:")} ${skills.map((s) => s.name).join(", ")}\n`);
  // Loud about the silent no-op: with no real backend (and no --fake) every task is echoed, not run.
  if (backend === "none" && !has(args, "fake")) {
    console.error(yellow("weave: no LLM backend — tasks will be ECHOED, not actually run."));
    console.error(yellow("  → set ANTHROPIC_API_KEY, install Claude Code (`claude` on PATH), or pass --fake to acknowledge offline mode."));
  }
  weave.subscribe(0, (e) => console.log(fmt(e)));

  const ac = new AbortController();
  const keepAlive = setInterval(() => {}, 1 << 30);
  const compactSecs = has(args, "compact-secs") ? Math.max(5, numPos(args, "compact-secs", 60)) : 0;
  let compactTimer: ReturnType<typeof setInterval> | undefined;
  if (compactSecs > 0) {
    compactTimer = setInterval(() => {
      void compactWeave(weave, () => randomUUID(), agentId).then((r) => {
        if (r.pruned > 0) console.log(`weave: auto-compacted (folded ${r.settled}, pruned ${r.pruned})`);
      });
    }, compactSecs * 1000);
    if (typeof compactTimer.unref === "function") compactTimer.unref();
  }

  let shuttingDown = false;
  const shutdown = () => {
    // Second Ctrl-C while a graceful stop is already in flight → force-quit. Otherwise a peer wedged
    // mid-task would ignore repeated SIGINTs and the user would have to reach for `kill -9`.
    if (shuttingDown) {
      console.log("\nweave: force quit");
      process.exit(1);
    }
    shuttingDown = true;
    console.log("\nweave: shutting down… (Ctrl-C again to force quit)");
    clearInterval(keepAlive);
    if (compactTimer) clearInterval(compactTimer);
    // If we were daemonized, remove our own pidfile so it doesn't go stale.
    const pidFile = process.env.WEAVE_PID_FILE;
    if (pidFile) try { rmSync(pidFile, { force: true }); } catch { /* best-effort */ }
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

/** Stop a daemonized peer: read its pidfile, SIGTERM it, wait for it to exit. */
async function cmdDown(args: Args): Promise<void> {
  const net = networkId(args);
  const pidFile = pidFileFor(args);
  if (!existsSync(pidFile)) {
    const netMsg = net !== DEFAULT_NETWORK ? ` for ${cyan(net)}` : "";
    console.log(`${gray("─")} no peer running${netMsg}`);
    return;
  }
  const pid = Number(readFileSync(pidFile, "utf8").trim());
  if (!Number.isInteger(pid) || pid <= 0) {
    console.error(`${red("✗")} garbage pidfile; removing`);
    rmSync(pidFile, { force: true });
    process.exitCode = 1;
    return;
  }
  // Verify the pid is actually a weave peer before signalling it. A `kill -9` leaves the pidfile
  // behind; if the OS later recycles that pid for an unrelated process (an editor, another daemon),
  // a naive SIGTERM would kill the wrong thing. Treat stale/foreign/non-weave pids as a dead pidfile.
  const live = pidLiveness(pid);
  if (live === "stale") {
    console.log(`${yellow("ℹ")} pid ${pid} not running — clearing stale pidfile`);
    rmSync(pidFile, { force: true });
    return;
  }
  const cmdline = pidCommand(pid); // "" when `ps` is unavailable — then we can't disprove it, so allow
  if (live === "foreign" || (cmdline && !/weave/i.test(cmdline))) {
    console.error(`${red("✗")} pid ${pid} is not a weave peer (recycled pid?) — clearing stale pidfile, not signalling`);
    rmSync(pidFile, { force: true });
    process.exitCode = 1;
    return;
  }
  try {
    process.kill(pid, "SIGTERM"); // ask the peer to shut down (it removes its own pidfile)
  } catch (e) {
    if ((e as { code?: string }).code === "ESRCH") {
      console.log(`${yellow("ℹ")} pid ${pid} already gone — clearing stale file`);
      rmSync(pidFile, { force: true });
      return;
    }
    throw e;
  }
  // Wait up to ~3s for graceful exit, polling liveness with signal 0.
  for (let i = 0; i < 30; i++) {
    await new Promise((r) => setTimeout(r, 100));
    try { process.kill(pid, 0); } catch { console.log(`${green("✓")} stopped (pid ${pid})`); return; }
  }
  console.error(`${red("✗")} pid ${pid} did not exit; try: ${gray("kill -9")} ${pid}`);
  process.exitCode = 1;
}

/** Best-effort command line for a live pid (macOS/Linux `ps`); empty string if unavailable. Lets
 *  `weave ps` show *what* each peer is running (up / pool / loop --skill …), not just its pid. */
function pidCommand(pid: number): string {
  try {
    const r = spawnSync("ps", ["-p", String(pid), "-o", "command="], { timeout: 3000, encoding: "utf8" });
    return r.status === 0 ? r.stdout.trim() : "";
  } catch {
    return "";
  }
}

/**
 * List daemonized weave peers/pools by scanning the pidfiles that live next to the db
 * (`weave up` / `pool` / `loop --daemon` write `<dir>/<name>.pid` and remove it on graceful
 * shutdown). With network context, scans all networks. Read-only: probes liveness with signal 0.
 */
function cmdPs(args: Args): void {
  const allRows: Array<{ network: string; pidfile: string; pid: string; status: string; cmd: string }> = [];

  // Scan default network (.weave/weave.pid)
  const defaultPid = pidFileFor(args);
  if (existsSync(defaultPid)) {
    const raw = readFileSync(defaultPid, "utf8").trim();
    const pid = Number(raw);
    const status = Number.isInteger(pid) && pid > 0 ? pidLiveness(pid) : "invalid";
    allRows.push({
      network: "default",
      pidfile: "weave.pid",
      pid: Number.isInteger(pid) && pid > 0 ? String(pid) : raw || "?",
      status,
      cmd: status === "alive" ? pidCommand(pid) : "",
    });
  }

  // Scan all networks (.weave/networks/*/weave.pid)
  const networksDir = join(".weave", "networks");
  try {
    const networkDirs = readdirSync(networksDir, { withFileTypes: true }).filter((d) => d.isDirectory());
    for (const nd of networkDirs) {
      const netPid = join(networksDir, nd.name, "weave.pid");
      if (existsSync(netPid)) {
        const raw = readFileSync(netPid, "utf8").trim();
        const pid = Number(raw);
        const status = Number.isInteger(pid) && pid > 0 ? pidLiveness(pid) : "invalid";
        allRows.push({
          network: nd.name,
          pidfile: "weave.pid",
          pid: Number.isInteger(pid) && pid > 0 ? String(pid) : raw || "?",
          status,
          cmd: status === "alive" ? pidCommand(pid) : "",
        });
      }
    }
  } catch { /* no networks dir yet */ }

  if (allRows.length === 0) {
    console.log(`${gray("─")} no peers running`);
    return;
  }

  const wN = Math.max(7, ...allRows.map((r) => r.network.length));
  const wP = Math.max(3, ...allRows.map((r) => r.pid.length));
  const alive = allRows.filter((r) => r.status === "alive").length;
  console.log(`${green("─")} ${alive} running${alive < allRows.length ? `, ${allRows.length - alive} stale` : ""}\n`);
  console.log(`  ${cyan("NETWORK".padEnd(wN))}  ${cyan("PID".padStart(wP))}  STATUS   COMMAND`);
  for (const r of allRows) {
    const statusColor = r.status === "alive" ? green : red;
    console.log(`  ${r.network.padEnd(wN)}  ${r.pid.padStart(wP)}  ${statusColor(r.status.padEnd(7))}  ${gray(r.cmd || "")}`);
  }
}

/**
 * Process-pool supervisor: spawn N lightweight `weave up` peers as managed child processes,
 * restart any that crash (jittered backoff), and fan out SIGTERM on shutdown. The children
 * are autonomous peers that coordinate *work* through the shared weave (lease-based claiming,
 * ADR-0001/0002) — the supervisor only owns their lifecycle, never task assignment. Status is
 * already observable via `weave status` / `weave report`, which read the shared log.
 */
async function cmdPool(args: Args): Promise<void> {
  if (has(args, "daemon") && !IS_DAEMON_CHILD) return daemonize(args);
  setResilient(); // supervisor + workers must survive a transient per-task error

  const workers = numPos(args, "workers", 4);
  const db = str(args, "db", DEFAULT_DB);

  // Claim a pidfile so `weave down` can stop the whole pool via the supervisor. When we were
  // daemonized, daemonize() already wrote our pid and passed WEAVE_PID_FILE; else claim it now.
  const pidFile = IS_DAEMON_CHILD ? process.env.WEAVE_PID_FILE : pidFileFor(args);
  if (!IS_DAEMON_CHILD && pidFile) {
    if (!shouldDaemonize(pidFile)) {
      console.error(`weave: a peer/pool already appears to be running (see ${pidFile}); aborting`);
      process.exit(1);
    }
    mkdirSync(dirname(pidFile), { recursive: true });
    writeFileSync(pidFile, String(process.pid));
  }

  // Each child is a normal `weave up` peer. Reconstruct the launch argv per runtime, exactly as
  // daemonize() does (node --import tsx vs. bun --compile differ in how argv[1] is laid out).
  const entry = process.argv[1] ?? "";
  const compiled = entry.includes("/$bunfs/") || entry.includes("~BUN");
  const childEnv: NodeJS.ProcessEnv = { ...process.env };
  delete childEnv.WEAVE_DAEMONIZED; // children are managed, not detached
  delete childEnv.WEAVE_PID_FILE; // so a child's shutdown never deletes the pool's pidfile

  const upArgs = (agentId: string): string[] => {
    const out = ["up", "--agent", agentId];
    if (has(args, "db")) out.push("--db", db);
    for (const k of ["model", "concurrency", "lease-ms", "tick-ms", "compact-secs", "bash-allow", "bash-timeout-ms"]) {
      if (has(args, k)) out.push(`--${k}`, str(args, k, ""));
    }
    for (const k of ["fake", "claude-skills", "bash"]) if (has(args, k)) out.push(`--${k}`);
    return out;
  };

  interface Child {
    proc: ReturnType<typeof spawn>;
    restarts: number;
    startedAt: number;
  }
  const children = new Map<number, Child>();
  let shuttingDown = false;

  const launch = (slot: number): void => {
    if (shuttingDown) return;
    const agentId = `pool-${slot}-${randomUUID().slice(0, 4)}`;
    const userArgs = upArgs(agentId);
    const childArgs = compiled ? userArgs : [...process.execArgv, entry, ...userArgs];
    const proc = spawn(process.execPath, childArgs, { stdio: "inherit", env: childEnv });
    const prev = children.get(slot);
    children.set(slot, { proc, restarts: prev?.restarts ?? 0, startedAt: systemClock.now() });
    console.log(`weave: pool worker ${slot} → pid ${proc.pid} (${agentId})`);
    proc.on("exit", (code, signal) => {
      if (shuttingDown) return;
      const rec = children.get(slot);
      const ranMs = systemClock.now() - (rec?.startedAt ?? systemClock.now());
      // A worker that stayed up a while is healthy: reset its restart counter. Rapid exits
      // escalate the backoff so a permanently-broken worker can't spin-restart forever.
      const restarts = ranMs > 10_000 ? 1 : (rec?.restarts ?? 0) + 1;
      const delay = Math.min(30_000, 500 * 2 ** (restarts - 1));
      console.error(
        `weave: pool worker ${slot} (pid ${proc.pid}) exited (code ${code ?? "?"}, signal ${signal ?? "none"}); restarting in ${delay}ms [restart #${restarts}]`,
      );
      if (rec) children.set(slot, { ...rec, restarts });
      const t = setTimeout(() => launch(slot), delay);
      if (typeof t.unref === "function") t.unref();
    });
  };

  for (let i = 0; i < workers; i++) launch(i);
  console.log(`weave: pool up — ${workers} worker(s) on ${db}; stop with — weave down${has(args, "db") ? ` --db ${db}` : ""}`);

  const exited = (p: ReturnType<typeof spawn>): boolean => p.exitCode !== null || p.signalCode !== null;
  const shutdown = async (): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log("\nweave: pool shutting down… (SIGTERM to workers)");
    for (const { proc } of children.values()) try { proc.kill("SIGTERM"); } catch { /* already gone */ }
    // Wait up to ~5s for graceful exit, then SIGKILL any straggler.
    for (let i = 0; i < 50; i++) {
      if ([...children.values()].every((c) => exited(c.proc))) break;
      await new Promise((r) => setTimeout(r, 100));
    }
    for (const { proc } of children.values()) if (!exited(proc)) try { proc.kill("SIGKILL"); } catch { /* already gone */ }
    if (pidFile) try { rmSync(pidFile, { force: true }); } catch { /* best-effort */ }
    process.exit(0);
  };
  process.on("SIGINT", () => void shutdown());
  process.on("SIGTERM", () => void shutdown());

  await new Promise(() => {}); // supervise forever (until a signal triggers shutdown)
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
  const spec: { goal: string; skill?: string; model?: string } = { goal };
  if (has(args, "skill")) spec.skill = str(args, "skill", "");
  if (!has(args, "no-tier")) spec.model = modelForGoal(args, goal); // ADR-0022: route by complexity
  await declareTask(weave, () => randomUUID(), "cli", taskId, spec);
  console.log(`weave: declared ${taskId}${spec.skill ? ` [skill:${spec.skill}]` : ""}${spec.model ? ` [model:${spec.model}]` : ""} — ${goal}`);
  // A declared task sits `free` forever until a peer claims it. If none is running for this network,
  // the task silently does nothing — so nudge the user toward starting one (mirrors the daemon hints).
  const pf = pidFileFor(args);
  const peerAlive = existsSync(pf) && pidLiveness(Number(readFileSync(pf, "utf8").trim())) === "alive";
  if (!peerAlive) {
    const netArg = has(args, "network-id") ? ` --network-id ${networkId(args)}` : "";
    console.log(gray(`  → no peer running for this network; start one:  weave up${netArg}  (add --fake to run offline)`));
  }
  weave.close();
}

async function cmdLoop(args: Args): Promise<void> {
  const skill = str(args, "skill", "");
  if (!skill) {
    console.error('weave loop: --skill <name> required, e.g. weave loop --skill researcher --interval 6h "LLMs"');
    process.exitCode = 1;
    return;
  }
  setResilient(); // a transient per-tick error must not kill the loop daemon
  // Validate the invocation in the foreground first, then detach if asked: a bad --skill should
  // fail loudly in the terminal, not silently in a daemon log. The child re-enters here with the
  // daemon marker set and runs the normal loop, orphaned from the terminal (same as `weave up`).
  if (has(args, "daemon") && !IS_DAEMON_CHILD) return daemonize(args);
  const weave = await openSubstrate(args);
  persistReports(weave, reportsDirFor(args), pickEmbedder(args)); // durable mirror + auto-index
  const newId = () => randomUUID();
  const agentId = str(args, "agent", `loop-${randomUUID().slice(0, 8)}`);
  const goal = args._.join(" ").trim() || skill;
  const interval = str(args, "interval", "30s");
  const intervalMs = durationFlag(args, "interval", "30s"); // validate up front — bad value exits here
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
      leaseMs: numPos(args, "lease-ms", 60_000),
      maxConcurrent: numPos(args, "concurrency", 4),
      tickMs: numPos(args, "tick-ms", 2_000),
    },
    newWorker: () => new SkillRouterWorker(skills),
    registry,
    clock: systemClock,
    newId,
  });

  // In --once mode we declare exactly one task and exit when *it* settles. Capture its id so a
  // terminal event for some other peer's task on a shared db doesn't trip our shutdown.
  let onceTaskId: string | undefined;
  // Loops re-declare the same goal each tick, so classify the model once (ADR-0022).
  const loopModel = has(args, "no-tier") ? undefined : modelForGoal(args, goal);
  const tick = async (): Promise<void> => {
    const id = `${skill}-${randomUUID().slice(0, 8)}`;
    if (once) onceTaskId = id;
    await declareTask(weave, newId, agentId, id, { goal, skill, ...(loopModel ? { model: loopModel } : {}) });
  };

  console.log(`weave: loop "${skill}" every ${interval}${once ? " (once)" : ""} — ${goal}`);
  console.log(`weave: ${once ? "runs once — exits when the task settles" : "runs until interrupted (Ctrl-C, or `weave down` if daemonized)"}`);

  const ac = new AbortController();
  const keepAlive = setInterval(() => {}, 1 << 30);
  const loop = new LoopRunner(new SystemTimer(), tick, intervalMs, once);
  let stopping = false;
  const shutdown = (code = 0, reason = "stopped"): void => {
    if (stopping) return; // idempotent: a signal may race the once-completion
    stopping = true;
    console.log(`weave: loop "${skill}" ${reason} — exiting (code ${code})`);
    clearInterval(keepAlive);
    loop.stop();
    // If we were daemonized, remove our own pidfile so it doesn't go stale (mirrors `weave up`).
    const pidFile = process.env.WEAVE_PID_FILE;
    if (pidFile) try { rmSync(pidFile, { force: true }); } catch { /* best-effort */ }
    ac.abort();
    void peer.stop().then(() => {
      weave.close();
      process.exit(code);
    });
  };
  process.on("SIGINT", () => shutdown(0, "interrupted"));
  process.on("SIGTERM", () => shutdown(0, "terminated"));

  const notifyChannels = has(args, "notify") ? channelsFrom(channelConfig(args)) : [];
  weave.subscribe((await weave.head()) + 1, (e) => {
    if (e.kind !== TaskKind.Completed && e.kind !== TaskKind.Failed) return;
    const p = e.payload as { summary?: string; error?: string; artifacts?: unknown[] };
    console.log(`    ${e.actor.padEnd(14)} ${p.summary ?? p.error ?? e.subject}`);
    if (notifyChannels.length > 0 && e.kind === TaskKind.Completed && (p.artifacts?.length ?? 0) > 0) {
      void notifyAll(notifyChannels, { text: p.summary ?? e.subject });
    }
    // --once: the single declared task has settled — stop the peer and exit (non-zero on failure
    // so a one-shot job surfaces its outcome to the shell / daemon supervisor).
    if (once && e.subject === onceTaskId)
      shutdown(e.kind === TaskKind.Failed ? 1 : 0, e.kind === TaskKind.Failed ? "task failed" : "task done");
  });

  await loop.start();
  await peer.start(ac.signal);
}

async function cmdSkills(args: Args): Promise<void> {
  const { skills, backend, errors } = await assembleSkills(args, {
    fake: has(args, "fake"),
    model: str(args, "model", "claude-sonnet-4-6"),
  });
  for (const e of errors) console.error(`  ! ${e.file}: ${e.error}`);
  console.log(`weave skills (${skills.length}) [llm: ${llmLabel(backend, has(args, "fake"))}] — from .weave/skills/ + built-in:`);
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
  const configured = channelsFrom(channelConfig(args));
  let channels = configured;
  if (has(args, "to")) {
    const want = str(args, "to", "").split(",").map((s) => s.trim()).filter(Boolean);
    channels = configured.filter((c) => want.includes(c.name));
    // Distinguish "nothing configured" from "you asked for a channel that isn't configured/known" —
    // the old code reported the former for both, hiding a typo like `--to slakc`.
    if (channels.length === 0 && configured.length > 0) {
      const available = configured.map((c) => c.name).join(", ") || "(none)";
      console.error(`weave notify: none of --to "${want.join(", ")}" match a configured channel — available: ${available}`);
      process.exitCode = 1;
      return;
    }
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
  const print = (header: string, text: string): void => {
    console.log(`\n${header}`);
    console.log(full || text.length <= 800 ? text : `${text.slice(0, 800)}\n  …(${text.length} chars; --full for all)`);
  };
  const seen = new Set<string>();
  let shown = 0;
  for (const e of events) {
    if (e.kind !== TaskKind.Completed && e.kind !== TaskKind.Failed) continue;
    const p = e.payload as { summary?: string; error?: string };
    const text = (p.summary ?? p.error ?? "").trim();
    if (!text) continue;
    shown += 1;
    seen.add(e.subject);
    print(`${e.kind === TaskKind.Failed ? "✗" : "✓"} ${e.subject} (${e.actor})`, text);
  }
  // Surface persisted results whose completion events were pruned by compaction (ADR-0007), so the
  // accumulated knowledge stays visible. Files are the OKF bundle written by persistReports(): walk
  // the per-skill subdirs, skip the reserved index.md/log.md, and dedup against the live log by task_id.
  const dir = reportsDirFor(args);
  for (const file of okfConceptFiles(dir)) {
    const content = readFileSync(file, "utf8");
    const subject = /^task_id:\s*(.+)$/m.exec(content)?.[1]?.trim() ?? "";
    if (subject && seen.has(subject)) continue; // already shown from the live log
    shown += 1;
    print(`📄 ${subject || file} (persisted)`, content.trim());
  }
  if (shown === 0) console.log("weave: no results yet");
  weave.close();
}

/** All OKF concept files in a bundle: every `.md` under per-skill subdirs except reserved names. */
function okfConceptFiles(reportsDir: string): string[] {
  const out: string[] = [];
  let skillDirs: string[];
  try {
    skillDirs = readdirSync(reportsDir, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name);
  } catch {
    return out;
  }
  for (const skill of skillDirs) {
    let files: string[];
    try {
      files = readdirSync(join(reportsDir, skill));
    } catch {
      continue;
    }
    for (const f of files) if (f.endsWith(".md") && f !== "index.md" && f !== "log.md") out.push(join(reportsDir, skill, f));
  }
  return out;
}

// --- knowledge index: graph + search (ADR-0020/0021) ----------------------

const GRAPH_MARK = "<!-- weave:graph -->"; // sentinel: everything from here to EOF is generated

interface BundleDoc {
  id: string; // task_id
  relPath: string; // bundle-relative
  file: string; // absolute path
  skill: string;
  status: string;
  timestamp: string;
  title: string;
  tags: string[];
  parent?: string;
  body: string; // concept body without frontmatter or the generated graph block
}

/** Read one frontmatter scalar (our writer emits simple `key: value` / `key: "value"` lines). */
function fmField(fm: string, key: string): string {
  const m = new RegExp(`^${key}:\\s*(.+)$`, "m").exec(fm);
  if (!m?.[1]) return "";
  return m[1].trim().replace(/^"(.*)"$/, "$1").replace(/\\"/g, '"');
}

/** Parse every concept file in the bundle into a BundleDoc (frontmatter split from body). */
function readBundle(reportsDir: string): BundleDoc[] {
  const docs: BundleDoc[] = [];
  for (const file of okfConceptFiles(reportsDir)) {
    const raw = readFileSync(file, "utf8");
    const fmMatch = /^---\n([\s\S]*?)\n---\n?/.exec(raw);
    const fm = fmMatch?.[1] ?? "";
    let body = fmMatch ? raw.slice(fmMatch[0].length) : raw;
    const markIdx = body.indexOf(GRAPH_MARK); // strip previously generated link block
    if (markIdx >= 0) body = body.slice(0, markIdx);
    const id = fmField(fm, "task_id") || file;
    const tags = (/^tags:\s*\[(.*)\]/m.exec(fm)?.[1] ?? "").split(",").map((t) => t.trim()).filter(Boolean);
    const parent = fmField(fm, "parent");
    docs.push({
      id,
      relPath: file.slice(reportsDir.length + 1),
      file,
      skill: fmField(fm, "skill") || "misc",
      status: fmField(fm, "status") || "completed",
      timestamp: fmField(fm, "timestamp"),
      title: fmField(fm, "title") || id,
      tags,
      ...(parent ? { parent } : {}),
      body: body.trim(),
    });
  }
  return docs;
}

/** Extract outgoing references from a concept body: bundle links / weave://task ids → report ids,
 *  external URLs → sources, local repo paths → artifacts. */
function extractFacts(doc: BundleDoc, relToId: Map<string, string>): Pick<ReportInput, "links" | "sources" | "artifacts"> {
  const links = new Set<string>();
  for (const m of doc.body.matchAll(/weave:\/\/task\/([\w-]+)/g)) if (m[1] && m[1] !== doc.id) links.add(m[1]);
  for (const m of doc.body.matchAll(/\]\((?:\/)?((?:[\w.-]+\/)*[\w.-]+\.md)\)/g)) {
    const id = relToId.get(m[1] ?? "") ?? relToId.get((m[1] ?? "").replace(/^\//, ""));
    if (id && id !== doc.id) links.add(id);
  }
  const sources = new Set<string>();
  for (const m of doc.body.matchAll(/https?:\/\/[^\s)\]<>"]+/g)) sources.add(m[0].replace(/[.,]$/, ""));
  const artifacts = new Set<string>();
  for (const m of doc.body.matchAll(/(?:^|[\s(`])((?:nqe|src|docs|scripts)\/[\w./*-]+|\.weave\/[\w./-]+)/g)) if (m[1]) artifacts.add(m[1]);
  return { links: [...links], sources: [...sources], artifacts: [...artifacts] };
}

/** Build the knowledge graph from the bundle on disk (pure facts → domain buildGraph). */
function bundleGraph(reportsDir: string, docs: BundleDoc[]): KnowledgeGraph {
  const relToId = new Map(docs.map((d) => [d.relPath, d.id]));
  const inputs: ReportInput[] = docs.map((d) => ({
    id: d.id,
    relPath: d.relPath,
    skill: d.skill,
    status: d.status,
    timestamp: d.timestamp,
    title: d.title,
    tags: d.tags,
    ...(d.parent ? { parent: d.parent } : {}),
    ...extractFacts(d, relToId),
  }));
  return buildGraph(inputs);
}

const SUBDIR = ".index"; // cache dir inside the bundle (vectors)

/** Embed any docs whose content isn't cached, persist the cache, return id → vector for all docs. */
async function embedDocs(reportsDir: string, docs: BundleDoc[], embedder: Embedder): Promise<Map<string, number[]>> {
  const cacheFile = join(reportsDir, SUBDIR, "vectors.json");
  let cache: { model: string; byText: Record<string, number[]> } = { model: embedder.model, byText: {} };
  try {
    const prev = JSON.parse(readFileSync(cacheFile, "utf8"));
    if (prev.model === embedder.model) cache = prev;
  } catch { /* no/!stale cache */ }
  const textOf = (d: BundleDoc) => `${d.title}\n${d.body}`.slice(0, 8000);
  const missing = docs.filter((d) => !cache.byText[textOf(d)]);
  if (missing.length > 0) {
    const vecs = await embedder.embed(missing.map(textOf));
    missing.forEach((d, i) => { const v = vecs[i]; if (v) cache.byText[textOf(d)] = v; });
    mkdirSync(join(reportsDir, SUBDIR), { recursive: true });
    writeFileSync(cacheFile, JSON.stringify(cache));
  }
  const out = new Map<string, number[]>();
  for (const d of docs) { const v = cache.byText[textOf(d)]; if (v) out.set(d.id, v); }
  return out;
}

/** Rebuild the knowledge index: graph.json + graph.md + inline link sections, and warm the vector
 *  cache when an embedder is configured. Pure-derived from the bundle, so it's idempotent. */
async function indexBundle(reportsDir: string, embedder: Embedder | null): Promise<{ docs: number; edges: number }> {
  const docs = readBundle(reportsDir);
  const graph = bundleGraph(reportsDir, docs);
  const byId = new Map(docs.map((d) => [d.id, d]));
  const label = (id: string) => byId.get(id)?.title ?? id.replace(/^(source|artifact):/, "");
  const linkTo = (id: string) => (byId.has(id) ? `/${byId.get(id)!.relPath}` : id.startsWith("source:") ? id.slice(7) : id.slice(9));

  // graph.json — machine-queryable.
  mkdirSync(reportsDir, { recursive: true });
  writeFileSync(join(reportsDir, "graph.json"), JSON.stringify(graph, null, 2));

  // graph.md — human overview: hubs (by total degree) and orphans.
  const deg = new Map<string, number>();
  for (const e of graph.edges) {
    deg.set(e.from, (deg.get(e.from) ?? 0) + 1);
    deg.set(e.to, (deg.get(e.to) ?? 0) + 1);
  }
  const reports = graph.nodes.filter((n) => n.type === "report");
  const hubs = [...reports].sort((a, b) => (deg.get(b.id) ?? 0) - (deg.get(a.id) ?? 0)).slice(0, 10);
  const orphans = reports.filter((n) => (deg.get(n.id) ?? 0) === 0);
  const graphMd =
    `# Knowledge Graph\n\n${reports.length} reports · ${graph.nodes.length} nodes · ${graph.edges.length} edges.\n\n` +
    `## Hubs (most connected)\n\n` +
    (hubs.map((n) => `- [${displayTitle(n.label)}](/${n.relPath}) — ${deg.get(n.id) ?? 0} links`).join("\n") || "- none") +
    `\n\n## Orphans (no links)\n\n` +
    (orphans.map((n) => `- [${displayTitle(n.label)}](/${n.relPath})`).join("\n") || "- none") +
    "\n";
  writeFileSync(join(reportsDir, "graph.md"), graphMd);

  // Inline link sections (regenerated after the GRAPH_MARK sentinel). The "other end" of each edge
  // is computed from the doc's own id. Forward links stay navigation-focused (reports + artifacts);
  // external citations live in graph.json, and co-citation/tag overlaps surface under Related.
  const fmtEdges = (selfId: string, edges: readonly GraphEdge[]) =>
    edges.map((e) => { const other = e.from === selfId ? e.to : e.from; return `- [${displayTitle(label(other))}](${linkTo(other)}) _(${e.type})_`; }).join("\n");
  for (const d of docs) {
    const nb = neighbours(graph, d.id);
    const fwd = nb.forward.filter((e) => e.type !== "cites"); // citations → graph.json, not inline
    const sections: string[] = [];
    if (fwd.length) sections.push(`## Forward links\n\n${fmtEdges(d.id, fwd)}`);
    if (nb.back.length) sections.push(`## Backlinks\n\n${fmtEdges(d.id, nb.back)}`);
    if (nb.related.length) sections.push(`## Related\n\n${fmtEdges(d.id, nb.related)}`);
    const raw = readFileSync(d.file, "utf8");
    const markIdx = raw.indexOf(GRAPH_MARK);
    const base = (markIdx >= 0 ? raw.slice(0, markIdx) : raw).trimEnd();
    const block = sections.length ? `\n\n${GRAPH_MARK}\n\n${sections.join("\n\n")}\n` : `\n`;
    writeFileSync(d.file, base + block);
  }

  if (embedder) {
    try { await embedDocs(reportsDir, docs, embedder); } catch (e) { console.error(`weave: embedding skipped — ${(e as Error).message}`); }
  }
  return { docs: docs.length, edges: graph.edges.length };
}

interface SearchHit extends Scored {
  doc: BundleDoc;
  related: string[]; // titles of graph neighbours (retrieval-augmented navigation)
}

/** Hybrid search the bundle: BM25 always, blended with cached/query embeddings when available. Each
 *  hit is augmented with its graph neighbours so inference can follow the knowledge graph. */
async function searchBundle(reportsDir: string, query: string, embedder: Embedder | null, limit: number): Promise<SearchHit[]> {
  const docs = readBundle(reportsDir);
  if (docs.length === 0) return [];
  const lexical = bm25Search(buildBm25(docs.map((d) => ({ id: d.id, text: `${d.title}\n${d.body}` }))), query, Math.max(limit * 3, 20));
  let semantic: Scored[] = [];
  if (embedder) {
    try {
      const [qv] = await embedder.embed([query]);
      if (qv) {
        const vecs = await embedDocs(reportsDir, docs, embedder);
        semantic = [...vecs.entries()].map(([id, v]) => ({ id, score: cosine(qv, v) }));
      }
    } catch (e) { console.error(`weave: semantic search skipped — ${(e as Error).message}`); }
  }
  const ranked = hybridRank(lexical, semantic, 0.5, limit);
  const byId = new Map(docs.map((d) => [d.id, d]));
  const graph = bundleGraph(reportsDir, docs);
  return ranked.flatMap((s) => {
    const doc = byId.get(s.id);
    if (!doc) return [];
    const nb = neighbours(graph, s.id);
    const related = [...nb.forward, ...nb.back, ...nb.related]
      .map((e) => byId.get(e.from === s.id ? e.to : e.from)?.title)
      .filter((t): t is string => !!t);
    return [{ ...s, doc, related: [...new Set(related)].slice(0, 5) }];
  });
}

async function cmdIndex(args: Args): Promise<void> {
  const dir = reportsDirFor(args);
  const embedder = pickEmbedder(args);
  const { docs, edges } = await indexBundle(dir, embedder);
  console.log(`weave: indexed ${docs} report(s), ${edges} edge(s) → ${join(dir, "graph.json")}, graph.md, inline links${embedder ? ` (+ embeddings: ${embedder.model})` : ""}`);
}

async function cmdSearch(args: Args): Promise<void> {
  const query = args._.join(" ").trim();
  if (!query) {
    console.error('weave search: provide a query, e.g. weave search "TI-LFA reconvergence"');
    process.exitCode = 1;
    return;
  }
  const limit = numPos(args, "limit", 8);
  const embedder = pickEmbedder(args);
  const hits = await searchBundle(reportsDirFor(args), query, embedder, limit);
  if (hits.length === 0) {
    console.log(`weave: no matches for "${query}"`);
    return;
  }
  console.log(`weave: ${hits.length} match(es) for "${query}"${embedder ? " [hybrid]" : " [bm25]"}\n`);
  for (const h of hits) {
    console.log(`  ${h.score.toFixed(3)}  ${h.doc.title.length > 90 ? `${h.doc.title.slice(0, 89)}…` : h.doc.title}`);
    console.log(`         /${h.doc.relPath}`);
    if (h.related.length) console.log(`         ↪ related: ${h.related.map((t) => (t.length > 40 ? `${t.slice(0, 39)}…` : t)).join("; ")}`);
  }
}

/** `recall`: a knowledge-search tool so skills/inference can retrieve prior reports before working
 *  (ADR-0021 §4). Reads the bundle, returns hybrid hits + graph neighbours as structured output. */
function recallTool(reportsDir: string, embedder: Embedder | null): ToolDefinition {
  return {
    name: "recall",
    description: "Search accumulated knowledge (prior task reports) before researching: { query, limit? }.",
    effect: "read",
    inputSchema: { query: "string", limit: "number?" },
    execute: async (args) => {
      const query = String(args["query"] ?? "").trim();
      if (!query) return { ok: false, output: { error: "query required" } };
      const limit = typeof args["limit"] === "number" ? args["limit"] : 5;
      const hits = await searchBundle(reportsDir, query, embedder, limit);
      return {
        ok: true,
        output: {
          hits: hits.map((h) => ({ taskId: h.doc.id, title: h.doc.title, path: `/${h.doc.relPath}`, score: Number(h.score.toFixed(4)), related: h.related, excerpt: h.doc.body.slice(0, 600) })),
        },
      };
    },
  };
}

// --- chat: a conversational REPL over the weave (thin client; ADR-0002 §2) -----------------
//
// `weave chat` is a Siri-like front door: it reads a line, declares it as a task, and waits for a
// running peer (a `weave up` daemon) to answer — mirroring the daemon's claim/progress events into a
// live "thinking" line so the wait feels responsive rather than opaque. It does NO work itself
// (thin client): if no peer is running, the turn times out with a hint to start one.

interface ChatTurn {
  readonly q: string;
  readonly a: string;
}

/**
 * Assemble the goal string for one chat turn. Routing matches on the goal (specific skills before
 * the `claude` catch-all), so the current utterance LEADS — it's what the keyword matcher keys on —
 * and prior turns follow as a clearly-delimited, truncated trailer the LLM reads for context.
 *
 * This is the heart of the "context carried" behaviour: how much history to include and how to frame
 * it trades follow-up quality against prompt growth and mis-routing risk. The defaults keep the last
 * few turns within a character budget; tune `maxTurns`/`maxChars` to taste.
 */
function buildChatGoal(utterance: string, history: readonly ChatTurn[], networkContext?: string, maxTurns = 4, maxChars = 1500): string {
  let goal = utterance;
  if (networkContext) goal = `[Network context: ${networkContext}] ${goal}`;
  if (history.length === 0) return goal;
  let ctx = "";
  for (const turn of history.slice(-maxTurns)) {
    const a = turn.a.length > 400 ? `${turn.a.slice(0, 397)}…` : turn.a;
    const block = `Q: ${turn.q}\nA: ${a}\n\n`;
    if (ctx.length + block.length > maxChars) break;
    ctx += block;
  }
  if (!ctx) return goal;
  return `${goal}\n\n--- Earlier in this conversation (context only; answer the request above) ---\n\n${ctx.trimEnd()}`;
}

const SPINNER = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

/** Run one chat turn: declare the goal, mirror the answering peer's progress to a live status line,
 *  and resolve with the settled summary. Thin client — a separate peer does the actual work. */
function chatTurn(
  weave: Substrate,
  newId: () => string,
  actor: string,
  goal: string,
  pinnedSkill: string | undefined,
  model: string | undefined,
  timeoutMs: number,
  signal: AbortSignal | undefined,
  onProgress?: (note: string) => void, // streamed answer text / status notes (voice TTS streaming)
  utterance?: string, // original user utterance (for learning tracking)
  networkId?: string, // network context (for learning tracking)
): Promise<{ answer: string; ok: boolean; cancelled: boolean }> {
  return new Promise((resolve) => {
    const id = `chat-${randomUUID().slice(0, 8)}`;
    const spec: { goal: string; skill?: string; model?: string } = { goal };
    if (pinnedSkill) spec.skill = pinnedSkill;
    if (model) spec.model = model; // ADR-0022: per-turn tier (cheap for chat, escalates on hard asks)

    // Extract original utterance for learning (strip network context prefix like "[Network context: network 111]")
    const rawUtterance = utterance?.replace(/^\[Network context: network \d+\]\s*/, "") ?? goal.split("\n")[0] ?? goal;
    const qStartTime = systemClock.now();

    // Learning: track the question
    if (utterance && networkId) {
      const intent = classifyIntent(rawUtterance);
      const persona = pinnedSkill === "netops" ? "netops" : "general";
      void declareQuestion(weave, newId, actor, id, rawUtterance, intent, networkId, persona);
    }

    let detail = "thinking";
    let claimed = false;
    let frame = 0;
    let done = false;
    let subscription: { unsubscribe(): void } | undefined;
    let seenProgress = new Map<string, number>(); // track count per note
    let lastProgressLine = ""; // track last progress note to avoid reprinting
    let lastProgressTime = 0; // track when we last printed a progress note
    const PROGRESS_DEBOUNCE_MS = 1000; // don't reprint identical notes more often than this
    const MAX_NOTE_REPEATS = 3; // stop showing a note after N repeats
    const t0 = systemClock.now();

    // Animate a "thinking" line (with elapsed seconds, so a slow real-LLM turn doesn't look hung)
    // only on a real terminal; piped/logged stdout gets no ANSI noise.
    const tty = process.stdout.isTTY === true;
    const draw = () => {
      if (!tty) return;
      const secs = Math.round((systemClock.now() - t0) / 1000);
      process.stdout.write(`\r  ${SPINNER[frame++ % SPINNER.length]} ${detail}… ${secs}s  (Ctrl-C to cancel)\x1b[K`);
    };
    const spin = tty ? setInterval(draw, 120) : undefined;
    draw();

    const finish = (answer: string, ok: boolean, cancelled = false): void => {
      if (done) return;
      done = true;
      if (spin) clearInterval(spin);
      clearTimeout(timer);
      clearTimeout(hint);
      signal?.removeEventListener("abort", onAbort);
      subscription?.unsubscribe();

      // Learning: record resolution outcome
      if (utterance && networkId && !cancelled) {
        const durationMs = systemClock.now() - qStartTime;
        // Count follow-ups: if this is in history and the previous turn was the same question
        // (simplified: just mark as resolved for now, follow-up counting would need history passed in)
        const followUps = 0; // TODO: track if user asks follow-up questions
        const resolved = ok;
        const skill = pinnedSkill ?? "unknown";
        void resolveQuestion(weave, newId, actor, id, durationMs, followUps, resolved, skill);
      }

      if (tty) {
        process.stdout.write("\r\x1b[K"); // wipe the spinner line
        if (lastProgressLine) {
          // reprint last progress line in dim color so it persists
          process.stdout.write(`${dim("  ── " + lastProgressLine)}\n`);
        }
      }
      resolve({ answer, ok, cancelled });
    };

    // Ctrl-C / "stop" during a turn cancels for real: emit a terminal `task.cancel` so the holding
    // peer aborts its worker and the task is never re-claimed (weave's async stop), then return to
    // the prompt. Fire-and-forget — we don't wait for the peer to acknowledge.
    const requestCancel = (): void => {
      void weave
        .append({ id: newId(), kind: TaskKind.Cancel, actor, subject: id, payload: { reason: "user-stop" } })
        .catch(() => {}); // best effort; the abort already frees the local wait
    };
    const onAbort = () => { requestCancel(); finish("stopped.", false, true); };
    if (signal) {
      if (signal.aborted) return finish("stopped.", false, true);
      signal.addEventListener("abort", onAbort);
    }

    const hint = setTimeout(() => {
      if (!claimed && !done) detail = "waiting for a peer to pick this up (is `weave up` running?)";
    }, 8000);
    let timer: NodeJS.Timeout | undefined;
    const timerStart = systemClock.now();

    function resetTimer(): void {
      if (timer) clearTimeout(timer);
      const elapsed = systemClock.now() - timerStart;
      const remaining = timeoutMs - elapsed;
      if (remaining > 5000) { // only reset if meaningful time remains
        timer = setTimeout(() => {
          finish(
            claimed
              ? "the task didn't finish in time — try a simpler ask, or raise --timeout."
              : "no peer answered. Start one in another terminal: `weave up` (or `weave up --daemon`).",
            false,
          );
        }, remaining);
      }
    }
    resetTimer(); // initial timeout

    // Subscribe from head+1 BEFORE declaring, so an instant completion can't slip past the listener.
    void weave.head().then((head) => {
      if (done) return; // cancelled/timed out before we got here
      subscription = weave.subscribe(head + 1, (e) => {
        if (e.subject !== id) return;
        switch (e.kind) {
          case TaskKind.Claimed:
            claimed = true;
            const skillName = e.actor.replace(/^(chat-|voice-|peer-)/, "");
            detail = skillName ? `skill: ${skillName}` : `working (${e.actor})`;
            if (tty) {
              process.stdout.write(`\r\x1b[K  ${dim(`→ ${skillName}`)}\n`); // show which skill claimed
              draw();
            }
            break;
          case TaskKind.Progress: {
            const note = (e.payload as ProgressPayload).note;
            detail = note;
            onProgress?.(note); // feed the live answer stream to a voice speaker, if any
            // Reset timeout on each progress note (incremental progress gets more time)
            resetTimer();
            // Print progress notes on their own line (TTY only), keep last for finish()
            // Dedupe: skip if we've seen this note too many times, or printed very recently
            const now = systemClock.now();
            const count = (seenProgress.get(note) ?? 0) + 1;
            seenProgress.set(note, count);
            const tooSoon = now - lastProgressTime < PROGRESS_DEBOUNCE_MS;
            const tooManyRepeats = count > MAX_NOTE_REPEATS;
            if (tty && !tooSoon && !tooManyRepeats) {
              process.stdout.write(`\r\x1b[K  ${cyan(note)}\n`); // clear spinner, print note
              lastProgressLine = note;
              lastProgressTime = now;
              draw(); // restore spinner
            } else if (tty && tooManyRepeats && count === MAX_NOTE_REPEATS + 1) {
              // Warn once when we start suppressing repeats
              process.stdout.write(`\r\x1b[K  ${dim("(suppressing repeated progress notes)")}\n`);
              draw();
            }
            break;
          }
          case TaskKind.Completed:
            finish((e.payload as { summary?: string }).summary ?? "(done, no summary)", true);
            break;
          case TaskKind.Failed: {
            const p = e.payload as { summary?: string; error?: string };
            finish(p.summary ?? p.error ?? "(failed)", false);
            break;
          }
        }
      });
      void declareTask(weave, newId, actor, id, spec);
    });
  });
}

/** Wall-clock stamp HH:MM:SS.mmm for voice logs, so you can read the gap between interactions. */
function tstamp(): string { return new Date(systemClock.now()).toISOString().slice(11, 23); }

/** A "rich" answer (markdown, tables, hop lists, or raw IPs) reads terribly aloud — summarize it
 *  for speech instead of speaking it verbatim. Plain short answers are spoken as-is. */
function looksRich(t: string): boolean {
  return t.length > 220 || /\d{1,3}(\.\d{1,3}){3}/.test(t) || /[|`#]|\n[-*]\s|\n\s*\n/.test(t);
}

/** Offline text-to-speech via macOS `say` (zero new dependency, works offline — matches
 *  weave's ethos). Returns a speaker that voices text (markdown stripped). Two entry points:
 *   • `speak(t)` — interrupting: drops any queued/in-flight speech and says `t` now.
 *   • `enqueue(t)` — appends `t` to a FIFO that plays back-to-back without gaps. This is what
 *     lets the answer stream out sentence-by-sentence as the LLM produces it (time-to-first-audio
 *     drops from full-completion to the first sentence) instead of one big utterance at the end.
 *  `stop()` clears the queue and kills in-flight speech (new turn / Ctrl-C / barge-in). `done()`
 *  resolves when the queue has fully drained — callers await it before re-opening the mic so the
 *  TTS output isn't captured and re-transcribed (the echo bug). No-op + one warning off macOS. */
function makeSpeaker(enabled: boolean, voice?: string): { speak: (t: string) => void; enqueue: (t: string) => void; stop: () => void; done: () => Promise<void>; speaking: () => boolean } {
  const noop = { speak: () => {}, enqueue: () => {}, stop: () => {}, done: () => Promise.resolve(), speaking: () => false };
  if (!enabled) return noop;
  if (process.platform !== "darwin") {
    console.error("weave: --speak needs macOS `say` (offline TTS); voice output disabled.");
    return noop;
  }
  // Default to a female voice ("Karen", en_AU). `say -v '?'` lists installed voices; "Samantha"
  // (en_US) is another solid default, premium "Ava"/"Zoe" need a download. Override with
  // --voice <name>; --voice "" = system default.
  const vArgs = voice ? ["-v", voice] : [];
  const clean = (text: string): string =>
    text
      .replace(/```[\s\S]*?```/g, ". code block. ") // skip code fences
      .replace(/`([^`]+)`/g, "$1") // inline code
      .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1") // links -> label
      .replace(/https?:\/\/\S+/g, "a link")
      .replace(/[*_#>|]/g, "") // markdown punctuation
      .replace(/\s+/g, " ").trim();

  let proc: ReturnType<typeof spawn> | null = null;
  const queue: string[] = [];
  let waiters: Array<() => void> = [];
  const settleIfIdle = (): void => {
    if (proc || queue.length > 0) return;
    const w = waiters; waiters = []; for (const f of w) f();
  };
  const playNext = (): void => {
    if (proc) return;
    const next = queue.shift();
    if (next === undefined) { settleIfIdle(); return; }
    try {
      proc = spawn("say", vArgs, { stdio: ["pipe", "ignore", "ignore"] });
      proc.on("error", () => { proc = null; playNext(); });
      proc.on("close", () => { proc = null; playNext(); });
      proc.stdin?.end(next);
    } catch { proc = null; playNext(); }
  };
  const stop = (): void => {
    queue.length = 0;
    if (proc) { const p = proc; proc = null; p.kill("SIGTERM"); }
    settleIfIdle();
  };
  const enqueue = (text: string): void => {
    const c = clean(text);
    if (!c) return;
    queue.push(c);
    playNext();
  };
  const speak = (text: string): void => { stop(); enqueue(text); }; // interrupt, then say
  const done = (): Promise<void> =>
    !proc && queue.length === 0 ? Promise.resolve() : new Promise((res) => waiters.push(res));
  const speaking = (): boolean => proc !== null || queue.length > 0; // audio is (or is about to be) playing
  return { speak, enqueue, stop, done, speaking };
}

/** Record from the macOS mic (avfoundation) until Enter, end-of-speech (VAD), or maxSecs, then
 *  transcribe with whisper-cli. Returns the cleaned transcript ("" on silence/failure).
 *  `awaitEnter` lets the caller's readline signal an early stop. When `vadFilter` is set, ffmpeg's
 *  silencedetect logs trailing silence and we stop automatically — so you don't wait out maxSecs. */
async function recordAndTranscribe(o: {
  awaitEnter: () => Promise<void>;
  micDevice: string; model: string; whisper: string; maxSecs: number;
  debug?: boolean; quiet?: boolean; vadFilter?: string; // vadFilter: ffmpeg silencedetect=…
  initialSilenceSecs?: number; // best-effort: stop early if no speech onset within this window
}): Promise<string> {
  const wav = join(tmpdir(), `weave-voice-${randomUUID().slice(0, 8)}.wav`);
  const prefix = wav.replace(/\.wav$/, "");
  const t0 = systemClock.now();
  const ffArgs = ["-y", "-f", "avfoundation", "-i", o.micDevice, "-ac", "1", "-ar", "16000"];
  if (o.vadFilter) ffArgs.push("-af", o.vadFilter); // analysis-only pass-through; wav still recorded
  ffArgs.push("-t", String(o.maxSecs), wav);
  const ff = spawn("ffmpeg", ffArgs, { stdio: ["pipe", "ignore", o.vadFilter ? "pipe" : "ignore"] });
  let ffErr = false;
  ff.on("error", () => { ffErr = true; });
  let stopped = false;
  const stopRec = (): void => { if (stopped) return; stopped = true; try { ff.stdin?.write("q"); } catch { /* gone */ } };
  // Best-effort "you never spoke" fast-exit: a silence_end marks speech onset (silence broke), so
  // if we see none within initialSilenceSecs we stop rather than waiting out maxSecs (~20s).
  let speechSeen = false;
  const initTimer = o.initialSilenceSecs && o.initialSilenceSecs > 0
    ? setTimeout(() => { if (!speechSeen) stopRec(); }, o.initialSilenceSecs * 1000)
    : null;
  if (o.vadFilter && ff.stderr) {
    // Stop on the LAST silence_start past a small floor: ignores leading silence (ts≈0) and
    // triggers ~`d` seconds after you actually stop talking.
    let buf = "";
    ff.stderr.on("data", (d: Buffer) => {
      buf += d.toString();
      if (buf.includes("silence_end")) speechSeen = true; // speech broke a prior silence
      const ms = [...buf.matchAll(/silence_start: ([0-9.]+)/g)];
      const last = ms[ms.length - 1];
      if (last?.[1] && parseFloat(last[1]) >= 0.8) stopRec();
      if (buf.length > 8000) buf = buf.slice(-2000);
    });
  }
  if (!o.quiet) process.stdout.write(`  ● listening… speak now${o.vadFilter ? " (auto-stops when you pause" : " (Enter to stop"} · ${o.maxSecs}s max)\n`);
  const exited = new Promise<void>((res) => ff.on("close", () => res()));
  void o.awaitEnter().then(() => stopRec());
  await exited;
  if (initTimer) clearTimeout(initTimer);
  if (ffErr) { console.error("  ! ffmpeg not available (brew install ffmpeg) — cannot record."); return ""; }
  const tRec = systemClock.now();
  // Async spawn (not spawnSync): whisper inference can run a few seconds and we must NOT freeze the
  // event loop — the spinner, the TTS queue, and progress streaming all need to keep ticking.
  const wr = await new Promise<{ status: number | null; stdout: string; stderr: string }>((res) => {
    const p = spawn(o.whisper, ["-m", o.model, "-f", wav, "-l", "en", "-nt", "-np", "-otxt", "-of", prefix], { stdio: ["ignore", "pipe", "pipe"] });
    let out = "", err = "";
    p.stdout?.on("data", (d: Buffer) => { out += d.toString(); });
    p.stderr?.on("data", (d: Buffer) => { err += d.toString(); });
    p.on("error", () => res({ status: -1, stdout: "", stderr: "whisper-cli not found (set --whisper-bin)" }));
    p.on("close", (code) => res({ status: code, stdout: out, stderr: err }));
  });
  let raw = "";
  try { raw = readFileSync(`${prefix}.txt`, "utf8"); } catch { raw = wr.stdout ?? ""; }
  const cleaned = raw.replace(/\[[^\]]*\]/g, " ").replace(/\s+/g, " ").trim(); // drop [BLANK_AUDIO] / [_TT_] markers
  if (o.debug) {
    console.error(`  ${tstamp()} [voice] mic=${o.micDevice} rec=${tRec - t0}ms whisper=${systemClock.now() - tRec}ms raw=${JSON.stringify(raw.trim())} → ${JSON.stringify(cleaned)}`);
    if (wr.status !== 0) console.error(`  [voice] whisper exit=${wr.status}: ${String(wr.stderr ?? "").trim().slice(-300)}`);
  }
  try { rmSync(wav, { force: true }); rmSync(`${prefix}.txt`, { force: true }); } catch { /* best effort */ }
  return cleaned;
}

/** Start an in-process peer on the given substrate so `weave voice --netops` is ONE command
 *  (no separate `weave up`). Mirrors cmdUp's peer wiring (minus the event firehose + daemon
 *  bits). Fire-and-forget start; returns a stop() to abort + drain on exit. */
async function startEmbeddedPeer(args: Args, weave: Substrate): Promise<() => Promise<void>> {
  const agentId = str(args, "peer-agent", `voice-peer-${randomUUID().slice(0, 8)}`);
  const { skills, registry, backend, errors } = await assembleSkills(args, {
    fake: has(args, "fake"), model: str(args, "model", "claude-sonnet-4-6"), weave, newId: () => randomUUID(),
  });
  for (const e of errors) console.error(`  ! skill load error in ${e.file}: ${e.error}`);
  const router = new SkillRouterWorker(skills);
  const peer = createPeer({
    weave,
    cfg: { agentId, grant: { tools: "*", maxEffect: "irreversible" },
      leaseMs: numPos(args, "lease-ms", 30_000), maxConcurrent: numPos(args, "concurrency", 2), tickMs: numPos(args, "tick-ms", 3_000) },
    newWorker: () => router, registry, clock: systemClock, newId: () => randomUUID(),
  });
  const ac = new AbortController();
  void peer.start(ac.signal); // runs until aborted; we don't await it here
  console.log(`  (embedded peer "${agentId}" [llm: ${backend}] — ${skills.length} skills ready)`);
  return async () => { ac.abort(); await peer.stop().catch(() => {}); };
}

/** Voice REPL: push-to-talk → whisper STT → routed weave turn → spoken answer. Routes by default
 *  so NetOps utterances hit the forward-* skills; --skill X pins one. With --netops it embeds its
 *  own peer (single command); otherwise it's a thin client and a `weave up` peer answers.
 *  macOS-only (avfoundation mic + `say`). */
async function cmdVoice(args: Args): Promise<void> {
  if (process.platform !== "darwin") return void console.error("weave voice: needs macOS (avfoundation mic + `say`).");
  setResilient(); // keep the voice REPL alive across a transient turn error
  const whisper = str(args, "whisper-bin", "whisper-cli");
  const model = str(args, "whisper-model", join(PACKAGE_ROOT, "models", "ggml-base.en.bin"));
  if (!existsSync(model)) return void console.error(`weave voice: whisper model not found at ${model}\n  Download e.g. ggml-base.en.bin from https://huggingface.co/ggerganov/whisper.cpp, or pass --whisper-model <path>.`);
  const micDevice = str(args, "mic", ":0"); // avfoundation audio index (`ffmpeg -f avfoundation -list_devices true -i ""`)
  const maxSecs = num(args, "max-secs", 20);
  // VAD: auto-stop a command recording shortly after you stop talking (ffmpeg silencedetect).
  // Tunable via --silence-db / --silence-secs; --no-vad records until Enter/maxSecs.
  const vadFilter = has(args, "no-vad") ? "" : `silencedetect=noise=${str(args, "silence-db", "-30")}dB:d=${str(args, "silence-secs", "3.0")}`;

  const weave = await openSubstrate(args);
  // --netops (or --persona netops, which implies it) embeds a peer so this is ONE command;
  // else rely on an external `weave up` peer. --no-serve forces the thin-client mode.
  const wantEmbeddedPeer = (has(args, "netops") || str(args, "persona", "") === "netops") && !has(args, "no-serve");
  const stopPeer = wantEmbeddedPeer ? await startEmbeddedPeer(args, weave) : null;
  const newId = (): string => randomUUID();
  const actor = str(args, "agent", `voice-${randomUUID().slice(0, 8)}`);
  const explicitSkill = has(args, "skill") ? str(args, "skill", "") : undefined;
  const pinnedSkill = explicitSkill; // undefined => route (NetOps utterances → forward-*)
  const summaryAgent = "voice-summary"; // dedicated NO-TOOLS skill — never the tool-granted agent
  // Turn timeout: 180s default — enough for the agent to run a query (or two) and summarize without
  // premature failures. Lower it (e.g. --timeout 45s) if you'd rather fail fast on slow asks.
  const timeoutMs = durationFlag(args, "timeout", "180s");
  const speaker = makeSpeaker(!has(args, "no-speak"), str(args, "voice", "Karen")); // female voice by default
  const debug = has(args, "debug"); // surface each transcript + timing + wake-match decision
  const carry = !has(args, "no-context");
  const history: ChatTurn[] = [];
  // Spoken-length cap: long NetOps answers (tables/diffs) become minutes-long monologues through
  // `say`. We speak up to this many chars, then point at the screen; "continue" reads the rest.
  const speakCap = num(args, "speak-cap", 700); // 0 disables
  const moreLine = "There's more on screen. Say continue to hear the rest.";
  // Confirm before irreversible NetOps actions: the embedded peer runs with maxEffect:irreversible
  // and STT is error-prone, so a mis-heard "push config" should never auto-execute. --no-confirm off.
  const confirmGate = !has(args, "no-confirm");
  // Imperative, state-changing verbs. Broadened to cover NetOps idioms the first pass missed
  // (failover/withdraw/shut/isolate/blackhole/no-shut). A read-only QUESTION that merely mentions one
  // ("is the link down?", "did anyone remove the ACL?") is exempted via isQuestion so the gate
  // doesn't nag on lookups.
  const destructive = /\b(push|deploy|delete|remove|shut\s?(down)?|no\s+shut|reload|reboot|restart|provision|commit|apply|drop|disable|deactivate|clear|erase|wipe|overwrite|rollback|fail\s?over|withdraw|isolate|blackhole|bounce)\b/i;
  const isQuestion = (u: string): boolean =>
    /\?\s*$/.test(u.trim()) ||
    /^(what|what'?s|whats|is|are|was|were|did|does|do|show|can|could|how|why|which|list|get|who|where|when|tell me|check)\b/i.test(u.trim());
  let lastAnswer = "";  // full answer (screen/history)
  let lastSpoken = "";  // what was actually VOICED (summary/streamed) — "repeat" replays this
  let lastMore = "";    // unspoken remainder, for "continue / read the rest"

  // Wake-word mode (`--wake`, default phrase "hello forward"): hands-free. Listen in short chunks
  // until the phrase is heard, ack with "Hello", then record the question. Otherwise push-to-talk.
  const wake = has(args, "wake") ? (str(args, "wake", "") || "hello forward") : null;
  const wakeChunk = num(args, "wake-chunk", 4);
  const ackPhrase = str(args, "wake-ack", "Hello");
  const heardAck = str(args, "heard-ack", "On it."); // spoken when a command is captured (before the LLM turn)
  const norm = (s: string): string => s.toLowerCase().replace(/[^a-z0-9 ]+/g, " ").replace(/\s+/g, " ").trim();
  // Fuzzy wake: tolerate common whisper mis-hears ("hi/hey forward", "for word") rather than a strict
  // substring of the exact phrase — false rejects ("why won't it wake") are the worst wake-word UX.
  const wakeMatch = (heard: string): boolean => {
    const h = norm(heard);
    if (!h) return false;
    if (h.includes(norm(wake ?? ""))) return true;
    if (/\b(hello|hallo|hi|hey|ok|okay)\b.*\bfor\s?wards?\b/.test(h)) return true; // greeting + forward
    return /\bfor\s?wards?\b/.test(h) && h.split(" ").length <= 3; // bare "forward" only if short
  };
  // Spoken control words. Anchored at BOTH ends (whole short utterance) so real NetOps commands like
  // "stop advertising the route" or "cancel change-set CHG-7" or "clear counters" route to the LLM
  // instead of being swallowed as a local control word. Optional trailing politeness is tolerated.
  const ctl = (re: RegExp, u: string): boolean => re.test(norm(u));
  const isRepeat = (u: string): boolean => ctl(/^(repeat( that)?|say that again|read that again|again)$/, u);
  const isContinue = (u: string): boolean => ctl(/^(continue|go on|keep going|read (the )?rest|read it all|finish)$/, u);
  const isHelp = (u: string): boolean => ctl(/^(help|what can (you|i) (do|ask)|what can i say|options)$/, u);
  const isStop = (u: string): boolean => ctl(/^(stop|cancel|never ?mind|forget it|quiet|be quiet|shush|nope)( (it|now|please|that))?$/, u);
  // Listener-friendly phrasing for failures — the raw strings are written for someone reading a
  // terminal (backticks, "weave up", "(failed)"), which sound robotic and confusing aloud.
  const voiceError = (answer: string): string => {
    if (/no peer answered|weave up/i.test(answer)) return "I couldn't reach my worker. Make sure a weave peer is running, then try again.";
    if (/didn't finish in time|raise --timeout/i.test(answer)) return "That took too long to finish. Try a simpler request.";
    if (/cancelled/i.test(answer)) return "Okay, cancelled.";
    const short = answer.replace(/`[^`]*`/g, "").replace(/\s+/g, " ").trim().slice(0, 200);
    return `Sorry, that didn't work. ${short}`;
  };

  console.log("weave voice — talk to your weave.");
  console.log(wake
    ? `  hands-free: say "${wake}" to wake, then ask · say "stop" or press Enter/Ctrl-C to cancel a turn · /quit exits · model: ${model.split("/").pop()}\n`
    : `  push-to-talk: Enter to record, speak, Enter to stop · Enter/Ctrl-C cancels a running turn · /quit exits · model: ${model.split("/").pop()}\n`);

  // Spoken self-introduction at startup (her name is Forward — same as the wake word).
  const intro = has(args, "no-intro") ? "" : str(args, "intro", "Hi, I'm Forward, your A I NetOps agent. Say, Hello Forward, to wake me, then ask your question.");
  if (intro) { speaker.speak(intro); await speaker.done(); }

  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const queue: string[] = [];
  let pending: ((v: string | null) => void) | null = null;
  let closed = false;
  let quit = false;
  let turnAbort: AbortController | null = null; // set while an LLM turn is in flight
  rl.on("line", (l) => {
    // During an LLM turn, ANY input (Enter or text) is a stop: silence speech and cancel the task.
    if (turnAbort) { speaker.stop(); turnAbort.abort(); return; }
    speaker.stop(); // a keypress also silences any in-flight answer playback (keyboard barge-in)
    if (pending) { pending(l); pending = null; return; }
    queue.push(l);
  });
  rl.on("close", () => { closed = true; pending?.(null); });
  // Ctrl-C: silence + cancel an in-flight turn and stay in the loop; at the prompt (no turn) it quits.
  rl.on("SIGINT", () => { speaker.stop(); if (turnAbort) { turnAbort.abort(); } else { quit = true; pending?.(null); } });
  const nextLine = (): Promise<string | null> =>
    queue.length ? Promise.resolve(queue.shift()!) : closed ? Promise.resolve(null) : new Promise((r) => (pending = r));
  const drainQuit = (): boolean => { while (queue.length) if (queue.shift()!.trim() === "/quit") return true; return false; };

  // Conversation state (wake mode): after waking we stay awake for follow-ups until a silent or
  // garbage turn, then go back to sleep — so you don't repeat the wake word for every command.
  let awake = false;
  const isNoise = (t: string): boolean => {
    const n = norm(t);
    return n.length < 3 || /^(you|thank you|thanks( for watching)?|bye|uh+|um+|hmm+|okay|ok)$/.test(n);
  };

  // Barge-in (wake mode, default on): while the assistant is thinking or speaking, keep the mic open
  // in short chunks and listen for the wake phrase or "stop"/"cancel" to interrupt. The hard part is
  // half-duplex echo — the mic hears our own TTS. Two guards: (1) a token-OVERLAP test drops a chunk
  // that's mostly our own current words (robust to whisper garbling, unlike a strict substring); and
  // (2) while audio is actually playing we require N consecutive confident hits (debounce) so a lone
  // garbled echo can't cancel — but when we're silent (mid-thought) we interrupt on the first hit.
  const bargeIn = !has(args, "no-barge-in");
  const bargeChunk = num(args, "barge-chunk", 3);
  const bargeDebounce = num(args, "barge-debounce", 2); // consecutive hits needed WHILE speaking
  const echoOverlap = (heard: string, spoken: string): number => {
    const ht = norm(heard).split(" ").filter(Boolean);
    if (!ht.length) return 1;
    const sp = new Set(norm(spoken).split(" ").filter(Boolean));
    return ht.filter((w) => sp.has(w)).length / ht.length;
  };
  const listenForInterrupt = async (
    state: { done: boolean },
    stopSignal: Promise<void>,
    speaking: () => string,
  ): Promise<boolean> => {
    let hits = 0;
    while (!state.done && !quit && !closed) {
      const heard = await recordAndTranscribe({ awaitEnter: () => stopSignal, micDevice, model, whisper, maxSecs: bargeChunk, debug, quiet: true });
      if (state.done) break;
      const h = norm(heard);
      const playing = speaker.speaking();
      if (!h || (playing && echoOverlap(heard, speaking()) >= 0.5)) { hits = 0; continue; } // silence / our own echo
      if (!(wakeMatch(heard) || isStop(heard))) { hits = 0; continue; }
      if (!playing) { // no audio out (mid-thought) → no echo risk → interrupt immediately
        if (debug) console.error(`  ${tstamp()} [voice] BARGE-IN ✓ (silent; heard ${JSON.stringify(heard)})`);
        return true;
      }
      hits += 1; // while speaking, demand consecutive confirmations
      if (debug) console.error(`  ${tstamp()} [voice] barge candidate ${hits}/${bargeDebounce} (heard ${JSON.stringify(heard)})`);
      if (hits >= bargeDebounce) return true;
    }
    return false;
  };

  for (;;) {
    if (quit || closed) break;
    let utterance = ""; // assigned by each capture path below (or we `continue` before use)

    if (wake) {
      let oneBreath = false;
      if (!awake) {
        // Listen in short chunks until the wake phrase is heard (typed /quit or Ctrl-C breaks out).
        process.stdout.write(`👂 say "${wake}"…\r`);
        let woken = "";
        while (!woken && !quit && !closed) {
          if (drainQuit()) { quit = true; break; }
          const heard = await recordAndTranscribe({ awaitEnter: () => new Promise<void>(() => undefined), micDevice, model, whisper, maxSecs: wakeChunk, debug, quiet: true });
          const matched = wakeMatch(heard); // fuzzy: tolerate "hi/hey forward", "for word"
          if (debug) console.error(`  ${tstamp()} [voice] wake ${matched ? "MATCH ✓" : "no"} (heard ${JSON.stringify(heard)})`);
          if (matched) woken = heard;
        }
        if (quit || closed) break;
        awake = true; // stay awake for follow-ups until a silent/noise turn
        // One-breath: if the wake chunk already carried the question ("Hello Forward, what's the
        // path from A to B"), strip the wake phrase and use the remainder — skip ack + a record cycle.
        const after = norm(woken).replace(/^.*?\bfor\s?wards?\b[\s,]*/, "").trim();
        if (after && after.split(" ").length >= 2 && !isNoise(after)) {
          utterance = after;
          oneBreath = true;
          console.log(`\n  ${tstamp()} (awake) you (voice)› ${utterance}\n`);
        } else {
          speaker.stop();
          speaker.speak(ackPhrase); // "Hello"
          await speaker.done(); // wait for the ack to finish so we don't record it
          await new Promise((r) => setTimeout(r, 300)); // small buffer for room echo
          console.log(`\n  ${tstamp()} (awake) — I'm listening… just keep talking; pause to sleep.`);
        }
      }
      if (!oneBreath) {
        utterance = await recordAndTranscribe({ awaitEnter: () => nextLine().then(() => undefined), micDevice, model, whisper, maxSecs, debug, vadFilter, initialSilenceSecs: num(args, "initial-silence", 5) });
        if (!utterance || isNoise(utterance)) {
          console.log(`  ${tstamp()} (back to sleep — say "${wake}" to wake me)\n`);
          awake = false;
          continue;
        }
        console.log(`${tstamp()} you (voice)› ${utterance}\n`);
      }
    } else {
      process.stdout.write("🎤 Enter to talk (or type a message) · /quit › ");
      const start = await nextLine();
      if (start === null) break;
      const typed = start.trim();
      if (typed === "/quit" || typed === "/exit") break;
      if (typed) {
        utterance = typed; // typed fallback when you'd rather not speak
      } else {
        speaker.stop(); // don't record weave talking over you
        utterance = await recordAndTranscribe({ awaitEnter: () => nextLine().then(() => undefined), micDevice, model, whisper, maxSecs, debug, vadFilter, initialSilenceSecs: num(args, "initial-silence", 5) });
        if (!utterance || isNoise(utterance)) { speaker.speak("I didn't catch that. Try again."); console.log(`  ${tstamp()} (heard nothing — try again)\n`); continue; }
        console.log(`${tstamp()} you (voice)› ${utterance}\n`);
      }
    }

    // Spoken control words (handled locally, no LLM turn): stop / repeat / continue / help.
    if (isStop(utterance)) {
      speaker.stop(); // silence any lingering speech; a no-op cancel that returns to listening
      console.log(`  ${tstamp()} (stopped)\n`);
      continue;
    }
    if (isRepeat(utterance)) {
      // Replay what was actually VOICED (the summary / streamed answer), not the raw markdown dump.
      if (lastSpoken) { speaker.speak(lastSpoken); if (wake) await speaker.done(); }
      else speaker.speak("I haven't said anything yet.");
      continue;
    }
    if (isContinue(utterance)) {
      if (lastMore) { speaker.speak(lastMore); lastMore = ""; if (wake) await speaker.done(); }
      else speaker.speak("There's nothing more to read.");
      continue;
    }
    if (isHelp(utterance)) {
      speaker.speak("You can ask things like: what's the path from one host to another. Show BGP peers on a device. Or, run STIG checks. Say stop to cancel what I'm doing, or repeat to hear my last answer again.");
      if (wake) await speaker.done();
      continue;
    }

    // Confirmation gate for irreversible actions: a mis-transcribed "push config" must not auto-run.
    // We record the reply only AFTER the prompt audio has fully finished (await done + buffer) so the
    // mic can't capture our own "...say yes..." (echo-confirm). And we proceed only on an explicit,
    // utterance-LEADING affirmative with NO negation present — so a captured prompt echo (which starts
    // with "you asked…") or a hedged "yes but wait" cancels rather than fires the irreversible action.
    if (confirmGate && destructive.test(utterance) && !isQuestion(utterance)) {
      speaker.speak(`You asked me to: ${utterance}. Should I go ahead? Say yes or no.`);
      await speaker.done();
      await new Promise((r) => setTimeout(r, 250)); // let the prompt audio release before we record
      const reply = norm(await recordAndTranscribe({ awaitEnter: () => nextLine().then(() => undefined), micDevice, model, whisper, maxSecs: 6, debug, vadFilter, initialSilenceSecs: 4 }));
      const affirmed = /^(yes|yeah|yep|yup|sure|confirm|affirmative|correct|proceed|go ahead|do it|go for it)\b/.test(reply);
      const negated = /\b(no|nope|don'?t|do not|cancel|stop|wait|never ?mind|hold on)\b/.test(reply);
      if (!affirmed || negated) {
        speaker.speak("Okay, cancelled.");
        console.log(`  ${tstamp()} (cancelled — heard ${JSON.stringify(reply || "nothing")})\n`);
        continue;
      }
    }

    speaker.stop();
    speaker.enqueue(heardAck); // ack: confirm we heard the command; plays while the LLM turn runs

    // --- Streaming TTS: voice the answer sentence-by-sentence as the peer produces it (first audio
    //     in ~1s, great for conversational replies). NetOps/skill answers arrive WHOLE at completion
    //     — their only progress note is "skill: X" (filtered) — so nothing streams and they take the
    //     contextual-summary path below. `answerSpoken` accumulates exactly what we've voiced, so the
    //     barge-in echo guard and "repeat" both reflect what's actually audible.
    let streamBuf = "";
    let spokenLen = 0;
    let capped = false;
    let tail = "";          // prose past the spoken cap, saved for "continue"
    let answerSpoken = "";  // the answer text actually voiced this turn (echo guard + repeat)
    const enqueueSpoken = (s: string): void => {
      const t = s.trim();
      if (!t) return;
      if (capped) { tail += (tail ? " " : "") + t; return; }
      speaker.enqueue(t);
      answerSpoken += (answerSpoken ? " " : "") + t;
      spokenLen += t.length;
      if (speakCap > 0 && spokenLen >= speakCap) { capped = true; speaker.enqueue(moreLine); }
    };
    const flushSentences = (): void => {
      for (;;) {
        const m = /^[\s\S]*?[.!?\n]/.exec(streamBuf);
        if (!m) break;
        streamBuf = streamBuf.slice(m[0].length);
        enqueueSpoken(m[0]);
      }
    };
    const onProgress = (note: string): void => {
      const t = note.trim();
      if (!t || /^skill:\s/i.test(t)) return; // skip the router's "skill: X" status note (not prose)
      streamBuf += (streamBuf ? " " : "") + t;
      flushSentences();
    };

    const netCtx = networkId(args) !== DEFAULT_NETWORK ? `network ${networkId(args)}` : undefined;
    const goal = carry ? buildChatGoal(utterance, history, netCtx) : utterance;
    // Voice biases to cheap/fast models — the forward scripts do the heavy lifting; the LLM mostly
    // picks a query and summarizes. Hard ("frontier") asks get Sonnet, everything else Haiku; NEVER
    // Opus. --model pins one; --no-tier defers to the peer default.
    const turnModel = has(args, "no-tier") ? undefined
      : has(args, "model") ? str(args, "model", TIER_MODELS[2])
      : tierModel(args, classifyTier(utterance) === 3 ? 2 : 1);
    const wantStream = has(args, "stream"); // force RAW streaming even for rich answers (skip summary)

    // Barge-in spans the whole busy window (LLM turn + spoken answer). The echo guard compares the
    // mic against everything we're currently saying (ack + answer voiced so far + buffered text), so
    // our own TTS — heard live as the answer streams — can't self-interrupt the turn.
    const busy = { done: false };
    let signalStop = (): void => {};
    const stopSignal = new Promise<void>((r) => { signalStop = r; });
    const endBarge = (): void => { busy.done = true; signalStop(); };
    let filler = ""; // spoken heartbeat text — included in the echo guard so it can't self-barge
    const speaking = (): string => `${heardAck} ${filler} ${answerSpoken} ${streamBuf}`;
    const bargeP = (wake && bargeIn)
      ? listenForInterrupt(busy, stopSignal, speaking).then((hit) => {
          if (hit) { busy.done = true; speaker.stop(); turnAbort?.abort(); }
          return hit;
        })
      : Promise.resolve(false);

    // Heartbeat (#7): a slow NetOps turn voices nothing until completion (the answer arrives whole,
    // not streamed), so eyes-free it's indistinguishable from a crash. Speak "still working" every
    // `heartbeat-secs` while the turn is silent (no answer voiced yet, not already speaking, not
    // barged). Streamed/conversational turns are already audible, so the answerSpoken/streamBuf guard
    // keeps us quiet there. Heartbeat text feeds the echo guard via `filler`.
    const hbEvery = num(args, "heartbeat-secs", 25) * 1000; // 0 disables
    const hbPhrases = ["Still working on it.", "Still on it, one moment.", "Almost there.", "Working on it."];
    let hbCount = 0;
    const hbTimer = (hbEvery > 0 && !has(args, "no-speak")) ? setInterval(() => {
      if (busy.done || answerSpoken || streamBuf || speaker.speaking() || hbCount >= hbPhrases.length) return;
      filler = hbPhrases[hbCount % hbPhrases.length]!;
      speaker.enqueue(filler);
      hbCount += 1;
    }, hbEvery) : null;

    turnAbort = new AbortController();
    // Always pass onProgress: conversational answers voice live; skill answers' progress is filtered,
    // so they arrive at completion and take the summary path below.
    const { answer, ok, cancelled } = await chatTurn(weave, newId, actor, goal, pinnedSkill, turnModel, timeoutMs, turnAbort.signal, onProgress);
    turnAbort = null;
    if (hbTimer) clearInterval(hbTimer);
    // A voice barge-in is an "interrupt to talk", not a silent kill: stop, say "Yes?", and the next
    // (awake) loop iteration captures the redirect. Distinguish from a Ctrl-C/timeout cancel (bargeP false).
    if (cancelled) {
      endBarge();
      const byVoice = await bargeP;
      speaker.stop();
      if (byVoice) { speaker.speak("Yes?"); await speaker.done(); console.log(`  ${tstamp()} (barge-in — go ahead)\n`); }
      else console.log(`  ${tstamp()} (${answer})\n`);
      continue;
    }
    console.log(`${tstamp()} ${ok ? "weave›" : "weave (failed)›"} ${answer}\n`); // screen: full detail
    if (!ok) {
      speaker.stop(); // drop any half-streamed prose; speak a clean, listener-friendly failure
      answerSpoken = voiceError(answer);
      speaker.speak(answerSpoken);
      lastMore = "";
    } else if (spokenLen > 0 || streamBuf.trim()) {
      // Streamed live (conversational) — flush the un-spoken tail (the last block had no end mark).
      if (streamBuf.trim()) enqueueSpoken(streamBuf);
      lastMore = tail;
    } else {
      // Nothing streamed (skill/NetOps answer arrives whole): speak a CONTEXTUAL summary, not the raw
      // markdown/IP dump. A pin-only NO-TOOLS skill (voice-summary) condenses it — untrusted result
      // text can't escalate (no tools). `--stream` forces the raw answer instead.
      let spoken = answer;
      if (!wantStream && !has(args, "no-speak") && !has(args, "no-voice-summary") && looksRich(answer)) {
        if (debug) console.error(`  ${tstamp()} [voice] summarizing ${answer.length} chars for speech (no-tools agent)…`);
        const s = await chatTurn(weave, newId, actor, answer, summaryAgent, undefined, 60_000, undefined);
        if (s.ok && s.answer.trim()) spoken = s.answer.trim();
      }
      if (busy.done) {
        // User barged in (said stop/wake) during the silent summary sub-turn — don't speak it.
        lastMore = "";
      } else if (speakCap > 0 && spoken.length > speakCap) {
        // Cap the spoken length so a long reply isn't an unskippable monologue; "continue" reads on.
        answerSpoken = spoken.slice(0, speakCap);
        speaker.speak(answerSpoken);
        speaker.enqueue(moreLine);
        lastMore = spoken.slice(speakCap);
      } else {
        answerSpoken = spoken;
        speaker.speak(spoken);
        lastMore = "";
      }
    }
    lastAnswer = answer;
    lastSpoken = answerSpoken; // "repeat" replays what was actually voiced (summary/streamed), not raw
    if (wake) await speaker.done(); // wait for the answer to finish before re-listening (no echo)
    endBarge();
    if (await bargeP) {
      // User cut in mid-answer — treat it as "interrupt to talk": acknowledge and let the next
      // (awake) iteration capture the redirect, rather than just falling silent.
      speaker.speak("Yes?");
      await speaker.done();
      console.log(`  ${tstamp()} (barge-in — go ahead)\n`);
    }
    history.push({ q: utterance, a: answer });
  }

  if (!closed) rl.close();
  speaker.stop();
  if (stopPeer) await stopPeer();
  weave.close();
  console.log("\nweave: bye.");
}

async function cmdChat(args: Args): Promise<void> {
  setResilient(); // keep the chat REPL alive across a transient turn error
  const weave = await openSubstrate(args);
  const speaker = makeSpeaker(has(args, "speak"), str(args, "voice", "Karen")); // --speak: voice via offline TTS (female by default)
  const newId = () => randomUUID();
  const actor = str(args, "agent", `chat-${randomUUID().slice(0, 8)}`);
  const explicitSkill = has(args, "skill") ? str(args, "skill", "") : undefined;
  // Conversational by default: pin the general `claude` agent so every turn is a quick chat reply,
  // NOT routed by keyword to a heavy skill (a stray word like "research" would otherwise launch the
  // researcher job). `--route` opts into full skill routing; `--skill X` targets one skill; under
  // `--fake` there's no claude agent, so fall back to routing (the echo skill).
  const route = has(args, "route") || has(args, "fake");
  // Conversational default = the launch persona's agent (netops / custom / generic), so
  // `weave chat --netops` talks as the Forward NetOps agent, not the generic assistant.
  const personaArg = str(args, "persona", "");
  const persona = personaArg || (has(args, "netops") ? "netops" : "");
  const convoAgent = persona === "netops" ? "netops" : persona ? "agent" : "claude";
  const pinnedSkill = explicitSkill ?? (route ? undefined : convoAgent);
  const timeoutMs = durationFlag(args, "timeout", "180s");
  const carry = !has(args, "no-context");
  const history: ChatTurn[] = [];
  const net = networkId(args);
  const netBadge = net !== DEFAULT_NETWORK ? `${cyan(`[${net}]`)} ` : "";
  const mode = explicitSkill ? `skill: ${explicitSkill}` : route ? "routing by skill" : "conversational (general agent)";

  console.log(`${green("weave chat")}${netBadge}— talk to your weave. Just type and press enter.\n`);
  console.log(`  ${gray("mode:")}   ${mode}`);
  console.log(`  ${gray("cmds:")}   /help  /status  /reset  /quit${carry ? "" : "  /no-context"}`);
  console.log();

  const rl = createInterface({ input: process.stdin, output: process.stdout });

  // Line-queue model: lines typed or piped while a turn is in flight are buffered, not dropped. With
  // rl.question() readline reads ahead to EOF during the await and 'close' fires before later lines
  // are consumed — so scripted `printf 'a\nb\n' | weave chat` would silently skip 'b'. Queueing lines
  // and only ending on a *drained* EOF makes interactive and piped multi-turn behave the same.
  const queue: string[] = [];
  let pending: ((v: string | null) => void) | null = null;
  let closed = false;
  let turnAbort: AbortController | null = null; // set while a turn is in flight
  const deliver = (v: string | null): void => { const r = pending; pending = null; r?.(v); };
  rl.on("line", (l) => (pending ? deliver(l) : queue.push(l)));
  rl.on("close", () => { closed = true; if (pending) deliver(null); }); // Ctrl-D / EOF / rl.close()
  // Ctrl-C: cancel an in-flight turn and return to the prompt; at the prompt (no turn), exit.
  rl.on("SIGINT", () => { speaker.stop(); if (turnAbort) turnAbort.abort(); else rl.close(); });
  const nextLine = (): Promise<string | null> =>
    queue.length > 0 ? Promise.resolve(queue.shift()!) : closed ? Promise.resolve(null) : new Promise((res) => { pending = res; });

  for (;;) {
    process.stdout.write(`${blue("›")} `);
    const raw = await nextLine();
    if (raw === null) break; // input drained (Ctrl-D / EOF) or interrupted (Ctrl-C)
    const line = raw.trim();
    if (!line) continue;

    if (line === "/quit" || line === "/exit") break;
    if (line === "/help") {
      console.log("  Just talk — each turn is a conversational reply from the general agent, and");
      console.log("  follow-ups remember the prior turns. (Start with --route or --skill X to target skills.)");
      console.log("  Ctrl-C cancels the current turn; at the prompt it exits.");
      console.log("  /status  show task states   /reset  forget conversation context   /quit  exit\n");
      continue;
    }
    if (line === "/reset") {
      history.length = 0;
      console.log("  (conversation context cleared)\n");
      continue;
    }
    if (line === "/status") {
      const events = await readAll(weave);
      const now = systemClock.now();
      const goals = new Map<string, string>();
      for (const e of events) if (e.kind === TaskKind.Declared) goals.set(e.subject, (e.payload as DeclaredPayload).spec.goal);
      if (goals.size === 0) console.log("  (no tasks yet)");
      for (const [subject, goal] of goals) {
        const holder = currentHolder(events, subject, now);
        const state = isSettled(events, subject) ? "done" : holder ? `held by ${holder.agentId}` : "free";
        console.log(`  ${subject.padEnd(16)} [${state}] ${goal.length > 60 ? `${goal.slice(0, 59)}…` : goal}`);
      }
      console.log("");
      continue;
    }

    const netCtx = networkId(args) !== DEFAULT_NETWORK ? `network ${networkId(args)}` : undefined;
    const goal = carry ? buildChatGoal(line, history, netCtx) : line;

    // Cache check: use cached answer for hot queries
    const cached = getCachedAnswer(line);
    if (cached) {
      console.log(`${dim("→")} cached ${yellow(`(${cached.hits} hit${cached.hits === 1 ? "" : "s"})`)}\n`);
      console.log(`${green("weave›")} ${cached.answer}\n`);
      speaker.speak(cached.answer);
      history.push({ q: line, a: cached.answer });
      continue;
    }

    // Classify on the raw utterance (not the context-carried goal): conversational turns → Haiku,
    // hard asks ("design…", "audit…") escalate to Opus. --no-tier leaves it to the peer's default.
    const turnModel = has(args, "no-tier") ? undefined : modelForGoal(args, line);
    turnAbort = new AbortController();
    const { answer, ok, cancelled } = await chatTurn(
      weave, newId, actor, goal, pinnedSkill, turnModel, timeoutMs, turnAbort.signal,
      undefined, line, net // utterance, networkId for learning
    );
    turnAbort = null;
    if (cancelled) { console.log(`${gray("(cancelled)")} ${answer}\n`); continue; } // don't pollute context with a cancel
    console.log(`${ok ? green("✓") : red("✗")} ${answer}\n`);
    speaker.speak(answer); // --speak: voice the response (offline, interruptible)

    // Cache successful answers for hot queries
    if (ok) {
      cacheAnswer(line, answer);
    }

    history.push({ q: line, a: answer });
  }

  if (!closed) rl.close();
  speaker.stop();
  weave.close();
  console.log("\nweave: bye.");
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

concepts:
  peer     an autonomous worker that claims tasks and routes them to skills (weave up)
  task     a unit of work declared into the shared log; claimed exactly once by one peer
  skill    a use-case (a prompt+tools, or code) dropped into .weave/skills/ — what a task runs
  the log  the shared event log every peer reads/writes; coordination happens here, not via a boss

quickstart:
  npm install                       # once
  weave up --fake                   # start a peer (offline, no API key) — leave it running
  weave task "summarize the README" # in another terminal: declare work
  weave status                      # watch it go free → held → done   (weave report = the output)

usage:
  weave up        [--network-id <id>] [--db <path>] [--agent <id>] [--model <m>] [--fake]
                  [--concurrency N] [--lease-ms N] [--tick-ms N] [--compact-secs N]
                  [--daemon] [--pid-file <path>] [--log-file <path>]
                  start a peer: claim tasks + route them to skills
                  (--network-id isolates db, reports, .env to .weave/networks/<id>/)
                  (--daemon detaches to the background; logs + pid default next to --db)
                  [--bash [--bash-allow prog1,prog2] [--bash-timeout-ms N]]
                  (--bash grants shell access: denylist always on, blocks rm -rf/sudo/etc.)
                  [--read-only]  (claude-cli backend grants Write/Edit/Glob by default —
                  durable working memory + serialize deliverables to disk; --read-only revokes them)
  weave pool      [--network-id <id>] [--workers N] [--db <path>] [--model <m>] [--fake]
                  [--concurrency N] [--daemon] [--pid-file <path>] [--log-file <path>] [--bash ...]
                  supervise N lightweight peer processes (default 4) that claim work from
                  the shared weave; restarts crashed workers; stop the pool with weave down
  weave down      [--network-id <id>] [--db <path>] [--pid-file <path>]
                  stop a daemonized peer or pool (SIGTERM)
  weave ps        list all daemonized peers/pools across networks + liveness
  weave task <goal...>   [--network-id <id>] [--skill <name>] [--db <path>] [--id <taskId>]
                  [--model m | --no-tier]
                  (by default the goal is classified to a model tier — ADR-0022 — Haiku/Sonnet/Opus;
                  --model pins one, --no-tier leaves the choice to the claiming peer's default)
  weave loop --skill <name> [--network-id <id>] [--interval 6h] [--once]
                  [--notify [--to slack,telegram,email]] [goal...]
                  [--daemon] [--pid-file <path>] [--log-file <path>]
                  re-declare a task routed to <skill> each tick (a skill = a use-case)
                  (--notify alerts on completed results; pick channels with --to, same as 'weave notify')
                  (--daemon detaches to the background; stop with weave down)
  weave skills    [--skills-dir <dir>] [--claude-skills [--claude-skills-dir <dir>]] [--fake]
                  list code + declarative skills (--claude-skills inherits Claude SKILL.md)
  weave notify <text...> [--to slack,telegram,email] [--title T]
  weave compact   [--network-id <id>] [--db <path>]
                  fold settled tasks into a snapshot + prune the log
  weave report    [--network-id <id>] [--db <path>] [--full]
                  print completed task results (the actual output)
  weave index     [--network-id <id>] [--db <path>] [--no-embed]
                  build the knowledge graph + search index over reports
                  (graph.json/graph.md + inline forward/backlinks; warms embeddings if configured)
  weave search    <query...> [--network-id <id>] [--db <path>] [--limit N] [--no-embed]
                  hybrid (BM25 + optional embeddings) search over accumulated knowledge
  weave chat      [--network-id <id>] [--db <path>] [--route] [--skill <name>]
                  [--timeout 180s] [--no-context] [--model m | --no-tier]
                  [--netops | --persona <name>] [--speak]
                  conversational REPL: each line is answered by the general agent (Ctrl-C cancels a
                  turn), follow-ups keep context; --route picks skills by keyword, --skill X pins one.
                  --netops grounds the agent in the vendored Forward NetOps skills; --persona <name>
                  sets a custom system prompt; --speak reads answers aloud (macOS 'say').
                  by default each turn is tiered by complexity (chat → Haiku, hard asks → Opus).
                  thin client — start a peer with 'weave up' to do the work
  weave voice     [--network-id <id>] [--netops] [options]
                  voice REPL: wake word + whisper STT → routed weave turn → TTS answer
                  (macOS-only: requires whisper.cpp model; run 'weave voice --help' / see README for the
                  full flag set: --whisper-model, --mic, --wake, --no-speak, --timeout, …)
  weave status    [--network-id <id>] [--db <path>]
  weave log       [--network-id <id>] [--db <path>] [--follow]
  weave doctor    [--lenient] [--src <dir>]   check hex architecture (strict by default)
  weave help

Workspace:
  weave runs *inside a project*. All state (.weave/ db+reports+memory) and the agent's file
  tools are rooted at the workspace — your cwd, or --workspace <dir> / WEAVE_HOME. weave refuses
  to use its own engine repo as a workspace, so keep projects in their own dirs (e.g. ~/networks/<name>/).

Network isolation:
  --network-id <id> isolates each network to .weave/networks/<id>/{weave.db,.env,reports/}.
  Each network gets its own event log, knowledge bundle, and environment (e.g., FORWARD_*).
  Omit --network-id (or use "default") for .weave/ (backward compatible).

Domain use-cases are SKILLS, not harness code: drop a .ts (code skill) or .md (declarative
agent skill: prompt + tools) into .weave/skills/. default db: .weave/weave.db`);
}

/** Load `.env` from a specific path into process.env WITHOUT overriding existing shell vars — so
 *  `weave` picks up ANTHROPIC_API_KEY / FORWARD_* from the project `.env` like the python skills do.
 *  Stdlib only (no dotenv dependency). Shell env always wins.
 *
 *  Security: consume ONLY an explicit allow-list of keys, so a stray/hostile `.env` (e.g. in a
 *  shared parent directory the walk reaches) cannot inject process-altering vars like NODE_OPTIONS,
 *  LD_PRELOAD, PATH, CLAUDE_PLUGIN_ROOT, or WEAVE_PID_FILE. Returns number of vars loaded. */
function loadDotenvFile(path: string): number {
  const allowed = (k: string): boolean =>
    k === "ANTHROPIC_API_KEY" || k === "OPENAI_API_KEY" ||
    k === "WEAVE_EMBED_KEY" || k === "WEAVE_EMBED_URL" || k === "WEAVE_EMBED_MODEL" ||
    k.startsWith("FORWARD_"); // Forward API creds (FORWARD_API_BASE_URL/KEY/SECRET/CA_BUNDLE/…)
  let loaded = 0;
  try {
    for (const raw of readFileSync(path, "utf8").split("\n")) {
      const line = raw.trim();
      if (!line || line.startsWith("#")) continue;
      const m = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line);
      const k = m?.[1];
      if (!k || !allowed(k)) continue; // ignore anything not on the allow-list
      let v = (m[2] ?? "").trim();
      if (v.length >= 2 && ((v[0] === '"' && v[v.length - 1] === '"') || (v[0] === "'" && v[v.length - 1] === "'"))) v = v.slice(1, -1);
      if (process.env[k] === undefined) { process.env[k] = v; loaded++; }
    }
  } catch { return 0; /* unreadable .env — ignore */ }
  return loaded;
}

/** Load `.env` files in priority order: network-specific → cwd (walking up).
 *  Network-specific .env is at `.weave/networks/<id>/.env` for non-default networks.
 *  Always loads from cwd .env as fallback for shared config. */
function loadDotenv(networkId: string): void {
  // Load network-specific .env first (for non-default networks)
  if (networkId !== DEFAULT_NETWORK) {
    const networkEnv = join(networkRoot(networkId), ".env");
    if (existsSync(networkEnv)) {
      const loaded = loadDotenvFile(networkEnv);
      if (loaded > 0) process.stderr.write(`weave: loaded ${loaded} var(s) from ${networkEnv} (network: ${networkId})\n`);
    }
  }
  // Load from cwd .env as fallback (shared config, wins if already set by network .env)
  let dir = process.cwd();
  for (let i = 0; i < 8; i++) {
    const f = join(dir, ".env");
    if (existsSync(f)) {
      const loaded = loadDotenvFile(f);
      if (loaded > 0) process.stderr.write(`weave: loaded ${loaded} var(s) from ${f}\n`);
      break;
    }
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
}

async function main(): Promise<void> {
  const [cmd, ...rest] = process.argv.slice(2);
  const args = parseArgs(rest);
  if (has(args, "no-color")) setColorEnabled(false);
  // Per-command help: `weave <cmd> --help` must print usage, NOT run the command. Without this,
  // `weave up --help` / `pool --help` / `loop --help` start a daemon instead of showing help.
  if (cmd !== undefined && !["help", "--help", "-h"].includes(cmd) && has(args, "help")) return usage();
  // Enter the workspace before anything reads/writes the filesystem (.env, db, reports, file tools).
  // help/usage need no workspace, so skip the guard for them.
  if (cmd !== undefined && !["help", "--help", "-h"].includes(cmd)) {
    const ws = resolveWorkspace(args);
    if (ws !== process.cwd()) process.chdir(ws);
  }
  const net = networkId(args);
  loadDotenv(net); // pick up ANTHROPIC_API_KEY / FORWARD_* from .env (network-specific first) before backend/skill selection
  switch (cmd) {
    case "up":
      return cmdUp(args);
    case "down":
      return cmdDown(args);
    case "ps":
      return cmdPs(args);
    case "pool":
      return cmdPool(args);
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
    case "index":
      return cmdIndex(args);
    case "search":
      return cmdSearch(args);
    case "chat":
      return cmdChat(args);
    case "voice":
      return cmdVoice(args);
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

// A long-running peer must not vanish on a single transient error. Detached promises in the peer
// loop (`void this.tick()`) have no local catch, so without these handlers an unhandled rejection
// hard-exits the daemon with a bare stack trace and no task context. Log it; survive if we're a
// long-running peer (resilient), otherwise fail fast and non-zero like any one-shot command.
process.on("unhandledRejection", (reason) => {
  console.error(`weave: unhandled error — ${reason instanceof Error ? reason.message : String(reason)}`);
  if (!resilient) process.exit(1);
});
process.on("uncaughtException", (err) => {
  console.error(`weave: uncaught error — ${err instanceof Error ? err.message : String(err)}`);
  if (!resilient) process.exit(1);
});

main().catch((err) => {
  console.error("weave: fatal —", err instanceof Error ? err.message : err);
  process.exitCode = 1;
});
