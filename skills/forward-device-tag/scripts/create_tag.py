#!/usr/bin/env python3
"""Create a new device tag."""
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
    parser.add_argument(
        "--color",
        help="RGB hex color (e.g., #ff0000) for diagram visualization",
    )
    args = parser.parse_args()

    client = ForwardClient.from_env()

    body = {"name": args.tag_name}
    if args.color:
        body["color"] = args.color

    path = f"/api/networks/{args.network_id}/device-tags"

    try:
        result = client.post(path, body=body)
    except ForwardError as e:
        emit_error(ERR_API, f"Failed to create tag: {e}")

    meta = {"network_id": args.network_id, "tag_name": args.tag_name}
    if args.color:
        meta["color"] = args.color
    emit_success(result, meta=meta)


if __name__ == "__main__":
    main()
