#!/usr/bin/env node
/**
 * The `weave` CLI — a generic agent harness. It wires concrete adapters into the use-cases
 * and is deliberately DOMAIN-AGNOSTIC: it ships coordination + generic tools + a skill system.
 * Domain use-cases (a researcher, a monitor) are skills/plugins, not harness code (ADR-0016).
 * Runs under `node --import tsx src/cli.ts` and compiles via `bun build --compile`.
 */
import { randomUUID } from "node:crypto";
import { mkdirSync, openSync, writeFileSync, readFileSync, readdirSync, existsSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { homedir, tmpdir } from "node:os";
import { spawnSync, spawn } from "node:child_process";
import { createInterface } from "node:readline";

import type { Substrate } from "./ports/substrate.js";
import type { Worker } from "./ports/worker.js";
import type { SealedEvent } from "./domain/event.js";
import { systemClock } from "./domain/clock.js";
import { TaskKind, type DeclaredPayload, type ProgressPayload } from "./domain/task.js";
import { classifyTier, type Tier } from "./domain/model-tier.js";
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
import { bashTool } from "./adapters/secondary/bash-tool.js";
import { spawnTaskTool } from "./adapters/secondary/spawn-task-tool.js";
import { readFileTool, editFileTool, grepTool } from "./adapters/secondary/fs-tools.js";
import { writeSkillTool } from "./adapters/secondary/write-skill-tool.js";
import { channelsFrom, notifyAll, type ChannelConfig } from "./adapters/secondary/channels.js";
import { ClaudeCliWorker } from "./adapters/secondary/claude-cli-worker.js";
import { echoSkill, claudeSkill, netopsAgentSkill, personaAgentSkill } from "./composition/builtin-skills.js";
import { loadAgentSkills, loadClaudeSkills } from "./composition/agent-skill.js";
import { notifyTool } from "./composition/notify-tool.js";
import { buildGraph, neighbours, type GraphEdge, type KnowledgeGraph, type ReportInput } from "./domain/knowledge-graph.js";
import { buildBm25, bm25Search, hybridRank, cosine, type Scored } from "./domain/search.js";
import { httpEmbedderFromEnv } from "./adapters/secondary/http-embedder.js";
import { localEmbedder } from "./adapters/secondary/local-embedder.js";
import type { Embedder } from "./ports/embedder.js";
import type { ToolDefinition } from "./ports/tool-host.js";

const DEFAULT_DB = ".weave/weave.db";

interface Args {
  readonly _: string[];
  readonly flags: Map<string, string | boolean>;
}

/** Flags that never take a value (so they don't greedily consume the next positional arg). */
const BOOLEAN_FLAGS = new Set(["fake", "once", "follow", "lenient", "notify", "help", "daemon", "claude-skills", "bash", "write", "read-only", "no-embed", "no-context", "route", "no-tier"]);

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
}

/** The durable report bundle root (sibling of the db), guaranteed to exist by openSubstrate.
 *  Laid out as an OKF v0.1 bundle: per-skill subdirs of concept files + index.md / log.md. */
