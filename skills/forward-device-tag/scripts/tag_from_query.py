#!/usr/bin/env python3
"""Bulk tag devices from NQE query results.

Runs an NQE query, extracts device names from a specified column, and tags
those devices. Useful for tagging based on query results (e.g., vulnerable
devices, policy violators, devices in a location).
"""
import argparse
import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import _bootstrap  # noqa: F401 — side-effect: puts forward_client on sys.path

from forward_client import ForwardClient, ForwardError, emit_json, die


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--network-id", required=True, help="Network ID")
    parser.add_argument("--query-id", required=True, help="NQE query ID (FQ_...)")
    parser.add_argument("--tag-name", required=True, help="Tag to apply")
    parser.add_argument(
        "--device-column",
        required=True,
        help="Column name containing device names",
    )
    parser.add_argument("--snapshot-id", help="Snapshot to query against")
    parser.add_argument("--params", help="JSON string of query parameters")
    parser.add_argument(
        "--create-tag",
        action="store_true",
        help="Create tag if it doesn't exist",
    )
    parser.add_argument("--color", help="Color for newly created tag")
    parser.add_argument(
        "--limit",
        type=int,
        default=1000,
        help="Max rows to process (default 1000)",
    )
    args = parser.parse_args()

    client = ForwardClient.from_env()

    # Resolve snapshot ID if not specified
    if not args.snapshot_id:
        networks = client.get("/api/networks")
        net = next((n for n in networks if n["id"] == args.network_id), None)
        if not net:
            die(f"Network {args.network_id} not found")
        args.snapshot_id = str(net.get("latestProcessedSnapshotId", ""))
        if not args.snapshot_id:
            die(f"Network {args.network_id} has no processed snapshots")

    # Build NQE request
    nqe_body = {
        "queryId": args.query_id,
        "snapshotId": args.snapshot_id,
        "options": {
            "limit": args.limit,
            "itemFormat": "JSON",
        },
    }
    if args.params:
        nqe_body["parameters"] = json.loads(args.params)

    # Run query
    try:
        result = client.post("/api/nqe", body=nqe_body)
    except ForwardError as e:
        die(f"Failed to run query: {e}")

    # Extract device names from specified column
    items = result.get("items", [])
    if not items:
        die(f"Query returned zero rows — no devices to tag")

    devices = []
    for item in items:
        if not isinstance(item, dict):
            continue
        device_name = item.get(args.device_column)
        if device_name and isinstance(device_name, str):
            devices.append(device_name)

    if not devices:
        die(f"No device names found in column '{args.device_column}'")

    # Remove duplicates
    devices = list(set(devices))

    # Create tag if requested
    if args.create_tag:
        tag_body = {"name": args.tag_name}
        if args.color:
            tag_body["color"] = args.color
        try:
            client.post(
                f"/api/networks/{args.network_id}/device-tags",
                body=tag_body,
            )
        except ForwardError:
            # Tag may already exist — continue
            pass

    # Tag devices
    from urllib.parse import quote
    encoded_tag = quote(args.tag_name)

    tag_body = {"devices": devices}
    tag_path = f"/api/networks/{args.network_id}/device-tags/{encoded_tag}?action=addTo"

    tag_query = {}
    if args.snapshot_id:
        tag_query["snapshotId"] = args.snapshot_id

    try:
        client.post(tag_path, body=tag_body, query=tag_query if tag_query else None)
    except ForwardError as e:
        die(f"Failed to tag devices: {e}")

    emit_json({
        "tagged": True,
        "queryId": args.query_id,
        "tagName": args.tag_name,
        "deviceColumn": args.device_column,
        "deviceCount": len(devices),
        "devices": devices[:10],  # First 10 for display
        "snapshotId": args.snapshot_id,
    })


if __name__ == "__main__":
    main()
