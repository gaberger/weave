#!/usr/bin/env python3
"""List all device tags for a network."""
import argparse
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import _bootstrap  # noqa: F401 — side-effect: puts forward_client on sys.path

from forward_client import ForwardClient, ForwardError, emit_json, die


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--network-id", required=True, help="Network ID")
    parser.add_argument(
        "--with-devices",
        action="store_true",
        help="Include device names for each tag",
    )
    parser.add_argument(
        "--snapshot-id",
        help="Show tags as of a specific snapshot",
    )
    args = parser.parse_args()

    client = ForwardClient.from_env()

    path = f"/api/networks/{args.network_id}/device-tags"
    if args.with_devices:
        path += "?with=devices"

    query = {}
    if args.snapshot_id:
        query["snapshotId"] = args.snapshot_id

    try:
        result = client.get(path, query=query if query else None)
    except ForwardError as e:
        die(f"Failed to list tags: {e}")

    emit_json(result)


if __name__ == "__main__":
    main()
