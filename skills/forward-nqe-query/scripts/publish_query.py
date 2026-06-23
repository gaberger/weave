#!/usr/bin/env python3
"""Publish an NQE query to a Forward repository (org by default).

The NQE repo is edited with a two-step **workspace-draft -> commit** flow (all
undocumented; discovered + verified against beta3.fwd.app):

  1. STAGE into the calling user's private workspace draft (reversible, not live):
       POST /api/users/current/nqe/changes?action=addQuery&path=<path>
            body {"sourceCode": "<nqe>"}
       POST /api/users/current/nqe/changes?action=editQuery&path=<path>
            body {"basis": {"queryId","commitId"}, "sourceCode": "<nqe>"}
     `editQuery` PRESERVES the queryId, so any intent check bound to it keeps
     working — always prefer it over delete+re-add (which mints a new queryId and
     orphans checks). This script auto-selects add vs edit by whether <path> already
     exists in the repo.

  2. COMMIT the draft to the repo (the only org-wide-blast-radius step):
       POST /api/nqe/repos/<repo>/commits
            body {"paths":[<path>], "message":{"title","body"}}
     `paths` SCOPES the commit — only the listed path publishes, so unrelated dirs
     (e.g. other users' /Users/*) are structurally protected. `message` is a
     CommitMessage OBJECT {title, body}, not a string.

Default is a DRY RUN: it resolves add-vs-edit and prints the plan WITHOUT staging or
committing. Pass --execute to actually stage + commit.

Gotchas baked in:
  - addQuery requires the enclosing directory to already exist (in the repo or the
    draft). A 409 ENCLOSING_DIR_DOES_NOT_EXIST is surfaced with a hint.
  - The `fwd` library repo is read-only/shipped — never write to it (use --repo org).
  - Validate query SYNTAX first with run_query.py; a syntactically broken query will
    stage + commit fine and then fail at run time.
"""
import argparse
import json
import sys
import urllib.parse
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import _bootstrap  # noqa: F401 — side-effect: puts forward_client on sys.path

from forward_client import ForwardClient, ForwardError, emit_json, die


CHANGES = "/api/users/current/nqe/changes"


def find_existing(client: ForwardClient, repo: str, path: str):
    """Return the head repo entry for `path` (or None) — basis for editQuery."""
    data = client.get(f"/api/nqe/repos/{repo}/commits/head/queries")
    for q in data.get("queries", []):
        if q.get("path") == path:
            return q
    return None


