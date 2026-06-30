#!/usr/bin/env python3
"""List collection schedules for a Forward network.

Usage:
    python3 list_schedules.py --network-id <id>

Returns:
    JSON array of collection schedules with scheduleId, label, cron, nextRun.
"""
from __future__ import annotations

import argparse

import _bootstrap  # noqa: F401 — prepends shared/ to sys.path
from forward_client import ForwardClient, ForwardError, AuthError, NotFoundError
from skill_io import emit_success, emit_error, ERR_API, ERR_AUTH, ERR_NOT_FOUND


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

        count = len(result) if isinstance(result, list) else None
        emit_success(result, meta={"network_id": args.network_id, "count": count})
    except AuthError as e:
        emit_error(ERR_AUTH, str(e), hint="check FORWARD_API_KEY / FORWARD_API_SECRET")
    except NotFoundError as e:
        emit_error(ERR_NOT_FOUND, str(e), hint="list networks with forward-inventory")
    except ForwardError as e:
        emit_error(ERR_API, str(e))


if __name__ == "__main__":
    main()
