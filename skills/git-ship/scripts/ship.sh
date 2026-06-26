#!/usr/bin/env bash
# git-ship — take the current working tree all the way to merged: branch (if on the default branch),
# commit, push, open a PR, watch CI, merge on green, delete the branch, and sync the default branch.
# Deterministic so the agent doesn't free-hand git/gh. Idempotent-ish: re-running picks up where it left off.
#
#   ship.sh -m "<commit message>" [-t "<pr title>"] [-b "<pr body>"] \
#           [--base <branch>] [--branch <name>] [--no-merge] [--squash]
#
# Requires: git, and `gh` authenticated (gh auth status). Exit non-zero on CI failure (does NOT merge).
set -euo pipefail

usage() { sed -n '2,12p' "$0"; exit 2; }

MSG=""; TITLE=""; BODY=""; BASE=""; BRANCH=""; MERGE=1; METHOD="--merge"; ALLOW_NO_CI=0
while [ $# -gt 0 ]; do case "$1" in
  -m) MSG="${2:-}"; shift 2;;
  -t) TITLE="${2:-}"; shift 2;;
  -b) BODY="${2:-}"; shift 2;;
  --base) BASE="${2:-}"; shift 2;;
  --branch) BRANCH="${2:-}"; shift 2;;
  --no-merge) MERGE=0; shift;;
  --squash) METHOD="--squash"; shift;;
  --allow-no-ci) ALLOW_NO_CI=1; shift;;
  -h|--help) usage;;
  *) echo "ship: unknown arg '$1'" >&2; usage;;
esac; done
[ -n "$MSG" ] || { echo "ship: -m <message> is required" >&2; usage; }

command -v gh >/dev/null || { echo "ship: 'gh' not found on PATH" >&2; exit 1; }
gh auth status >/dev/null 2>&1 || { echo "ship: gh not authenticated — run: gh auth login" >&2; exit 1; }

# Default branch: origin/HEAD, else main.
BASE="${BASE:-$(git symbolic-ref --quiet --short refs/remotes/origin/HEAD 2>/dev/null | sed 's#^origin/##')}"
BASE="${BASE:-main}"

slug() { printf '%s' "$1" | tr '[:upper:]' '[:lower:]' | sed -E 's/[^a-z0-9]+/-/g; s/^-+|-+$//g' | cut -c1-48; }

CUR="$(git rev-parse --abbrev-ref HEAD)"
# Never commit straight to the default branch — branch first (global rule).
if [ "$CUR" = "$BASE" ]; then
  BRANCH="${BRANCH:-ship/$(slug "$MSG")}"
  echo "ship: on $BASE — creating branch $BRANCH"
  git checkout -b "$BRANCH"
  CUR="$BRANCH"
fi

# Stage everything (INCLUDING untracked files — `git diff` alone misses those), then commit if the
# index has anything. Skip cleanly if the tree was already clean.
git add -A
if git diff --cached --quiet; then
  echo "ship: working tree clean — nothing to commit"
else
  git commit -m "$MSG"
  echo "ship: committed on $CUR"
fi

git push -u origin "$CUR"

# Open a PR if one doesn't already exist for this branch.
if ! gh pr view "$CUR" >/dev/null 2>&1; then
  gh pr create --base "$BASE" --head "$CUR" --title "${TITLE:-$MSG}" --body "${BODY:-$MSG}"
fi
PR="$(gh pr view "$CUR" --json number -q .number)"
echo "ship: PR #$PR  ($(gh pr view "$PR" --json url -q .url))"

[ "$MERGE" = 1 ] || { echo "ship: opened PR #$PR (--no-merge) — review and merge it yourself"; exit 0; }

# CI registers asynchronously: right after PR creation `gh pr checks --watch` errors with "no checks
# reported" before any check appears (a race). Wait for at least one check to register first.
echo "ship: waiting for CI checks to register on PR #$PR …"
for _ in $(seq 1 20); do
  [ -n "$(gh pr checks "$PR" 2>/dev/null)" ] && break
  sleep 6
done
if [ -z "$(gh pr checks "$PR" 2>/dev/null)" ]; then
  # No CI configured for this repo/branch.
  if [ "$ALLOW_NO_CI" = 1 ]; then
    echo "ship: no CI checks on PR #$PR — merging anyway (--allow-no-ci)"
  else
    echo "ship: no CI checks registered on PR #$PR — NOT merging (use --no-merge to open-only, or --allow-no-ci to merge)" >&2
    exit 1
  fi
else
  echo "ship: watching CI for PR #$PR …"
  if ! gh pr checks "$PR" --watch --interval 15; then
    echo "ship: CI did not pass for PR #$PR — NOT merging" >&2
    exit 1
  fi
fi

gh pr merge "$PR" "$METHOD" --delete-branch
git checkout "$BASE"
git pull --ff-only origin "$BASE"
echo "ship: merged PR #$PR ($METHOD) and synced $BASE ✓"
