#!/usr/bin/env python3
"""Delete (deactivate) a check."""
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
    parser.add_argument("--check-id", required=True, help="Check ID to delete")
    parser.add_argument("--snapshot-id", help="Snapshot ID (default: latest processed)")
    args = parser.parse_args()

    client = ForwardClient.from_env()

    # Resolve snapshot ID
    if not args.snapshot_id:
        networks = client.get("/api/networks")
        net = next((n for n in networks if n["id"] == args.network_id), None)
        if not net:
            emit_error(ERR_NOT_FOUND, f"Network {args.network_id} not found",
                       hint="list networks with forward-inventory")
        args.snapshot_id = str(net.get("latestProcessedSnapshotId", ""))
        if not args.snapshot_id:
            emit_error(ERR_NOT_FOUND, f"Network {args.network_id} has no processed snapshots")

    path = f"/api/snapshots/{args.snapshot_id}/checks/{args.check_id}"

    try:
        client.delete(path)
    except ForwardError as e:
        emit_error(ERR_API, f"Failed to delete check: {e}")

    emit_success(
        {"deleted": True, "checkId": args.check_id},
        meta={"network_id": args.network_id, "snapshot_id": args.snapshot_id},
    )


if __name__ == "__main__":
    main()
