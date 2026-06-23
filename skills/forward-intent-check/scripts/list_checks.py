#!/usr/bin/env python3
"""List checks (verifications) for a Forward network snapshot.

Filters: type, priority, status. Default: all checks.
"""
import argparse
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import _bootstrap  # noqa: F401 — side-effect: puts forward_client on sys.path

from forward_client import ForwardClient, ForwardError, emit_json, die


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
        networks = client.get("/api/networks")
        net = next((n for n in networks if n["id"] == args.network_id), None)
        if not net:
            die(f"Network {args.network_id} not found")
        args.snapshot_id = str(net.get("latestProcessedSnapshotId", ""))
        if not args.snapshot_id:
            die(f"Network {args.network_id} has no processed snapshots")

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
        die(f"Failed to fetch checks: {e}")

    emit_json({"checks": checks, "snapshotId": args.snapshot_id, "networkId": args.network_id})


if __name__ == "__main__":
    main()
