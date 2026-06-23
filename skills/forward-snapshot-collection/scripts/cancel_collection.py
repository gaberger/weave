#!/usr/bin/env python3
"""Cancel an in-progress network collection.

Usage:
    python3 cancel_collection.py --network-id <id>

Returns:
    JSON response (typically empty {} on success).
"""
from __future__ import annotations

import argparse
import sys

import _bootstrap  # noqa: F401 — prepends shared/ to sys.path
from forward_client import ForwardClient, emit_json, die, ForwardError


def main():
    parser = argparse.ArgumentParser(description="Cancel Forward network collection")
    parser.add_argument(
        "--network-id",
        required=True,
        help="Network ID whose collection to cancel"
    )
    args = parser.parse_args()

    try:
        client = ForwardClient.from_env()

        # POST /networks/{networkId}/cancelcollection
        result = client.post(f"/api/networks/{args.network_id}/cancelcollection", body={})

        emit_json(result or {"status": "cancelled"})
    except ForwardError as e:
        die(str(e))


if __name__ == "__main__":
    main()
