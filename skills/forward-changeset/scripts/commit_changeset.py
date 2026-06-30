#!/usr/bin/env python3
"""Commit draft changes in a Forward change-set (save a version checkpoint).

POST /api/networks/{networkId}/change-sets/{id}?action=commit&note={note}

Creates a named version of the current draft state. Returns ChangeSetCommitMetadata
with the commit ID, note, and attribution (who committed + when).
"""
import argparse
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import _bootstrap  # noqa: F401

from forward_client import ForwardClient, ForwardError
from skill_io import emit_success, emit_error, ERR_API


def main() -> int:
    p = argparse.ArgumentParser(description="Commit draft changes in a Forward change-set")
    p.add_argument("--network-id", required=True)
    p.add_argument("--changeset-id", required=True, help="Change-set ID, e.g. CHG-7")
    p.add_argument("--note", required=True, help="Commit message / version label")
    p.add_argument("--dry-run", action="store_true", help="Print request params without calling API")
    args = p.parse_args()

    if args.dry_run:
        emit_success(
            {
                "method": "POST",
                "path": f"/api/networks/{args.network_id}/change-sets/{args.changeset_id}",
                "query": {"action": "commit", "note": args.note},
            },
            meta={"dry_run": True},
        )

    try:
        client = ForwardClient.from_env()
        result = client.post(
            f"/api/networks/{args.network_id}/change-sets/{args.changeset_id}",
            {},
            query={"action": "commit", "note": args.note},
        )
    except ForwardError as e:
        emit_error(ERR_API, str(e))

    emit_success(
        result,
        meta={
            "network_id": args.network_id,
            "changeset_id": args.changeset_id,
            "note": args.note,
        },
    )
    return 0


if __name__ == "__main__":
    sys.exit(main())
