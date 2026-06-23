#!/usr/bin/env python3
"""List collection schedules for a Forward network.

Usage:
    python3 list_schedules.py --network-id <id>

Returns:
    JSON array of collection schedules with scheduleId, label, cron, nextRun.
"""
from __future__ import annotations

import argparse
import sys

import _bootstrap  # noqa: F401 — prepends shared/ to sys.path
from forward_client import ForwardClient, emit_json, die, ForwardError


def main():
    parser = argparse.ArgumentParser(description="List Forward collection schedules")
    parser.add_argument(
        "--network-id",
        required=True,
        help="Network ID to list schedules for"
    )
    args = parser.parse_args()

    try:
        client = ForwardClient.from_env()

        # GET /networks/{networkId}/collection-schedules
        result = client.get(f"/api/networks/{args.network_id}/collection-schedules")

        emit_json(result)
    except ForwardError as e:
        die(str(e))


if __name__ == "__main__":
    main()
