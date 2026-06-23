#!/usr/bin/env python3
"""Create a new Forward change-set.

POST /api/networks/{networkId}/change-sets[?dirPath={dirPath}]

Body: ChangeSetBaseInfo — name + snapshotId.
The optional --dir-path places the new change-set inside a directory tree.
"""
import argparse
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import _bootstrap  # noqa: F401

from forward_client import ForwardClient, ForwardError, emit_json, die


def main() -> int:
    p = argparse.ArgumentParser(description="Create a Forward change-set")
    p.add_argument("--network-id", required=True)
    p.add_argument("--name", required=True, help="Human-readable name for the change-set")
    p.add_argument("--snapshot-id", required=True, help="Base snapshot ID, e.g. 691")
    p.add_argument(
        "--dir-path",
        default=None,
        help="Directory path to place the change-set in, e.g. /team/project (optional)",
    )
    p.add_argument("--dry-run", action="store_true", help="Print request body without calling API")
    args = p.parse_args()

    body = {"name": args.name, "snapshotId": args.snapshot_id}
    query: dict = {}
    if args.dir_path:
        query["dirPath"] = args.dir_path

    if args.dry_run:
        emit_json(
            {
                "method": "POST",
                "path": f"/api/networks/{args.network_id}/change-sets",
                "query": query,
                "body": body,
            }
        )
        return 0

    try:
        client = ForwardClient.from_env()
        result = client.post(
            f"/api/networks/{args.network_id}/change-sets",
            body,
            query=query or None,
        )
    except ForwardError as e:
        die(str(e))

    emit_json(result)
    return 0


if __name__ == "__main__":
    sys.exit(main())
