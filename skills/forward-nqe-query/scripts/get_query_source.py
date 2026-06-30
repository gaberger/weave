#!/usr/bin/env python3
"""Fetch NQE query source by path + commit.

Endpoint: GET /api/nqe/repos/{repo}/commits/{commitId}/queries?path={path}
Tries repo='fwd' first, falls back to repo='org' on 404, unless --repo is set.
"""
import argparse
import sys
from pathlib import Path

# Allow running from anywhere by fixing sys.path if invoked directly
sys.path.insert(0, str(Path(__file__).resolve().parent))
import _bootstrap  # noqa: F401 — side-effect: puts forward_client on sys.path

from forward_client import ForwardClient, ForwardError, NotFoundError
from skill_io import emit_error, emit_success, ERR_API, ERR_AUTH, ERR_INPUT, ERR_NOT_FOUND


def fetch(client: ForwardClient, repo: str, commit: str, path: str):
    endpoint = f"/api/nqe/repos/{repo}/commits/{commit}/queries"
    return client.get(endpoint, query={"path": path})


def main() -> int:
    p = argparse.ArgumentParser(description="Fetch NQE query source code")
    p.add_argument("--path", required=True, help="Full query path, e.g. /L3/Routes/BGP peers")
    p.add_argument("--commit-id", help="Specific commit ID (from catalog lastCommitId)")
    p.add_argument("--head", action="store_true",
                   help="Use 'head' as commit ID (latest)")
    p.add_argument("--repo", choices=["fwd", "org"],
                   help="Repository (default: try fwd, fall back to org)")
    args = p.parse_args()

    if not args.commit_id and not args.head:
        emit_error(ERR_INPUT, "provide --commit-id (from catalog) or --head")

    commit = args.commit_id or "head"
    repos = [args.repo] if args.repo else ["fwd", "org"]

    try:
        client = ForwardClient.from_env()
    except ForwardError as e:
        emit_error(ERR_AUTH, str(e))

    last_err = None
    for repo in repos:
        try:
            data = fetch(client, repo, commit, args.path)
        except NotFoundError as e:
            last_err = e
            continue
        except ForwardError as e:
            emit_error(ERR_API, str(e))
        # Tag the response with the repo we succeeded on
        if isinstance(data, dict):
            data.setdefault("_repository", repo)
        emit_success(data, meta={"path": args.path, "repo": repo, "commit": commit})
        return 0

    emit_error(ERR_NOT_FOUND, f"query not found in repos {repos}: {last_err}")
    return 1


if __name__ == "__main__":
    sys.exit(main())
