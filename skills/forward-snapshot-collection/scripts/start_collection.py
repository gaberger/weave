#!/usr/bin/env python3
"""Trigger a new snapshot collection for a Forward network.

Uses the modern /collector-tasks API (not deprecated /startcollection).

Usage:
    python3 start_collection.py --network-id <id>

Returns:
    JSON with taskId, networkId, status, and timestamps.
"""
from __future__ import annotations

import argparse
import sys

import _bootstrap  # noqa: F401 — prepends shared/ to sys.path
from forward_client import ForwardClient, emit_json, die, ForwardError


def main():
    parser = argparse.ArgumentParser(description="Trigger a Forward network collection")
    parser.add_argument(
        "--network-id",
        required=True,
        help="Network ID to collect"
    )
    args = parser.parse_args()

    try:
        client = ForwardClient.from_env()

        # POST /collector-tasks?networkId=X&type=NETWORK_COLLECTION
        query = {
            "networkId": args.network_id,
            "type": "NETWORK_COLLECTION"
        }
        result = client.post("/api/collector-tasks", None, query=query)

        emit_json(result)
    except ForwardError as e:
        die(str(e))


if __name__ == "__main__":
    main()
