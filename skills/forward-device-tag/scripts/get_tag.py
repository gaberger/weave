#!/usr/bin/env python3
"""Get a specific device tag with its devices."""
import argparse
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import _bootstrap  # noqa: F401 — side-effect: puts forward_client on sys.path

from forward_client import ForwardClient, ForwardError
from skill_io import emit_success, emit_error, ERR_API


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--network-id", required=True, help="Network ID")
    parser.add_argument("--tag-name", required=True, help="Tag name")
    parser.add_argument("--snapshot-id", help="Show tag as of a specific snapshot")
    args = parser.parse_args()

    client = ForwardClient.from_env()

    # URL-encode tag name for path
    from urllib.parse import quote
    encoded_tag = quote(args.tag_name)

    path = f"/api/networks/{args.network_id}/device-tags/{encoded_tag}?with=devices"

    query = {}
    if args.snapshot_id:
        query["snapshotId"] = args.snapshot_id

    try:
        result = client.get(path, query=query if query else None)
    except ForwardError as e:
        emit_error(ERR_API, f"Failed to get tag: {e}")

    meta = {"network_id": args.network_id, "tag_name": args.tag_name}
    if args.snapshot_id:
        meta["snapshot_id"] = args.snapshot_id
    emit_success(result, meta=meta)


if __name__ == "__main__":
    main()
