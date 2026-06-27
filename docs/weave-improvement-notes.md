# weave improvement notes — from dogfooding (ADR self-evaluation, 2026-06-26)

> **Status (2026-06-26):** items 1–7 addressed on branch `feat/weave-improvements` — SDK-in-binary
> fix (#1), `--target` inspect mode (#2), error visibility (#3), `weave task --file` batch (#4),
> `weave report --json` (#5), resolved-db-path log (#6), reworded peer hint (#7). All validated live.
>
> **Verification follow-up (2026-06-26, merged):** items 1–7 were *validated live only* — no automated
> tests, so CI couldn't catch a regression. Closed that gap with mutation-proven harnesses (PRs #10–#12).
> Building the tests surfaced **three new bugs** and **two weak tests**. See "Verification follow-up" below.

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

## Verification follow-up (2026-06-26) — what testing the improvements found

Items 1–7 shipped "validated live." That phrase hid a real gap: a manual run proves a feature *worked
once*, not that it *can't silently break*. Converting "ran it and it worked" → "CI fails if it
regresses" required harnesses for the new surfaces — and the act of writing them surfaced bugs the live
runs had missed. The honest unit of confidence is "which paths have a test that goes red when the fix is
reverted," and that's now the standard these meet (each guard below was mutation-tested).

### New bugs found by building the `git-ship` skill's test harness (`skills/git-ship/ship.test.ts`)
The skill (#4-adjacent: deterministic branch→commit→push→PR→watch-CI→merge) had no test; its bugs were
caught only by dogfooding. The harness drives the **real `ship.sh`** against **real git** (working repo →
local bare remote) with a **fake `gh`** on PATH. It found:
- **Bug A — untracked files never committed.** `git diff` (without `git add`/`--cached`) misses untracked
  files, so a brand-new file pushed an empty branch and PR creation failed. Fix: `git add -A` then
  `git diff --cached --quiet`. (Originally caught by dogfooding; now regression-guarded.)
- **Bug B — CI-checks race.** `gh pr checks --watch` errors "no checks reported" in the window before CI
  registers, read as "CI failed." Fix: wait-for-register loop, then watch. The fake `gh`'s `--watch`
  fails if called before registration, so the guard can't pass vacuously.
- **Bug C — dead `BASE:-main` fallback (NEW, found on the harness's first run).** Under `set -euo
  pipefail`, in a repo whose `origin/HEAD` isn't set locally, `git symbolic-ref` fails → `pipefail`
  aborts the script *before* the `:-main` fallback applies. The defensive-looking code was unreachable.
  Fix: `... | sed ... || true`. **Lesson:** `set -e` + `pipefail` + command-substitution-in-assignment
  silently defeats `${x:-default}` fallbacks; guard the pipeline with `|| true`.

### CLI-feature harness (PR #12) — guards for surfaces that were live-validated only
- `--target` (#2): extracted the inline tool-wiring out of `cli.ts`'s 2882-line `main()` into a testable
  seam (`src/composition/inspect-tools.ts`) so the **least-privilege invariant** (target ⇒ read-only,
  no `edit_file`, rooted/confined to target) is asserted, not just commented. *To test a behavior, first
  give it a name and a boundary.*
- error visibility (#3) + `--json` (#5) + `--file` (#4): `src/cli-features.test.ts` drives the **real
  `cli.ts` as a subprocess** against a substrate seeded through the real `append` seam — no mocks of the
  wiring. Pins the `--json` row shape, the failed-task error surfacing, `fmt`'s first-error-line
  truncation in `weave log`, and `task --file` batch + stdin.
- pack loading (ADR-0016 Ring 2): `src/composition/pack.test.ts` pins frontmatter parsing, defaults,
  `null` fallbacks, `globToRegExp`, and aux-file reads — the whole "netops is just a pack dir" contract.

### Two weak tests caught by mutation testing (not by review)
A green test means nothing until you've watched it fail for the right reason. The mutation sweep exposed:
- **`ship.sh` mutation via `seq 1 0`** prints `1\n0` on macOS (BSD seq) — *two* iterations, not zero — so
  a "skip the wait loop" mutant still polled and the test passed. The mutation was wrong, not the guard;
  re-done by deleting the loop outright.
- **`fmt` first-line test** split the log on `\n` and only inspected the `task.failed` line; when the
  whole multi-line error leaks, the embedded newline drops the stack onto a *continuation* line a
  per-line check never sees. Fixed to assert against the **entire** output. **Lesson:** when the thing
  you're guarding against is a stray newline, never assert per-line.

### Still not proven (honest gaps)
- Live SDK/peer paths stay `skip`-gated behind `ANTHROPIC_API_KEY` (no key in CI, by design).
- LLM-driven outputs (the ADR verdicts) are non-deterministic — validated by running, not assertion;
  ADR-0007's verdict flipped between runs. "Fixed" there means "ran," not "reproducible."

## What worked well (keep)
- `--concurrency N` on a single peer cleanly fanned out the batch (≈4 waves for 20 tasks).
- The substrate claim/lease path "just worked" once the SDK ran under node+tsx — declare → claim →
  complete → report, exactly once each.
- Prompt-forced structured output made results trivially parseable; argues for #5 as a built-in.
