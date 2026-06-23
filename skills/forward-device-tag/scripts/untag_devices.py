#!/usr/bin/env python3
"""Remove a tag from devices (bulk operation)."""
import argparse
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import _bootstrap  # noqa: F401 — side-effect: puts forward_client on sys.path

from forward_client import ForwardClient, ForwardError, emit_json, die


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--network-id", required=True, help="Network ID")
    parser.add_argument("--tag-name", help="Tag to remove")
    parser.add_argument(
        "--devices",
        nargs="+",
        help="Device names (space-separated)",
    )
    parser.add_argument(
        "--devices-file",
        help="File with device names (one per line)",
    )
    parser.add_argument(
        "--remove-all",
        action="store_true",
        help="Remove ALL tags from devices",
    )
    parser.add_argument("--snapshot-id", help="Snapshot to apply to")
    parser.add_argument(
        "--no-validate",
        action="store_true",
        help="Skip device name validation",
    )
    args = parser.parse_args()

    if not args.devices and not args.devices_file:
        die("Must specify --devices or --devices-file")

    if not args.tag_name and not args.remove_all:
        die("Must specify --tag-name or --remove-all")

    # Collect device names
    devices = []
    if args.devices:
        devices.extend(args.devices)
    if args.devices_file:
        try:
            with open(args.devices_file) as f:
                devices.extend([line.strip() for line in f if line.strip()])
        except OSError as e:
            die(f"Failed to read devices file: {e}")

    if not devices:
        die("No devices specified")

    client = ForwardClient.from_env()

    body = {"devices": devices}

    query = {}
    if args.snapshot_id:
        query["snapshotId"] = args.snapshot_id
    if args.no_validate:
        query["validateDevices"] = "false"

    if args.remove_all:
        path = f"/api/networks/{args.network_id}/device-tags?action=removeAllFrom"
    else:
        from urllib.parse import quote
        encoded_tag = quote(args.tag_name)
        path = f"/api/networks/{args.network_id}/device-tags/{encoded_tag}?action=removeFrom"

    try:
        client.post(path, body=body, query=query if query else None)
    except ForwardError as e:
        die(f"Failed to untag devices: {e}")

    emit_json({
        "untagged": True,
        "tagName": args.tag_name or "ALL",
        "deviceCount": len(devices),
        "devices": devices[:10],  # First 10 for display
        "snapshotId": args.snapshot_id,
    })


if __name__ == "__main__":
    main()
