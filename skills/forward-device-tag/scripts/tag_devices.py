#!/usr/bin/env python3
"""Add a tag to devices (bulk operation)."""
import argparse
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import _bootstrap  # noqa: F401 — side-effect: puts forward_client on sys.path

from forward_client import ForwardClient, ForwardError
from skill_io import emit_success, emit_error, ERR_API, ERR_INPUT


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--network-id", required=True, help="Network ID")
    parser.add_argument("--tag-name", required=True, help="Tag to apply")
    parser.add_argument(
        "--devices",
        nargs="+",
        help="Device names (space-separated)",
    )
    parser.add_argument(
        "--devices-file",
        help="File with device names (one per line)",
    )
    parser.add_argument("--snapshot-id", help="Snapshot to apply to")
    parser.add_argument(
        "--no-validate",
        action="store_true",
        help="Skip device name validation",
    )
    args = parser.parse_args()

    if not args.devices and not args.devices_file:
        emit_error(ERR_INPUT, "Must specify --devices or --devices-file")

    # Collect device names
    devices = []
    if args.devices:
        devices.extend(args.devices)
    if args.devices_file:
        try:
            with open(args.devices_file) as f:
                devices.extend([line.strip() for line in f if line.strip()])
        except OSError as e:
            emit_error(ERR_INPUT, f"Failed to read devices file: {e}")

    if not devices:
        emit_error(ERR_INPUT, "No devices specified")

    client = ForwardClient.from_env()

    from urllib.parse import quote
    encoded_tag = quote(args.tag_name)

    body = {"devices": devices}

    path = f"/api/networks/{args.network_id}/device-tags/{encoded_tag}?action=addTo"

    query = {}
    if args.snapshot_id:
        query["snapshotId"] = args.snapshot_id
    if args.no_validate:
        query["validateDevices"] = "false"

    try:
        client.post(path, body=body, query=query if query else None)
    except ForwardError as e:
        emit_error(ERR_API, f"Failed to tag devices: {e}")

    emit_success(
        {
            "tagged": True,
            "tagName": args.tag_name,
            "devices": devices[:10],  # First 10 for display
        },
        meta={
            "network_id": args.network_id,
            "tag_name": args.tag_name,
            "device_count": len(devices),
            "snapshot_id": args.snapshot_id,
        },
    )


if __name__ == "__main__":
    main()
