#!/usr/bin/env python3
"""Update a device tag (rename or change color)."""
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
    parser.add_argument("--tag-name", required=True, help="Current tag name")
    parser.add_argument("--new-name", help="New tag name (to rename)")
    parser.add_argument("--color", help="New RGB hex color")
    args = parser.parse_args()

    if not args.new_name and not args.color:
        emit_error(ERR_INPUT, "Must specify --new-name and/or --color")

    client = ForwardClient.from_env()

    from urllib.parse import quote
    encoded_tag = quote(args.tag_name)

    body = {}
    if args.new_name:
        body["name"] = args.new_name
    if args.color:
        body["color"] = args.color

    path = f"/api/networks/{args.network_id}/device-tags/{encoded_tag}"

    try:
        result = client.patch(path, body=body)
    except ForwardError as e:
        emit_error(ERR_API, f"Failed to update tag: {e}")

    meta = {"network_id": args.network_id, "tag_name": args.tag_name}
    if args.new_name:
        meta["new_name"] = args.new_name
    if args.color:
        meta["color"] = args.color
    emit_success(result, meta=meta)


if __name__ == "__main__":
    main()
