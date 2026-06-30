#!/usr/bin/env python3
"""Restore a Forward change-set to a historical commit.

POST /api/networks/{networkId}/change-sets/{changeSetId}/commits/{commitId}?action=restore

Rolls the change-set's draft state back to the named commit. The current
draft is overwritten — destructive. Requires --yes to execute.

Use get_version_history.py to find the commit ID to restore to.
"""
import argparse
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import _bootstrap  # noqa: F401

from forward_client import ForwardClient, ForwardError
from skill_io import emit_success, emit_error, ERR_API, ERR_INPUT


def main() -> int:
    p = argparse.ArgumentParser(
        description="Restore a Forward change-set to a historical commit"
    )
    p.add_argument("--network-id", required=True)
    p.add_argument("--changeset-id", required=True, help="Change-set ID, e.g. CHG-7")
    p.add_argument("--commit-id", required=True, help="Commit ID to restore to")
    p.add_argument(
        "--yes",
        action="store_true",
        help="Required to execute (overwrites current draft — destructive)",
    )
    p.add_argument("--dry-run", action="store_true", help="Show the request without calling API")
    args = p.parse_args()

    path = (
        f"/api/networks/{args.network_id}/change-sets/{args.changeset_id}"
        f"/commits/{args.commit_id}"
    )

    if args.dry_run:
        emit_success(
            {"method": "POST", "path": path, "query": {"action": "restore"}},
            meta={"dry_run": True},
        )

    if not args.yes:
        emit_error(
            ERR_INPUT,
            f"restoring to commit {args.commit_id} overwrites the current draft; "
            "pass --yes to confirm",
            hint="re-run with --yes",
        )

    try:
        client = ForwardClient.from_env()
        result = client.post(path, {}, query={"action": "restore"})
    except ForwardError as e:
        emit_error(ERR_API, str(e))

    emit_success(
        result,
        meta={
            "network_id": args.network_id,
            "changeset_id": args.changeset_id,
            "commit_id": args.commit_id,
        },
    )
    return 0


if __name__ == "__main__":
    sys.exit(main())
