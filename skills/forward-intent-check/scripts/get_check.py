#!/usr/bin/env python3
"""Get a specific check with diagnosis."""
import argparse
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import _bootstrap  # noqa: F401 — side-effect: puts forward_client on sys.path

from forward_client import ForwardClient, ForwardError, emit_json, die


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--network-id", required=True, help="Network ID")
    parser.add_argument("--check-id", required=True, help="Check ID")
    parser.add_argument("--snapshot-id", help="Snapshot ID (default: latest processed)")
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

    path = f"/api/snapshots/{args.snapshot_id}/checks/{args.check_id}"

    try:
        check = client.get(path)
    except ForwardError as e:
        die(f"Failed to fetch check: {e}")

    emit_json(check)


if __name__ == "__main__":
    main()
