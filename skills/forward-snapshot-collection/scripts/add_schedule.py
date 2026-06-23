#!/usr/bin/env python3
"""Add a collection schedule to a Forward network.

Usage:
    python3 add_schedule.py --network-id <id> --cron "0 2 * * *" [--label "Daily 2am"]

Cron format: minute hour day month weekday (UTC timezone)
Example: "0 2 * * *" = daily at 2:00 AM UTC

Returns:
    JSON of the created schedule with scheduleId, label, cron.
"""
from __future__ import annotations

import argparse
import sys

import _bootstrap  # noqa: F401 — prepends shared/ to sys.path
from forward_client import ForwardClient, emit_json, die, ForwardError


def main():
    parser = argparse.ArgumentParser(description="Add Forward collection schedule")
    parser.add_argument(
        "--network-id",
        required=True,
        help="Network ID to add schedule to"
    )
    parser.add_argument(
        "--cron",
        required=True,
        help='Cron expression (e.g., "0 2 * * *" for daily at 2am UTC)'
    )
    parser.add_argument(
        "--label",
        default="",
        help="Human-readable label for the schedule"
    )
    args = parser.parse_args()

    try:
        client = ForwardClient.from_env()

        # POST /networks/{networkId}/collection-schedules
        body = {
            "cron": args.cron,
        }
        if args.label:
            body["label"] = args.label

        result = client.post(
            f"/api/networks/{args.network_id}/collection-schedules",
            body=body
        )

        emit_json(result)
    except ForwardError as e:
        die(str(e))


if __name__ == "__main__":
    main()