function reportsDirFor(args: Args): string {
  return join(dirname(str(args, "db", DEFAULT_DB)), "reports");
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
    const { createClaudeWorkerFactory } = await import("./composition/claude-sdk.js");
    return { kind: "claude-sdk", make: (sp) => createClaudeWorkerFactory({ model, ...(sp ? { systemPrompt: sp } : {}) })() };
  }
  if (claudeCliAvailable()) {
    // The CLI worker uses Claude Code's OWN tools (not weave's ToolHost), so these writes are NOT
    // routed through the effect-gate (ADR-0003 §6 capability ceiling). We grant write by default
    // anyway: a research/agent skill is near-useless without durable working-memory (a scratchpad it
    // can re-Read to rebuild context) and the ability to serialize its deliverable to disk. Glob lets
    // it discover existing files (e.g. nqe/*.nqe). `--read-only` opts back out for untrusted goals.
    const allowedTools = ["WebFetch", "WebSearch", "Read"];
    if (!has(args, "read-only")) allowedTools.push("Write", "Edit", "Glob");
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
  const skills: Skill[] = [...codeSkills, ...agentSkills, ...claudeSkills, fallback];

  const registry = new ToolRegistry();
  for (const s of skills) for (const t of s.tools ?? []) registry.register(t);
  registry.register(httpFetchTool); // generic HTTP capability
  if (opts.weave && opts.newId) registry.register(spawnTaskTool(opts.weave, opts.newId)); // fan-out
  registry.register(notifyTool(channelsFrom(channelConfig(args)))); // notifications
  // recall: search accumulated knowledge so skills/inference build on prior reports (ADR-0021 §4).
  registry.register(recallTool(reportsDirFor(args), pickEmbedder(args)));
  if (has(args, "bash")) {
    // Opt-in shell access. Denylist always on; optional allowlist + timeout from flags.
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

const fmt = (e: SealedEvent): string =>
  `#${String(e.seq).padStart(4)} ${e.kind.padEnd(15)} ${e.actor.padEnd(12)} ${e.subject}`;

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
  return str(args, "pid-file", str(args, "db", DEFAULT_DB).replace(/\.db$/, "") + ".pid");
}
function logFileFor(args: Args): string {
  return str(args, "log-file", str(args, "db", DEFAULT_DB).replace(/\.db$/, "") + ".log");
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
  console.log(`weave: peer daemonized (pid ${child.pid}) — logs: ${logFile}, pid: ${pidFile}`);
  console.log(`weave: stop with — weave down${has(args, "db") ? ` --db ${str(args, "db", DEFAULT_DB)}` : ""}`);
  process.exit(0);
}

// --- commands --------------------------------------------------------------

async function cmdUp(args: Args): Promise<void> {
  if (has(args, "daemon") && !IS_DAEMON_CHILD) return daemonize(args);
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
  const pidFile = pidFileFor(args);
  if (!existsSync(pidFile)) {
    console.log(`weave: no pidfile at ${pidFile} — nothing to stop`);
    return;
  }
  const pid = Number(readFileSync(pidFile, "utf8").trim());
  if (!Number.isInteger(pid) || pid <= 0) {
    console.error(`weave: garbage pidfile ${pidFile}; removing`);
    rmSync(pidFile, { force: true });
    process.exitCode = 1;
    return;
  }
  try {
    process.kill(pid, "SIGTERM"); // ask the peer to shut down (it removes its own pidfile)
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ESRCH") {
      console.log(`weave: pid ${pid} already gone — clearing stale ${pidFile}`);
      rmSync(pidFile, { force: true });
      return;
    }
    throw e;
  }
  // Wait up to ~3s for graceful exit, polling liveness with signal 0.
  for (let i = 0; i < 30; i++) {
    await new Promise((r) => setTimeout(r, 100));
    try { process.kill(pid, 0); } catch { console.log(`weave: stopped peer (pid ${pid})`); return; }
  }
  console.error(`weave: pid ${pid} did not exit after SIGTERM; try: kill -9 ${pid}`);
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
 * shutdown). Read-only: probes liveness with signal 0 and never opens the substrate or mutates a
 * pidfile — `weave down` owns stale-pidfile cleanup, `ps` only reports it. A leftover file whose
 * process is gone shows as "stale"; a recycled, non-ours pid shows as "foreign".
 */
