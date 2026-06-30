#!/usr/bin/env python3
"""Get a specific check with diagnosis."""
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
    parser.add_argument("--check-id", required=True, help="Check ID")
    parser.add_argument("--snapshot-id", help="Snapshot ID (default: latest processed)")
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

    path = f"/api/snapshots/{args.snapshot_id}/checks/{args.check_id}"

    try:
        check = client.get(path)
    except ForwardError as e:
        emit_error(ERR_API, f"Failed to fetch check: {e}")

    emit_success(check, meta={
        "network_id": args.network_id,
        "snapshot_id": args.snapshot_id,
        "check_id": args.check_id,
    })


if __name__ == "__main__":
    main()
