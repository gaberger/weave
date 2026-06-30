#!/usr/bin/env python3
"""List checks (verifications) for a Forward network snapshot.

Filters: type, priority, status. Default: all checks.
"""
import argparse
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import _bootstrap  # noqa: F401 — side-effect: puts forward_client on sys.path

from forward_client import ForwardClient, ForwardError
from skill_io import emit_error, emit_success, ERR_API, ERR_NOT_FOUND


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--network-id", required=True, help="Network ID")
    parser.add_argument("--snapshot-id", help="Snapshot ID (default: latest processed)")
    parser.add_argument(
        "--type",
        action="append",
        choices=["Existential", "Isolation", "Reachability", "NQE", "Predefined"],
        help="Filter by check type (can repeat)",
    )
    parser.add_argument(
        "--priority",
        action="append",
        choices=["LOW", "MEDIUM", "HIGH", "NOT_SET"],
        help="Filter by priority (can repeat)",
    )
    parser.add_argument(
        "--status",
        action="append",
        choices=["PASS", "FAIL", "ERROR", "TIMEOUT"],
        help="Filter by status (can repeat)",
    )
    args = parser.parse_args()

    client = ForwardClient.from_env()

    # Resolve snapshot ID
    if not args.snapshot_id:
        try:
            latest = client.get(f"/api/networks/{args.network_id}/snapshots/latestProcessed")
        except ForwardError as e:
            emit_error(ERR_NOT_FOUND, f"Network {args.network_id}: could not resolve latest processed snapshot: {e}",
                       hint="list networks with forward-inventory")
        args.snapshot_id = str(latest.get("id", "")) if isinstance(latest, dict) else ""
        if not args.snapshot_id:
            emit_error(ERR_NOT_FOUND, f"Network {args.network_id} has no processed snapshots")

    # Build query params
    query = {}
    if args.type:
        query["type"] = args.type
    if args.priority:
        query["priority"] = args.priority
    if args.status:
        query["status"] = args.status

    path = f"/api/snapshots/{args.snapshot_id}/checks"

    try:
        checks = client.get(path, query=query)
    except ForwardError as e:
        emit_error(ERR_API, f"Failed to fetch checks: {e}")

    # Normalize to a bare list — the API may return {"checks": [...]} or a list.
    items = checks.get("checks", []) if isinstance(checks, dict) else checks
    emit_success(items, meta={
        "count": len(items) if isinstance(items, list) else None,
        "network_id": args.network_id,
        "snapshot_id": args.snapshot_id,
        "type": args.type,
        "priority": args.priority,
        "status": args.status,
    })


if __name__ == "__main__":
    main()
