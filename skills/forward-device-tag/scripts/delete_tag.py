#!/usr/bin/env python3
"""Delete a device tag (removes from all devices in all snapshots)."""
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
    parser.add_argument("--tag-name", required=True, help="Tag to delete")
    args = parser.parse_args()

    client = ForwardClient.from_env()

    from urllib.parse import quote
    encoded_tag = quote(args.tag_name)

    path = f"/api/networks/{args.network_id}/device-tags/{encoded_tag}"

    try:
        client.delete(path)
    except ForwardError as e:
        emit_error(ERR_API, f"Failed to delete tag: {e}")

    emit_success(
        {"deleted": True, "tagName": args.tag_name},
        meta={"network_id": args.network_id, "tag_name": args.tag_name},
    )


if __name__ == "__main__":
    main()
