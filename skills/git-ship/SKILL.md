---
name: git-ship
description: Take the current working tree all the way to merged — branch, commit, push, open a PR, watch CI, merge on green, delete the branch, sync the default branch. Use when the user says "ship this", "ship it", "open a PR and merge", "commit and ship", "merge on green", "land this change", or asks to take a change from working-tree to merged. Not for inspecting history, resolving conflicts, or rebasing — this is the happy-path ship flow only.
allowed-tools: Bash(git *), Bash(gh *), Read
---

# git-ship

Ship the current change end-to-end. This is the deterministic version of the branch → commit → push →
PR → watch-CI → merge-on-green → delete-branch → sync flow — drive the script, don't free-hand `git`/`gh`.

## Invocation

Run from the repo's working directory (so `git`/`gh` operate on the right repo). The script branches
off the default branch automatically if you're on it, commits any pending work, opens the PR, **waits
for CI, and merges only if every check passes** (otherwise it stops and reports the failure).

```bash
# Full ship (commit → PR → watch CI → merge on green → delete branch → sync default):
bash "${CLAUDE_PLUGIN_ROOT}/skills/git-ship/scripts/ship.sh" -m "<commit message>"

# With an explicit PR title/body:
bash "${CLAUDE_PLUGIN_ROOT}/skills/git-ship/scripts/ship.sh" -m "<msg>" -t "<PR title>" -b "<PR body>"

# Stop after opening the PR (let a human review/merge):
bash "${CLAUDE_PLUGIN_ROOT}/skills/git-ship/scripts/ship.sh" -m "<msg>" --no-merge

# Squash-merge instead of a merge commit; or target a non-default base:
bash "${CLAUDE_PLUGIN_ROOT}/skills/git-ship/scripts/ship.sh" -m "<msg>" --squash --base develop

# Repo with no CI configured — merge without waiting for checks (opt-in):
bash "${CLAUDE_PLUGIN_ROOT}/skills/git-ship/scripts/ship.sh" -m "<msg>" --allow-no-ci
```

The script waits for CI checks to *register* before watching them (they appear a few seconds after PR
creation), then merges only on green. If no checks ever register it refuses to merge unless `--allow-no-ci`.

## Rules

- **Write a real commit message.** `-m` is required; make it a conventional, descriptive subject
  (e.g. `feat(x): …`, `fix(y): …`). It doubles as the PR title/body unless `-t`/`-b` are given.
- **CI gates the merge.** If `gh pr checks --watch` reports any non-passing check, the script exits
  non-zero WITHOUT merging — report which check failed and stop; do not force the merge.
- **Never commit to the default branch.** The script branches first when you're on it; don't override
  that unless the user explicitly asks.
- Requires `gh` authenticated (`gh auth status`). If it isn't, say so — don't try to authenticate.
- If the working tree is clean and a PR already exists, the script resumes at the watch/merge step
  (safe to re-run).

## When it fails

Report the exact failing step and CI check by name (the script prints them), then stop. Do not retry
blindly or try alternate git commands to force the change through.
