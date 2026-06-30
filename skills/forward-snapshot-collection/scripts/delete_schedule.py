#!/usr/bin/env python3
"""Delete a collection schedule from a Forward network.

Usage:
    python3 delete_schedule.py --network-id <id> --schedule-id <id>

Returns:
    JSON response (typically empty {} on success).
"""
from __future__ import annotations

import argparse

import _bootstrap  # noqa: F401 — prepends shared/ to sys.path
from forward_client import ForwardClient, ForwardError, AuthError, NotFoundError
from skill_io import emit_success, emit_error, ERR_API, ERR_AUTH, ERR_NOT_FOUND


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

        emit_success(
            result or {"status": "deleted"},
            meta={"network_id": args.network_id, "schedule_id": args.schedule_id},
        )
    except AuthError as e:
        emit_error(ERR_AUTH, str(e), hint="check FORWARD_API_KEY / FORWARD_API_SECRET")
    except NotFoundError as e:
        emit_error(ERR_NOT_FOUND, str(e),
                   hint="list schedules with list_schedules.py")
    except ForwardError as e:
        emit_error(ERR_API, str(e))


if __name__ == "__main__":
    main()