function cmdPs(args: Args): void {
  const dir = dirname(str(args, "db", DEFAULT_DB));
  let pidFiles: string[];
  try {
    pidFiles = readdirSync(dir).filter((f) => f.endsWith(".pid")).sort();
  } catch {
    pidFiles = []; // no .weave dir yet → nothing running
  }
  if (pidFiles.length === 0) {
    console.log(`weave: no peers running (no *.pid files in ${dir}/)`);
    return;
  }
  const rows = pidFiles.map((f) => {
    const raw = readFileSync(join(dir, f), "utf8").trim();
    const pid = Number(raw);
    if (!Number.isInteger(pid) || pid <= 0) return { f, pid: raw || "?", status: "invalid", cmd: "" };
    const status = pidLiveness(pid);
    return { f, pid: String(pid), status, cmd: status === "alive" ? pidCommand(pid) : "" };
  });
  const wF = Math.max(8, ...rows.map((r) => r.f.length));
  const wP = Math.max(3, ...rows.map((r) => r.pid.length));
  const alive = rows.filter((r) => r.status === "alive").length;
  console.log(`weave: ${alive} running, ${rows.length - alive} stale/other — pidfiles in ${dir}/`);
  console.log(`  ${"PIDFILE".padEnd(wF)}  ${"PID".padStart(wP)}  STATUS   COMMAND`);
  for (const r of rows) {
    console.log(`  ${r.f.padEnd(wF)}  ${r.pid.padStart(wP)}  ${r.status.padEnd(7)}  ${r.cmd}`);
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

  const workers = Math.max(1, num(args, "workers", 4));
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
  weave.close();
}

async function cmdLoop(args: Args): Promise<void> {
  const skill = str(args, "skill", "");
  if (!skill) {
    console.error('weave loop: --skill <name> required, e.g. weave loop --skill researcher --interval 6h "LLMs"');
    process.exitCode = 1;
    return;
  }
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
  const loop = new LoopRunner(new SystemTimer(), tick, parseDuration(interval), once);
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
  const limit = num(args, "limit", 8);
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
function buildChatGoal(utterance: string, history: readonly ChatTurn[], maxTurns = 4, maxChars = 1500): string {
  if (history.length === 0) return utterance;
  let ctx = "";
  for (const turn of history.slice(-maxTurns)) {
    const a = turn.a.length > 400 ? `${turn.a.slice(0, 397)}…` : turn.a;
    const block = `Q: ${turn.q}\nA: ${a}\n\n`;
    if (ctx.length + block.length > maxChars) break;
    ctx += block;
  }
  if (!ctx) return utterance;
  return `${utterance}\n\n--- Earlier in this conversation (context only; answer the request above) ---\n\n${ctx.trimEnd()}`;
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
): Promise<{ answer: string; ok: boolean; cancelled: boolean }> {
  return new Promise((resolve) => {
    const id = `chat-${randomUUID().slice(0, 8)}`;
    const spec: { goal: string; skill?: string; model?: string } = { goal };
    if (pinnedSkill) spec.skill = pinnedSkill;
    if (model) spec.model = model; // ADR-0022: per-turn tier (cheap for chat, escalates on hard asks)

    let detail = "thinking";
    let claimed = false;
    let frame = 0;
    let done = false;
    let subscription: { unsubscribe(): void } | undefined;
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
      if (tty) process.stdout.write("\r\x1b[K"); // wipe the spinner line
      resolve({ answer, ok, cancelled });
    };

    // Ctrl-C during a turn cancels the wait and returns to the prompt. The task keeps running on the
    // peer (no remote-cancel here), so its answer just lands in `weave report` / the log later.
    const onAbort = () => finish("cancelled (the task may still finish on the peer).", false, true);
    if (signal) {
      if (signal.aborted) return finish("cancelled.", false, true);
      signal.addEventListener("abort", onAbort);
    }

    const hint = setTimeout(() => {
      if (!claimed && !done) detail = "waiting for a peer to pick this up (is `weave up` running?)";
    }, 8000);
    const timer = setTimeout(() => {
      finish(
        claimed
          ? "the task didn't finish in time — try a simpler ask, or raise --timeout."
          : "no peer answered. Start one in another terminal: `weave up` (or `weave up --daemon`).",
        false,
      );
    }, timeoutMs);

    // Subscribe from head+1 BEFORE declaring, so an instant completion can't slip past the listener.
    void weave.head().then((head) => {
      if (done) return; // cancelled/timed out before we got here
      subscription = weave.subscribe(head + 1, (e) => {
        if (e.subject !== id) return;
        switch (e.kind) {
          case TaskKind.Claimed:
            claimed = true;
            detail = `working (${e.actor})`;
            break;
          case TaskKind.Progress:
            detail = (e.payload as ProgressPayload).note;
            break;
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

/** Offline text-to-speech via macOS `say` (zero new dependency, works offline — matches
 *  weave's ethos). Returns a speaker that voices text (markdown stripped) and can be
 *  interrupted (new turn / Ctrl-C kills any in-flight speech). No-op + one warning off macOS;
 *  the cloud/streaming half (STT + nicer TTS) layers in later behind a voice port. */
function makeSpeaker(enabled: boolean, voice?: string): { speak: (t: string) => void; stop: () => void; done: () => Promise<void> } {
  if (!enabled) return { speak: () => {}, stop: () => {}, done: () => Promise.resolve() };
  if (process.platform !== "darwin") {
    console.error("weave: --speak needs macOS `say` (offline TTS); voice output disabled.");
    return { speak: () => {}, stop: () => {}, done: () => Promise.resolve() };
  }
  // Default to a female voice ("Karen", en_AU). `say -v '?'` lists installed voices; "Samantha"
  // (en_US) is another solid default, premium "Ava"/"Zoe" need a download. Override with
  // --voice <name>; --voice "" = system default.
  const vArgs = voice ? ["-v", voice] : [];
  let proc: ReturnType<typeof spawn> | null = null;
  const stop = (): void => { if (proc) { proc.kill("SIGTERM"); proc = null; } };
  const speak = (text: string): void => {
    stop(); // interrupt any prior utterance
    const clean = text
      .replace(/```[\s\S]*?```/g, ". code block. ") // skip code fences
      .replace(/`([^`]+)`/g, "$1") // inline code
      .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1") // links -> label
      .replace(/https?:\/\/\S+/g, "a link")
      .replace(/[*_#>|]/g, "") // markdown punctuation
      .replace(/\s+/g, " ").trim();
    if (!clean) return;
    try {
      proc = spawn("say", vArgs, { stdio: ["pipe", "ignore", "ignore"] });
      proc.on("error", () => { proc = null; });
      proc.on("close", () => { proc = null; });
      proc.stdin?.end(clean);
    } catch { proc = null; }
  };
  // Resolve when the current utterance finishes — callers await this before re-opening the
  // mic so the TTS output isn't captured and re-transcribed (the echo bug).
  const done = (): Promise<void> => {
    const p = proc;
    return p ? new Promise((res) => p.on("close", () => res())) : Promise.resolve();
  };
  return { speak, stop, done };
}

/** Record from the macOS mic (avfoundation) until Enter, end-of-speech (VAD), or maxSecs, then
 *  transcribe with whisper-cli. Returns the cleaned transcript ("" on silence/failure).
 *  `awaitEnter` lets the caller's readline signal an early stop. When `vadFilter` is set, ffmpeg's
 *  silencedetect logs trailing silence and we stop automatically — so you don't wait out maxSecs. */
async function recordAndTranscribe(o: {
  awaitEnter: () => Promise<void>;
  micDevice: string; model: string; whisper: string; maxSecs: number;
  debug?: boolean; quiet?: boolean; vadFilter?: string; // vadFilter: ffmpeg silencedetect=…
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
  if (o.vadFilter && ff.stderr) {
    // Stop on the LAST silence_start past a small floor: ignores leading silence (ts≈0) and
    // triggers ~`d` seconds after you actually stop talking.
    let buf = "";
    ff.stderr.on("data", (d: Buffer) => {
      buf += d.toString();
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
  if (ffErr) { console.error("  ! ffmpeg not available (brew install ffmpeg) — cannot record."); return ""; }
  const tRec = systemClock.now();
  const wr = spawnSync(o.whisper, ["-m", o.model, "-f", wav, "-l", "en", "-nt", "-np", "-otxt", "-of", prefix], { encoding: "utf8" });
  let raw = "";
  try { raw = readFileSync(`${prefix}.txt`, "utf8"); } catch { raw = wr.stdout ?? ""; }
  const cleaned = raw.replace(/\[[^\]]*\]/g, " ").replace(/\s+/g, " ").trim(); // drop [BLANK_AUDIO] / [_TT_] markers
  if (o.debug) {
    console.error(`  [voice] mic=${o.micDevice} rec=${tRec - t0}ms whisper=${systemClock.now() - tRec}ms raw=${JSON.stringify(raw.trim())} → ${JSON.stringify(cleaned)}`);
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
      leaseMs: num(args, "lease-ms", 30_000), maxConcurrent: num(args, "concurrency", 2), tickMs: num(args, "tick-ms", 3_000) },
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
  const whisper = str(args, "whisper-bin", "whisper-cli");
  const model = str(args, "whisper-model", join(PACKAGE_ROOT, "models", "ggml-base.en.bin"));
  if (!existsSync(model)) return void console.error(`weave voice: whisper model not found at ${model}\n  Download e.g. ggml-base.en.bin from https://huggingface.co/ggerganov/whisper.cpp, or pass --whisper-model <path>.`);
  const micDevice = str(args, "mic", ":0"); // avfoundation audio index (`ffmpeg -f avfoundation -list_devices true -i ""`)
  const maxSecs = num(args, "max-secs", 20);
  // VAD: auto-stop a command recording shortly after you stop talking (ffmpeg silencedetect).
  // Tunable via --silence-db / --silence-secs; --no-vad records until Enter/maxSecs.
  const vadFilter = has(args, "no-vad") ? "" : `silencedetect=noise=${str(args, "silence-db", "-30")}dB:d=${str(args, "silence-secs", "1.2")}`;

  const weave = await openSubstrate(args);
  // --netops (or --persona netops, which implies it) embeds a peer so this is ONE command;
  // else rely on an external `weave up` peer. --no-serve forces the thin-client mode.
  const wantEmbeddedPeer = (has(args, "netops") || str(args, "persona", "") === "netops") && !has(args, "no-serve");
  const stopPeer = wantEmbeddedPeer ? await startEmbeddedPeer(args, weave) : null;
  const newId = (): string => randomUUID();
  const actor = str(args, "agent", `voice-${randomUUID().slice(0, 8)}`);
  const explicitSkill = has(args, "skill") ? str(args, "skill", "") : undefined;
  const pinnedSkill = explicitSkill; // undefined => route (NetOps utterances → forward-*)
  const timeoutMs = parseDuration(str(args, "timeout", "300s"));
  const speaker = makeSpeaker(!has(args, "no-speak"), str(args, "voice", "Karen")); // female voice by default
  const debug = has(args, "debug"); // surface each transcript + timing + wake-match decision
  const carry = !has(args, "no-context");
  const history: ChatTurn[] = [];

  // Wake-word mode (`--wake`, default phrase "hello forward"): hands-free. Listen in short chunks
  // until the phrase is heard, ack with "Hello", then record the question. Otherwise push-to-talk.
  const wake = has(args, "wake") ? (str(args, "wake", "") || "hello forward") : null;
  const wakeChunk = num(args, "wake-chunk", 4);
  const ackPhrase = str(args, "wake-ack", "Hello");
  const heardAck = str(args, "heard-ack", "On it."); // spoken when a command is captured (before the LLM turn)
  const norm = (s: string): string => s.toLowerCase().replace(/[^a-z0-9 ]+/g, " ").replace(/\s+/g, " ").trim();

  console.log("weave voice — talk to your weave.");
  console.log(wake
    ? `  hands-free: say "${wake}" to wake, then ask · type /quit or Ctrl-C to exit · model: ${model.split("/").pop()}\n`
    : `  push-to-talk: Enter to record, speak, Enter to stop · /quit exits · model: ${model.split("/").pop()}\n`);

  // Spoken self-introduction at startup (her name is Forward — same as the wake word).
  const intro = has(args, "no-intro") ? "" : str(args, "intro", "Hi, I'm Forward, your A I NetOps agent. Say, Hello Forward, to wake me, then ask your question.");
  if (intro) { speaker.speak(intro); await speaker.done(); }

  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const queue: string[] = [];
  let pending: ((v: string | null) => void) | null = null;
  let closed = false;
  let quit = false;
  rl.on("line", (l) => (pending ? (pending(l), (pending = null)) : queue.push(l)));
  rl.on("close", () => { closed = true; pending?.(null); });
  rl.on("SIGINT", () => { speaker.stop(); quit = true; pending?.(null); }); // Ctrl-C quits
  const nextLine = (): Promise<string | null> =>
    queue.length ? Promise.resolve(queue.shift()!) : closed ? Promise.resolve(null) : new Promise((r) => (pending = r));
  const drainQuit = (): boolean => { while (queue.length) if (queue.shift()!.trim() === "/quit") return true; return false; };

  for (;;) {
    if (quit || closed) break;
    let utterance: string;

    if (wake) {
      // Listen in short chunks until the wake phrase is heard (typed /quit or Ctrl-C breaks out).
      process.stdout.write(`👂 say "${wake}"…\r`);
      let woken = false;
      while (!woken && !quit && !closed) {
        if (drainQuit()) { quit = true; break; }
        const heard = await recordAndTranscribe({ awaitEnter: () => new Promise<void>(() => undefined), micDevice, model, whisper, maxSecs: wakeChunk, debug, quiet: true });
        const matched = !!heard && norm(heard).includes(norm(wake));
        if (debug) console.error(`  [voice] wake ${matched ? "MATCH ✓" : "no"} (heard ${JSON.stringify(heard)})`);
        if (matched) woken = true;
      }
      if (quit || closed) break;
      speaker.stop();
      speaker.speak(ackPhrase); // "Hello"
      await speaker.done(); // wait for the ack to finish so we don't record it
      await new Promise((r) => setTimeout(r, 300)); // small buffer for room echo
      console.log(`\n  (woke) — ask your question…`);
      utterance = await recordAndTranscribe({ awaitEnter: () => nextLine().then(() => undefined), micDevice, model, whisper, maxSecs, debug, vadFilter });
      if (!utterance) { console.log(`  (heard nothing — say "${wake}" again)\n`); continue; }
      console.log(`you (voice)› ${utterance}\n`);
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
        utterance = await recordAndTranscribe({ awaitEnter: () => nextLine().then(() => undefined), micDevice, model, whisper, maxSecs, debug, vadFilter });
        if (!utterance) { console.log("  (heard nothing — try again)\n"); continue; }
        console.log(`you (voice)› ${utterance}\n`);
      }
    }

    speaker.speak(heardAck); // ack: confirm we heard the command before the (silent) LLM turn
    const goal = carry ? buildChatGoal(utterance, history) : utterance;
    const turnModel = has(args, "no-tier") ? undefined : modelForGoal(args, utterance);
    const { answer, ok, cancelled } = await chatTurn(weave, newId, actor, goal, pinnedSkill, turnModel, timeoutMs, undefined);
    if (cancelled) { console.log(`  (${answer})\n`); continue; }
    console.log(`${ok ? "weave›" : "weave (failed)›"} ${answer}\n`);
    speaker.speak(answer);
    if (wake) await speaker.done(); // wait for the answer to finish before re-listening (no echo)
    history.push({ q: utterance, a: answer });
  }

  if (!closed) rl.close();
  speaker.stop();
  if (stopPeer) await stopPeer();
  weave.close();
  console.log("\nweave: bye.");
}

async function cmdChat(args: Args): Promise<void> {
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
  const timeoutMs = parseDuration(str(args, "timeout", "180s"));
  const carry = !has(args, "no-context");
  const history: ChatTurn[] = [];

  const mode = explicitSkill ? `skill: ${explicitSkill}` : route ? "routing by skill" : "conversational (general agent)";
  console.log("weave chat — talk to your weave. Just type and press enter; ask follow-ups naturally.");
  console.log(`  /help  /status  /reset  /quit   ·   ${mode}${carry ? "" : "   ·   context off"}`);
  console.log("  (thin client: a `weave up` peer answers; Ctrl-C cancels a turn, again at the prompt exits)\n");

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
    process.stdout.write("you› ");
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

    const goal = carry ? buildChatGoal(line, history) : line;
    // Classify on the raw utterance (not the context-carried goal): conversational turns → Haiku,
    // hard asks ("design…", "audit…") escalate to Opus. --no-tier leaves it to the peer's default.
    const turnModel = has(args, "no-tier") ? undefined : modelForGoal(args, line);
    turnAbort = new AbortController();
    const { answer, ok, cancelled } = await chatTurn(weave, newId, actor, goal, pinnedSkill, turnModel, timeoutMs, turnAbort.signal);
    turnAbort = null;
    if (cancelled) { console.log(`  (${answer})\n`); continue; } // don't pollute context with a cancel
    console.log(`${ok ? "weave›" : "weave (failed)›"} ${answer}\n`);
    speaker.speak(answer); // --speak: voice the response (offline, interruptible)
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

usage:
  weave up        [--db <path>] [--agent <id>] [--model <m>] [--fake]
                  [--concurrency N] [--lease-ms N] [--tick-ms N] [--compact-secs N]
                  [--daemon] [--pid-file <path>] [--log-file <path>]
                  start a peer: claim tasks + route them to skills
                  (--daemon detaches to the background; logs + pid default next to --db)
                  [--bash [--bash-allow prog1,prog2] [--bash-timeout-ms N]]
                  (--bash grants shell access: denylist always on, blocks rm -rf/sudo/etc.)
                  [--read-only]  (claude-cli backend grants Write/Edit/Glob by default —
                  durable working memory + serialize deliverables to disk; --read-only revokes them)
  weave pool      [--workers N] [--db <path>] [--model <m>] [--fake] [--concurrency N]
                  [--daemon] [--pid-file <path>] [--log-file <path>] [--bash ...]
                  supervise N lightweight peer processes (default 4) that claim work from
                  the shared weave; restarts crashed workers; stop the pool with weave down
  weave down      [--db <path>] [--pid-file <path>]   stop a daemonized peer or pool (SIGTERM)
  weave ps        [--db <path>]   list daemonized peers/pools (pidfiles next to --db) + liveness
  weave task <goal...>   [--skill <name>] [--db <path>] [--id <taskId>] [--model m | --no-tier]
                  (by default the goal is classified to a model tier — ADR-0022 — Haiku/Sonnet/Opus;
                  --model pins one, --no-tier leaves the choice to the claiming peer's default)
  weave loop --skill <name> [--interval 6h] [--once] [--notify ch] [goal...]
                  [--daemon] [--pid-file <path>] [--log-file <path>]
                  re-declare a task routed to <skill> each tick (a skill = a use-case)
                  (--daemon detaches to the background; stop with weave down)
  weave skills    [--skills-dir <dir>] [--claude-skills [--claude-skills-dir <dir>]] [--fake]
                  list code + declarative skills (--claude-skills inherits Claude SKILL.md)
  weave notify <text...> [--to slack,telegram,email] [--title T]
  weave compact   [--db <path>]   fold settled tasks into a snapshot + prune the log
  weave report    [--db <path>] [--full]   print completed task results (the actual output)
  weave index     [--db <path>] [--no-embed]   build the knowledge graph + search index over reports
                  (graph.json/graph.md + inline forward/backlinks; warms embeddings if configured)
  weave search    <query...> [--db <path>] [--limit N] [--no-embed]
                  hybrid (BM25 + optional embeddings) search over accumulated knowledge
  weave chat      [--db <path>] [--route] [--skill <name>] [--timeout 180s] [--no-context]
                  [--model m | --no-tier]
                  conversational REPL: each line is answered by the general agent (Ctrl-C cancels a
                  turn), follow-ups keep context; --route picks skills by keyword, --skill X pins one.
                  by default each turn is tiered by complexity (chat → Haiku, hard asks → Opus).
                  thin client — start a peer with 'weave up' to do the work
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

main().catch((err) => {
  console.error("weave: fatal —", err instanceof Error ? err.message : err);
  process.exitCode = 1;
});
