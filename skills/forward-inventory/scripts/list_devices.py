#!/usr/bin/env python3
"""List devices in a Forward network snapshot."""
import argparse
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import _bootstrap  # noqa: F401 — side-effect: puts forward_client on sys.path

from forward_client import ForwardClient, ForwardError, emit_json, die


def main() -> int:
    p = argparse.ArgumentParser(description="List devices in a Forward network")
    p.add_argument("--network-id", required=True)
    p.add_argument("--snapshot-id", help="Snapshot ID (defaults to latest processed)")
    p.add_argument(
        "--limit",
        type=int,
        default=0,
        help="Cap the number of devices returned (0 = no cap)",
    )
    p.add_argument("--vendor", help="Filter by vendor name (case-insensitive, client-side)")
    args = p.parse_args()

    try:
        client = ForwardClient.from_env()
        query = {"snapshotId": args.snapshot_id} if args.snapshot_id else None
        data = client.get(f"/api/networks/{args.network_id}/devices", query=query)
    except ForwardError as e:
        die(str(e))

    devices = data.get("devices") if isinstance(data, dict) else data
    if not isinstance(devices, list):
        emit_json(data)
        return 0

    if args.vendor:
        needle = args.vendor.lower()
        devices = [
            d for d in devices
            if isinstance(d, dict) and str(d.get("vendor", "")).lower() == needle
        ]
    if args.limit:
        devices = devices[: args.limit]

    emit_json({"count": len(devices), "devices": devices})
    return 0


if __name__ == "__main__":
    sys.exit(main())
