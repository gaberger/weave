#!/usr/bin/env python3
"""List the commit history of a Forward change-set.

GET /api/networks/{networkId}/change-sets/{id}?view=version-history

Returns a list of CommittedChangeSet records — each has a commitId, note,
timestamp, and attribution. Use --json for raw output, or pipe into
restore_commit.py to roll back to a specific version.
"""
import argparse
import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import _bootstrap  # noqa: F401

from forward_client import ForwardClient, ForwardError, emit_json, die


def main() -> int:
    p = argparse.ArgumentParser(description="List commit history for a Forward change-set")
    p.add_argument("--network-id", required=True)
    p.add_argument("--changeset-id", required=True, help="Change-set ID, e.g. CHG-7")
    p.add_argument("--json", action="store_true", help="Emit raw JSON only")
    args = p.parse_args()

    try:
        client = ForwardClient.from_env()
        result = client.get(
            f"/api/networks/{args.network_id}/change-sets/{args.changeset_id}",
            query={"view": "version-history"},
        )
    except ForwardError as e:
        die(str(e))

    if args.json:
        emit_json(result)
        return 0

    if not result:
        sys.stdout.write(
            f"No commits found for change-set {args.changeset_id}. "
            "Use commit_changeset.py to create a version checkpoint.\n"
        )
        return 0

    sys.stdout.write(
        f"{len(result)} commit(s) in change-set {args.changeset_id} "
        "(most recent first):\n"
    )
    for entry in result:
        action = entry.get("action", {})
        commit_id = action.get("id", entry.get("commitId", "?"))
        note = action.get("note", entry.get("note", ""))
        performed_at = action.get("performedAt", action.get("createdAt", ""))
        actor = (action.get("performedBy") or {}).get("username", "")
        sys.stdout.write(
            f"  {commit_id}  \"{note}\""
            + (f"  by={actor}" if actor else "")
            + (f"  at={performed_at}" if performed_at else "")
            + "\n"
        )
    sys.stdout.write("\n")
    emit_json(result)
    return 0


if __name__ == "__main__":
    sys.exit(main())
