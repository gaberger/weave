---
name: weave
description: Drive the weave cooperative-agent harness from the CLI. Use when the user wants to run a multi-agent / swarm job, fan work out across autonomous Claude peers, declare tasks into a shared log, run a research or batch project through weave, or inspect a weave network (status / report / search / index). Triggers on "weave", "swarm", "peer pool", "fan out tasks", "declare a task", "weave up/task/status/report".
---

# Driving weave

weave is a domain-agnostic cooperative-agent harness. Work is **declared as tasks** into a shared SQLite event log; **autonomous peers** claim each task exactly once and run it through a **skill** (a use-case). Coordination happens through the log — there is no central boss.

**Mental model**
- **peer** — a worker process that claims tasks and routes them to skills (`weave up`, or `weave pool` for N peers).
- **task** — a unit of work declared into the log; claimed exactly once by one peer.
- **skill** — what a task runs (built-in `claude` general agent, or a `.ts`/`.md` dropped in `<home>/skills/`).
- **the log** — the shared event store every peer reads/writes; this is where coordination lives.
- **weave home** — where all state lives (`weave.db`, `reports/`, memory). Default `~/.weave`; override with `WEAVE_HOME` or `--workspace <dir>`. **weave refuses to use its own engine repo as a home.**

## The canonical loop

```bash
# 1. Pick a home OUTSIDE the engine repo (state + agent file tools are rooted here)
export WEAVE_HOME=~/weave-projects/myproject      # or pass --workspace <dir> per command

# 2. Start workers (leave running). claude CLI on PATH ⇒ real backend, no API key needed.
weave pool --workers 3 --daemon                   # supervised pool, restarts crashes; stop: weave down
#   weave up --fake                                # single offline peer (echo, no LLM) for smoke tests

# 3. Declare work — one task, or batch fan-out from a file (one goal per line)
weave task "summarize the architecture in docs/ and write reports/summary.md"
weave task --file tasks.txt                        # batch: one task per line  ('-' = stdin)

# 4. Watch it go free → held → done
weave status                                       # task states
weave log --follow                                 # live event feed (claims, leases, completions)

# 5. Collect output
weave report                                       # completed results (+ failure cause for errors)
weave report --json                                # machine-readable {taskId,actor,status,summary,error}

# 6. Stop workers
weave down
```

## Command reference (the useful subset)

| Command | What it does |
|---|---|
| `weave up [--fake] [--daemon] [--concurrency N] [--bash] [--read-only]` | start one peer. `--fake` = offline echo (no LLM). `--bash` grants shell (denylist always on). |
| `weave pool --workers N [--daemon]` | supervise N peers; restarts crashed workers. Stop with `weave down`. |
| `weave down` | SIGTERM a daemonized peer/pool. |
| `weave task <goal...> [--skill S] [--model M \| --no-tier] [--file path\|-]` | declare work. By default the goal is **tiered to a model** (Haiku/Sonnet/Opus, ADR-0022); `--model` pins one. `--file` = batch fan-out. |
| `weave status` | task states (free / held / done). |
| `weave log [--follow]` | shared event log. |
| `weave report [--full] [--json]` | completed results + failure causes. |
| `weave index [--no-embed]` | build the knowledge graph + search index over reports. |
| `weave search <query...> [--limit N]` | hybrid (BM25 + embeddings) search over accumulated knowledge. |
| `weave ps` / `weave networks` | list daemons + liveness / list networks under the home. |
| `weave compact` | fold settled tasks into a snapshot + prune the log. |
| `weave chat [--route] [--skill S]` | conversational REPL (needs a peer up to do the work). |
| `weave doctor [--lenient]` | check the hex architecture (used in this repo's CI). |

**Common flags accepted by every stateful command:**
- `--db <path>` — specific SQLite store (default `<home>/weave.db`).
- `--workspace <dir>` / `WEAVE_HOME` — the weave home for this run.
- `--network-id <id>` — isolate a named network under `<home>/networks/<id>/` (own log, env, reports).
- `--target <dir>` — root the agent's **read-only** file tools at `<dir>` to inspect a repo without making it the workspace (analyze any repo, incl. the engine, no guard trip).

## Backends (ADR-0003)

Worker backend is auto-selected: **`ANTHROPIC_API_KEY` set → Claude SDK**; else **`claude` CLI on PATH → claude-cli worker** (uses Claude Code login, no key, grants Write/Edit/Glob by default); else **none → tasks are ECHOED, not run** (a silent no-op trap — pass `--fake` to acknowledge offline mode intentionally). The `up`/`pool` banner prints `llm: <backend>`; verify it says `claude-cli` or `claude-sdk`, not `echo`, before trusting results.

## Recipes

**Multi-section research / report project** — decompose into independent sections, one task per line in a file, instruct each task to write `reports/<topic>/<slug>.md`, fan out with `--file`, run a pool, then `weave index` + `weave search`, and finally declare one synthesis task that reads the section files.

**Analyze an external repo read-only** — `weave task "audit auth flow" --target /path/to/repo` (read/grep rooted there; no `--bash`, no guard trip).

**Isolated experiment** — add `--network-id exp1` to every command to keep its log/reports/env separate from the default network.

## Gotchas
- **Never run with the weave engine repo as the home** — it refuses (the guard). Always set `WEAVE_HOME`/`--workspace` to a project dir.
- **Tasks are async.** `weave task` returns immediately; results appear later via `status`/`report`. If nothing runs, check a peer is up (`weave ps`) and the backend isn't `echo`.
- **Long tasks look "stuck" in `status`** (which shows a window); check `weave log` for `task.claimed`/`lease.renewed`/`task.completed` to confirm real progress.
- **Tiering** routes each task to a model by complexity; pin with `--model sonnet` (or `--no-tier`) when you want determinism.