def main() -> int:
    p = argparse.ArgumentParser(
        description="Publish (add or update) an NQE query to a Forward repo via "
                    "workspace-draft -> commit. Dry-run unless --execute.")
    p.add_argument("--path", required=True,
                   help='Target query path in the repo, e.g. "/Production/SR/Plane Validation"')
    src = p.add_mutually_exclusive_group(required=True)
    src.add_argument("--file", help="Local file containing the NQE source")
    src.add_argument("--source", help="NQE source as a string")
    p.add_argument("--repo", default="org", choices=["org"],
                   help="Target repo (default: org; 'fwd' is read-only and refused)")
    p.add_argument("--title", help="Commit message title (default: derived from action+path)")
    p.add_argument("--body", default="", help="Commit message body")
    p.add_argument("--execute", action="store_true",
                   help="Actually stage + commit (default is a dry-run plan)")
    p.add_argument("--keep-draft-on-error", action="store_true",
                   help="On commit failure, leave the staged change in the draft "
                        "(default: discard just this path so the workspace stays clean)")
    args = p.parse_args()

    if args.file:
        try:
            source = Path(args.file).read_text()
        except OSError as e:
            die(f"cannot read --file {args.file}: {e}")
    else:
        source = args.source

    try:
        client = ForwardClient.from_env()
    except ForwardError as e:
        die(str(e))

    # Resolve add vs edit
    try:
        existing = find_existing(client, args.repo, args.path)
    except ForwardError as e:
        die(str(e))

    action = "editQuery" if existing else "addQuery"
    qid = existing.get("queryId") if existing else None
    basis_commit = existing.get("lastCommitId") if existing else None

    plan = {
        "action": action,
        "repo": args.repo,
        "path": args.path,
        "sourceBytes": len(source),
        "queryId": qid or "(server-assigned on add)",
        "preservesQueryId": bool(existing),
    }

    if not args.execute:
        sys.stderr.write(
            f"DRY RUN — would {action} {args.path!r} in repo '{args.repo}'.\n"
            f"  {'updates existing query, queryId PRESERVED' if existing else 'creates new query'}"
            f"{f' ({qid})' if qid else ''}\n"
            f"  source: {len(source)} bytes. Re-run with --execute to stage + commit.\n")
        emit_json(plan)
        return 0

    # --- STAGE ---
    qp = urllib.parse.quote(args.path)
    if action == "addQuery":
        stage_body = {"sourceCode": source}
    else:
        stage_body = {"basis": {"queryId": qid, "commitId": basis_commit}, "sourceCode": source}
    try:
        client.post(f"{CHANGES}?action={action}&path={qp}", body=stage_body)
    except ForwardError as e:
        if "ENCLOSING_DIR_DOES_NOT_EXIST" in str(e):
            parent = args.path.rsplit("/", 1)[0] + "/"
            die(f"staging failed: enclosing directory {parent!r} does not exist. "
                f"Create it first (action=addDir&path={parent}) or pick an existing folder.")
        die(f"staging failed: {e}")

    draft = client.get(CHANGES).get("changes", [])
    # Forward stages NOTHING when the new source is byte-identical to the committed
    # version (sourceCodeSha unchanged) — an editQuery no-op. Detect it and exit
    # cleanly instead of letting the commit 409 with a confusing "no changes".
    staged_here = any(ch.get("path") == args.path for ch in draft)
    if not staged_here:
        sys.stderr.write(f"no change to publish — {args.path!r} already matches the "
                         f"committed source. Nothing to commit.\n")
        emit_json({"published": False, "noop": True, "reason": "source identical to committed",
                   "path": args.path, "repo": args.repo, "queryId": qid})
        return 0
    sys.stderr.write(f"staged {action} for {args.path!r}; draft now holds {len(draft)} change(s).\n")

    # --- COMMIT (scoped to just this path) ---
    title = args.title or f"{'Update' if existing else 'Add'} NQE query {args.path}"
    commit_body = {"paths": [args.path], "message": {"title": title, "body": args.body}}
    try:
        client.post(f"/api/nqe/repos/{args.repo}/commits", body=commit_body)
    except ForwardError as e:
        if not args.keep_draft_on_error:
            # Best-effort: discard just our staged change so the workspace stays clean.
            try:
                client.post(f"{CHANGES}?action=bulkDiscard", body={"paths": [args.path]})
                sys.stderr.write("commit failed — discarded the staged change for this path.\n")
            except ForwardError:
                sys.stderr.write("commit failed — could NOT auto-discard; the change "
                                 "remains staged in your workspace draft.\n")
        die(f"commit failed: {e}")

    # --- VERIFY ---
    after = find_existing(client, args.repo, args.path)
    result = {
        "published": bool(after),
        "action": action,
        "path": args.path,
        "repo": args.repo,
        "queryId": after.get("queryId") if after else None,
        "queryIdPreserved": bool(existing) and after and after.get("queryId") == qid,
        "headCommit": client.get(f"/api/nqe/repos/{args.repo}/commits/head"),
    }
    sys.stderr.write(
        f"published {args.path!r} ({action}); queryId="
        f"{result['queryId']}{' (preserved)' if result['queryIdPreserved'] else ''}.\n")
    emit_json(result)
    return 0


if __name__ == "__main__":
    sys.exit(main())
