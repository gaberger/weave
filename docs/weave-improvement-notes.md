# weave improvement notes — from dogfooding (ADR self-evaluation, 2026-06-26)

> **Status (2026-06-26):** items 1–7 addressed on branch `feat/weave-improvements` — SDK-in-binary
> fix (#1), `--target` inspect mode (#2), error visibility (#3), `weave task --file` batch (#4),
> `weave report --json` (#5), resolved-db-path log (#6), reworded peer hint (#7). All validated live.

Observations from using weave itself to evaluate its own ADRs (declare one task per ADR →
claude-sdk peers read the engine + grep source → structured verdict reports). Ordered roughly by
impact. These are *use-case-driven* gaps, not bugs in the merged work.

## 1. The compiled `./weave` binary can't run the Claude SDK  (highest impact)
- Symptom: SDK workers fail with `Native CLI binary for darwin-arm64 not found. Reinstall
  @anthropic-ai/claude-agent-sdk without --omit=optional, or set options.pathToClaudeCodeExecutable.`
- Cause: `bun build --compile` bundles the SDK's JS but not its native Claude Code executable
  (an optional dep). Real LLM work only runs under `node --import tsx src/cli.ts`.
- Fix options: (a) set `options.pathToClaudeCodeExecutable` to a resolved path at runtime;
  (b) ship/locate the native dep alongside the binary; (c) detect at **startup** and fail loudly
  with this guidance instead of erroring per-task; (d) document the binary as offline/`--fake`-only.

## 2. No first-class "inspect a target repo" mode (vs the workspace guard)
- Evaluating the engine's own ADRs is a legit *read-only meta* task, but the engine-repo guard
  refuses it, and the workspace's file tools are rooted at the home, not the target. Workaround:
  temp home + full `--bash` so the worker `cat`/`grep`s the engine by absolute path.
- Improvement: a read-only `--target <dir>` that roots the read/grep file tools at an arbitrary
  directory **without** making it the workspace (so no guard trip, no Bash needed). This is the
  generic "audit/review another repo" use-case — least-privilege per ADR-0004.

## 3. Worker errors are nearly invisible
- A failed worker shows only `claude worker errored` in `weave report`; the real message lived only
  in the `task.failed` event payload in SQLite. The peer log didn't surface it either.
- Improvement: print the failure reason in `weave report --full` / `weave status`, and echo worker
  exceptions to the peer log/stderr.

## 4. No batch task declaration
- Declaring 20 ADR tasks required a bash `for` loop calling `weave task` 20×.
- Improvement: `weave task --file <goals.txt>` or `weave task -` (read goals from stdin, one per
  line). Natural fit for "map a prompt over a list of inputs."

## 5. No machine-readable output
- Parsing verdicts back out of `weave report` text is fragile (I prompt-forced a `VERDICT:/EVIDENCE:/
  GAPS:` shape to make it parseable).
- Improvement: `weave report [--json]` and `weave report <taskId> [--json]`; optionally a per-skill
  declared output schema so results are structured by construction.

## 6. `WEAVE_HOME` nesting is surprising for ad-hoc homes
- `WEAVE_HOME=/tmp/weave-adr` put state under `/tmp/weave-adr/.weave/` (the `stateRoot()` project-dir
  convention: only a dir literally named `.weave` holds state directly). Fine, but surprised me when
  I went to read the db by hand.
- Improvement: treat an *explicit* `WEAVE_HOME`/`--workspace` as the state root directly (no auto
  `.weave/` nest), or at least log the resolved db path on startup.

## 7. Minor: spurious "no peer running for this network"
- `weave task` printed `→ no peer running for this network` even though a background peer claimed the
  task ~instantly (confirmed by `weave status` showing `[held by …]`). The check races the claim.

## What worked well (keep)
- `--concurrency N` on a single peer cleanly fanned out the batch (≈4 waves for 20 tasks).
- The substrate claim/lease path "just worked" once the SDK ran under node+tsx — declare → claim →
  complete → report, exactly once each.
- Prompt-forced structured output made results trivially parseable; argues for #5 as a built-in.
