#!/usr/bin/env python3
"""Delete a collection schedule from a Forward network.

Usage:
    python3 delete_schedule.py --network-id <id> --schedule-id <id>

Returns:
    JSON response (typically empty {} on success).
"""
from __future__ import annotations

import argparse
import sys

import _bootstrap  # noqa: F401 — prepends shared/ to sys.path
from forward_client import ForwardClient, emit_json, die, ForwardError


def main():
    parser = argparse.ArgumentParser(description="Delete Forward collection schedule")
    parser.add_argument(
        "--network-id",
        required=True,
        help="Network ID"
    )
    parser.add_argument(
        "--schedule-id",
        required=True,
        help="Schedule ID to delete"
    )
    args = parser.parse_args()

    try:
        client = ForwardClient.from_env()

        # DELETE /networks/{networkId}/collection-schedules/{scheduleId}
        result = client.delete(
            f"/api/networks/{args.network_id}/collection-schedules/{args.schedule_id}"
        )

        emit_json(result or {"status": "deleted"})
    except ForwardError as e:
        die(str(e))


if __name__ == "__main__":
    main()
