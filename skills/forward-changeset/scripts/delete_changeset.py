#!/usr/bin/env python3
"""Delete a Forward change-set.

DELETE /api/networks/{networkId}/change-sets/{id}

Destructive — requires --yes to execute.
Use --dry-run to see what would be deleted without calling the API.
"""
import argparse
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import _bootstrap  # noqa: F401

from forward_client import ForwardClient, ForwardError
from skill_io import emit_success, emit_error, ERR_API, ERR_INPUT


def main() -> int:
    p = argparse.ArgumentParser(description="Delete a Forward change-set")
    p.add_argument("--network-id", required=True)
    p.add_argument("--changeset-id", required=True, help="Change-set ID, e.g. CHG-7")
    p.add_argument("--yes", action="store_true", help="Required to execute (destructive)")
    p.add_argument("--dry-run", action="store_true", help="Show what would be deleted without calling API")
    args = p.parse_args()

    if args.dry_run:
        emit_success(
            {
                "method": "DELETE",
                "path": f"/api/networks/{args.network_id}/change-sets/{args.changeset_id}",
            },
            meta={"dry_run": True},
        )

    if not args.yes:
        emit_error(
            ERR_INPUT,
            f"deletion of {args.changeset_id} is destructive; pass --yes to confirm",
            hint="re-run with --yes",
        )

    try:
        client = ForwardClient.from_env()
        client.delete(f"/api/networks/{args.network_id}/change-sets/{args.changeset_id}")
    except ForwardError as e:
        emit_error(ERR_API, str(e))

    emit_success(
        {"deleted": True, "changeset_id": args.changeset_id},
        meta={"network_id": args.network_id},
    )
    return 0


if __name__ == "__main__":
    sys.exit(main())
