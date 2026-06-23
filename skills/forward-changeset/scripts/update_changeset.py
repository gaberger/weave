#!/usr/bin/env python3
"""Update (rename / edit) a Forward change-set.

PATCH /api/networks/{networkId}/change-sets/{id}

Sends a ChangeSetPatch — only supply the fields you want to change.
Returns the updated ChangeSet record.
"""
import argparse
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import _bootstrap  # noqa: F401

from forward_client import ForwardClient, ForwardError, emit_json, die


def main() -> int:
    p = argparse.ArgumentParser(description="Update a Forward change-set")
    p.add_argument("--network-id", required=True)
    p.add_argument("--changeset-id", required=True, help="Change-set ID, e.g. CHG-7")
    p.add_argument("--name", default=None, help="New name for the change-set")
    p.add_argument("--snapshot-id", default=None, help="New base snapshot ID")
    p.add_argument("--dry-run", action="store_true", help="Print request body without calling API")
    args = p.parse_args()

    patch: dict = {}
    if args.name is not None:
        patch["name"] = args.name
    if args.snapshot_id is not None:
        patch["snapshotId"] = args.snapshot_id

    if not patch:
        die("provide at least one field to update: --name or --snapshot-id")

    if args.dry_run:
        emit_json(
            {
                "method": "PATCH",
                "path": f"/api/networks/{args.network_id}/change-sets/{args.changeset_id}",
                "body": patch,
            }
        )
        return 0

    try:
        client = ForwardClient.from_env()
        result = client.patch(
            f"/api/networks/{args.network_id}/change-sets/{args.changeset_id}",
            patch,
        )
    except ForwardError as e:
        die(str(e))

    emit_json(result)
    return 0


if __name__ == "__main__":
    sys.exit(main())
